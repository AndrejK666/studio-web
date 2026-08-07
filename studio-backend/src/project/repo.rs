//! Storage for projects.
//!
//! Every query goes through the toolkit's secure layer with a tenant scope, so
//! a workspace can only ever see its own projects even if a handler forgets to
//! filter — the clamp is in the WHERE clause, not in our arithmetic.

use std::sync::Arc;

use sea_orm::sea_query::Expr;
use sea_orm::{ActiveValue, ColumnTrait, Condition, EntityTrait, QueryFilter};
use time::OffsetDateTime;
use toolkit_db::DBProvider;
use toolkit_db::secure::{ScopeError, SecureDeleteExt, SecureEntityExt, SecureInsertExt, SecureUpdateExt};
use toolkit_security::AccessScope;
use uuid::Uuid;

use super::entity;
use super::model::{Mode, NewProject, Project, ProjectSource, Status};

/// Storage failures the service layer has to tell apart.
#[derive(Debug)]
pub enum RepoError {
    /// Anything the caller cannot fix: connection, constraint we did not
    /// anticipate, malformed stored row.
    Db(String),
    /// The `(tenant_id, name)` unique index rejected the write.
    DuplicateName,
}

impl core::fmt::Display for RepoError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Db(m) => write!(f, "{m}"),
            Self::DuplicateName => write!(f, "a project with this name already exists here"),
        }
    }
}

impl std::error::Error for RepoError {}

impl From<toolkit_db::DbError> for RepoError {
    fn from(e: toolkit_db::DbError) -> Self {
        Self::Db(e.to_string())
    }
}

impl From<ScopeError> for RepoError {
    fn from(e: ScopeError) -> Self {
        if e.is_unique_violation() {
            Self::DuplicateName
        } else {
            Self::Db(e.to_string())
        }
    }
}

pub struct ProjectRepo {
    db: Arc<DBProvider<RepoError>>,
}

/// Rows are keyed by tenant everywhere; the scope is built from the same
/// tenant the handler resolved, never from the row.
fn scope(tenant_id: Uuid) -> AccessScope {
    AccessScope::for_tenant(tenant_id)
}

impl ProjectRepo {
    #[must_use]
    pub fn new(db: Arc<DBProvider<RepoError>>) -> Self {
        Self { db }
    }

    /// Insert a validated project as a draft.
    ///
    /// # Errors
    /// [`RepoError::DuplicateName`] when the workspace already has that name.
    pub async fn insert(&self, new: &NewProject) -> Result<Project, RepoError> {
        let conn = self.db.conn()?;
        let now = OffsetDateTime::now_utc();

        let (brief, git_url, file_id) = match &new.source {
            ProjectSource::Idea { brief } => (brief.clone(), None, None),
            ProjectSource::Git { url } => (None, Some(url.clone()), None),
            ProjectSource::Upload { file_id } => (None, None, Some(*file_id)),
        };

        let am = entity::ActiveModel {
            id: ActiveValue::Set(new.id),
            tenant_id: ActiveValue::Set(new.tenant_id),
            name: ActiveValue::Set(new.name.clone()),
            mode: ActiveValue::Set(new.mode().as_smallint()),
            status: ActiveValue::Set(Status::Draft.as_smallint()),
            stages: ActiveValue::Set(encode_stages(&new.stages)),
            brief: ActiveValue::Set(brief),
            source_kind: ActiveValue::Set(new.source.kind_smallint()),
            source_git_url: ActiveValue::Set(git_url),
            source_file_id: ActiveValue::Set(file_id),
            rg_group_id: ActiveValue::Set(None),
            created_by: ActiveValue::Set(new.created_by),
            created_at: ActiveValue::Set(now),
            updated_at: ActiveValue::Set(now),
        };

        // scope_unchecked: there is no existing row to clamp against, and
        // `tenant_id` is set from the tenant the handler already resolved.
        entity::Entity::insert(am)
            .secure()
            .scope_unchecked(&scope(new.tenant_id))?
            .exec(&conn)
            .await?;

        self.find(new.tenant_id, new.id)
            .await?
            .ok_or_else(|| RepoError::Db("project vanished immediately after insert".to_owned()))
    }

    /// One project, or `None` when it does not exist in this tenant.
    ///
    /// # Errors
    /// Propagates storage failures.
    pub async fn find(&self, tenant_id: Uuid, id: Uuid) -> Result<Option<Project>, RepoError> {
        let conn = self.db.conn()?;
        let row = entity::Entity::find()
            .secure()
            .scope_with(&scope(tenant_id))
            .filter(Condition::all().add(entity::Column::Id.eq(id)))
            .one(&conn)
            .await?;
        row.map(to_domain).transpose()
    }

    /// Every project in the tenant, newest first.
    ///
    /// # Errors
    /// Propagates storage failures.
    pub async fn list(&self, tenant_id: Uuid) -> Result<Vec<Project>, RepoError> {
        let conn = self.db.conn()?;
        let rows = entity::Entity::find()
            .secure()
            .scope_with(&scope(tenant_id))
            .order_by(entity::Column::CreatedAt, sea_orm::Order::Desc)
            .all(&conn)
            .await?;
        rows.into_iter().map(to_domain).collect()
    }

    /// Apply the mutable parts of a project. `None` leaves a field alone.
    ///
    /// # Errors
    /// [`RepoError::DuplicateName`] on a colliding rename.
    pub async fn update(
        &self,
        tenant_id: Uuid,
        id: Uuid,
        name: Option<&str>,
        stages: Option<&[String]>,
        status: Option<Status>,
    ) -> Result<Option<Project>, RepoError> {
        if name.is_none() && stages.is_none() && status.is_none() {
            return self.find(tenant_id, id).await;
        }
        let conn = self.db.conn()?;
        let mut update = entity::Entity::update_many()
            .col_expr(entity::Column::UpdatedAt, Expr::value(OffsetDateTime::now_utc()));
        if let Some(name) = name {
            update = update.col_expr(entity::Column::Name, Expr::value(name));
        }
        if let Some(stages) = stages {
            update = update.col_expr(entity::Column::Stages, Expr::value(encode_stages(stages)));
        }
        if let Some(status) = status {
            update = update.col_expr(entity::Column::Status, Expr::value(status.as_smallint()));
        }
        let affected = update
            .filter(Condition::all().add(entity::Column::Id.eq(id)))
            .secure()
            .scope_with(&scope(tenant_id))
            .exec(&conn)
            .await?
            .rows_affected;
        if affected == 0 {
            return Ok(None);
        }
        self.find(tenant_id, id).await
    }

    /// Record the members group once RG has produced one.
    ///
    /// # Errors
    /// Propagates storage failures.
    pub async fn set_rg_group(
        &self,
        tenant_id: Uuid,
        id: Uuid,
        group_id: Uuid,
    ) -> Result<(), RepoError> {
        let conn = self.db.conn()?;
        entity::Entity::update_many()
            .col_expr(entity::Column::RgGroupId, Expr::value(group_id))
            .col_expr(entity::Column::UpdatedAt, Expr::value(OffsetDateTime::now_utc()))
            .filter(Condition::all().add(entity::Column::Id.eq(id)))
            .secure()
            .scope_with(&scope(tenant_id))
            .exec(&conn)
            .await?;
        Ok(())
    }

    /// Remove a project. `false` when there was nothing to remove.
    ///
    /// # Errors
    /// Propagates storage failures.
    pub async fn delete(&self, tenant_id: Uuid, id: Uuid) -> Result<bool, RepoError> {
        let conn = self.db.conn()?;
        let affected = entity::Entity::delete_many()
            .filter(Condition::all().add(entity::Column::Id.eq(id)))
            .secure()
            .scope_with(&scope(tenant_id))
            .exec(&conn)
            .await?
            .rows_affected;
        Ok(affected > 0)
    }
}

fn encode_stages(stages: &[String]) -> String {
    // Infallible for a Vec<String>; the fallback keeps the signature simple
    // rather than pushing a serialisation error into every call site.
    serde_json::to_string(stages).unwrap_or_else(|_| "[]".to_owned())
}

fn to_domain(m: entity::Model) -> Result<Project, RepoError> {
    let mode = Mode::from_smallint(m.mode)
        .ok_or_else(|| RepoError::Db(format!("studio_projects.mode out of domain: {}", m.mode)))?;
    let status = Status::from_smallint(m.status).ok_or_else(|| {
        RepoError::Db(format!("studio_projects.status out of domain: {}", m.status))
    })?;

    // Reconstruct the sum type from the flattened columns. The CHECK constraint
    // in the migration guarantees one of these arms matches; a row that reaches
    // the `else` was written around the schema, so say so plainly instead of
    // silently degrading to "greenfield".
    let source = match (mode, m.source_kind, m.source_git_url, m.source_file_id) {
        (Mode::Greenfield, None, None, None) => ProjectSource::Idea { brief: m.brief },
        (Mode::Modernize, Some(1), Some(url), None) => ProjectSource::Git { url },
        (Mode::Modernize, Some(2), None, Some(file_id)) => ProjectSource::Upload { file_id },
        (mode, kind, url, file) => {
            return Err(RepoError::Db(format!(
                "studio_projects row {} has an impossible source shape \
                 (mode={:?}, kind={kind:?}, git={}, file={})",
                m.id,
                mode,
                url.is_some(),
                file.is_some()
            )));
        }
    };

    let stages: Vec<String> = serde_json::from_str(&m.stages)
        .map_err(|e| RepoError::Db(format!("studio_projects.stages is not a JSON array: {e}")))?;

    Ok(Project {
        id: m.id,
        tenant_id: m.tenant_id,
        name: m.name,
        status,
        source,
        stages,
        rg_group_id: m.rg_group_id,
        created_by: m.created_by,
        created_at: m.created_at,
        updated_at: m.updated_at,
    })
}

#[cfg(test)]
#[path = "repo_tests.rs"]
mod repo_tests;
