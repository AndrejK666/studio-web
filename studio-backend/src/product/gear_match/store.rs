//! A project's gear matches, kept with the project in the gear's database:
//! each match (what was sent, the matcher's run, the catalogue it read, the
//! report), and the project's notes on them -- a member's decision on a
//! proposed gear, an answer to a question -- which outlive any one match.
//!
//! Keyed by the organization the project hangs under, as the product's
//! descriptions are (`descriptions.rs`): the run that fills a match acts as
//! studio-tasks in that tenant, and every member reaches the same rows.
//! PostgreSQL only (studio-backend/AGENTS.md).

use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, Condition, EntityTrait, Order};
use toolkit_db::Db;
use toolkit_db::secure::{SecureDeleteExt, SecureEntityExt, SecureInsertExt, SecureUpdateExt};
use toolkit_security::AccessScope;
use uuid::Uuid;

/// A match's states. The first three are not final.
pub const QUEUED: &str = "queued";
pub const RUNNING: &str = "running";
pub const CANCELLING: &str = "cancelling";
pub const SUCCEEDED: &str = "succeeded";
/// The report is written, but some requirements were not assessed.
pub const PARTIAL: &str = "partial";
pub const FAILED: &str = "failed";
pub const CANCELLED: &str = "cancelled";

pub fn is_final(state: &str) -> bool {
    matches!(state, SUCCEEDED | PARTIAL | FAILED | CANCELLED)
}

/// A note's kinds.
pub const NOTE_DECISION: &str = "decision";
pub const NOTE_ANSWER: &str = "answer";

pub mod matches {
    use sea_orm::entity::prelude::*;
    use toolkit_db::secure::Scopable;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
    #[sea_orm(table_name = "studio_product_gear_matches")]
    #[secure(tenant_col = "tenant_id", no_owner, no_type, no_resource)]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub tenant_id: Uuid,
        #[sea_orm(primary_key, auto_increment = false)]
        pub project_id: Uuid,
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        /// The studio-tasks run that fills it.
        pub run_id: Option<Uuid>,
        pub state: String,
        /// The person's subject id.
        pub requested_by: String,
        pub created_at_ms: i64,
        pub updated_at_ms: i64,
        pub finished_at_ms: Option<i64>,
        /// The key the matcher's submit carries; the caller's when given.
        pub idempotency_key: String,
        /// The product id the matcher was given.
        pub product: String,
        /// `Vec<report::SentDocument>` as JSON.
        #[sea_orm(column_type = "Text")]
        pub documents: String,
        /// The body sent to `POST /v1/runs`, documents' text included.
        #[sea_orm(column_type = "Text")]
        pub request: String,
        pub matcher_run_id: Option<String>,
        /// What `GET /v1/info` said when the run started (versions, catalogue).
        #[sea_orm(column_type = "Text", nullable)]
        pub info: Option<String>,
        /// `{requirements_done, requirements_total}` while it runs.
        #[sea_orm(column_type = "Text", nullable)]
        pub progress: Option<String>,
        /// The coverage report, as the matcher wrote it.
        #[sea_orm(column_type = "Text", nullable)]
        pub report: Option<String>,
        /// `report::Totals` as JSON.
        #[sea_orm(column_type = "Text", nullable)]
        pub totals: Option<String>,
        /// The matcher's `usage` (calls, cache hits, tokens).
        #[sea_orm(column_type = "Text", nullable)]
        pub usage: Option<String>,
        #[sea_orm(column_type = "Text", nullable)]
        pub error: Option<String>,
        /// Asked to stop through this gear's cancel.
        pub cancel_requested: bool,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {}

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            unreachable!("studio_product_gear_matches has no relations")
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod notes {
    use sea_orm::entity::prelude::*;
    use toolkit_db::secure::Scopable;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
    #[sea_orm(table_name = "studio_product_gear_match_notes")]
    #[secure(tenant_col = "tenant_id", no_owner, no_type, no_resource)]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub tenant_id: Uuid,
        #[sea_orm(primary_key, auto_increment = false)]
        pub project_id: Uuid,
        /// `decision` or `answer`.
        #[sea_orm(primary_key, auto_increment = false)]
        pub kind: String,
        /// A requirement's id, or a question's.
        #[sea_orm(primary_key, auto_increment = false)]
        pub subject: String,
        /// The gear a decision is about; empty for an answer.
        #[sea_orm(primary_key, auto_increment = false)]
        pub gear_id: String,
        /// `accepted` / `rejected`, or the answer's text.
        #[sea_orm(column_type = "Text")]
        pub value: String,
        pub author: String,
        pub updated_at_ms: i64,
        /// The match it was given on.
        pub match_id: Option<Uuid>,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {}

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            unreachable!("studio_product_gear_match_notes has no relations")
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub type Match = matches::Model;
pub type Note = notes::Model;

pub fn now_ms() -> i64 {
    i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
    )
    .unwrap_or(i64::MAX)
}

/// One change to a match's row; `None` leaves a column alone.
#[derive(Debug, Default)]
pub struct Change {
    pub state: Option<&'static str>,
    pub run_id: Option<Uuid>,
    pub matcher_run_id: Option<String>,
    pub info: Option<String>,
    pub progress: Option<String>,
    pub report: Option<String>,
    pub totals: Option<String>,
    pub usage: Option<String>,
    pub error: Option<String>,
    pub cancel_requested: Option<bool>,
    pub finished: bool,
}

pub struct MatchStore {
    pub(super) db: Db,
}

impl MatchStore {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    pub async fn insert(&self, row: Match) -> anyhow::Result<()> {
        use sea_orm::ActiveValue::Set;
        let tenant = row.tenant_id;
        let active = matches::ActiveModel {
            tenant_id: Set(row.tenant_id),
            project_id: Set(row.project_id),
            id: Set(row.id),
            run_id: Set(row.run_id),
            state: Set(row.state),
            requested_by: Set(row.requested_by),
            created_at_ms: Set(row.created_at_ms),
            updated_at_ms: Set(row.updated_at_ms),
            finished_at_ms: Set(row.finished_at_ms),
            idempotency_key: Set(row.idempotency_key),
            product: Set(row.product),
            documents: Set(row.documents),
            request: Set(row.request),
            matcher_run_id: Set(row.matcher_run_id),
            info: Set(row.info),
            progress: Set(row.progress),
            report: Set(row.report),
            totals: Set(row.totals),
            usage: Set(row.usage),
            error: Set(row.error),
            cancel_requested: Set(row.cancel_requested),
        };
        let conn = self.db.conn()?;
        matches::Entity::insert(active)
            .secure()
            // A new row: the tenant is the project's organization, resolved
            // by the caller as it reads the tree.
            .scope_unchecked(&AccessScope::for_tenant(tenant))?
            .exec(&conn)
            .await?;
        Ok(())
    }

    pub async fn get(
        &self,
        tenant: Uuid,
        project: Uuid,
        id: Uuid,
    ) -> anyhow::Result<Option<Match>> {
        let conn = self.db.conn()?;
        Ok(matches::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .filter(
                Condition::all()
                    .add(matches::Column::ProjectId.eq(project))
                    .add(matches::Column::Id.eq(id)),
            )
            .one(&conn)
            .await?)
    }

    /// The project's matches, newest first, at most `limit`.
    pub async fn list(
        &self,
        tenant: Uuid,
        project: Uuid,
        limit: u64,
    ) -> anyhow::Result<Vec<Match>> {
        let conn = self.db.conn()?;
        Ok(matches::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .filter(Condition::all().add(matches::Column::ProjectId.eq(project)))
            .order_by(matches::Column::CreatedAtMs, Order::Desc)
            .limit(limit)
            .all(&conn)
            .await?)
    }

    /// Every project's latest finished matches in the tenant asked for by
    /// `requested_by`, newest first: the Inbox reads their open questions.
    pub async fn finished_by(
        &self,
        tenant: Uuid,
        requested_by: &str,
        limit: u64,
    ) -> anyhow::Result<Vec<Match>> {
        let conn = self.db.conn()?;
        Ok(matches::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .filter(
                Condition::all()
                    .add(matches::Column::RequestedBy.eq(requested_by))
                    .add(matches::Column::State.is_in([SUCCEEDED, PARTIAL])),
            )
            .order_by(matches::Column::CreatedAtMs, Order::Desc)
            .limit(limit)
            .all(&conn)
            .await?)
    }

    pub async fn update(
        &self,
        tenant: Uuid,
        project: Uuid,
        id: Uuid,
        change: Change,
    ) -> anyhow::Result<()> {
        let conn = self.db.conn()?;
        let now = now_ms();
        let mut update = matches::Entity::update_many()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .filter(
                Condition::all()
                    .add(matches::Column::ProjectId.eq(project))
                    .add(matches::Column::Id.eq(id)),
            )
            .col_expr(matches::Column::UpdatedAtMs, Expr::value(now));
        if let Some(v) = change.state {
            update = update.col_expr(matches::Column::State, Expr::value(v));
        }
        if let Some(v) = change.run_id {
            update = update.col_expr(matches::Column::RunId, Expr::value(v));
        }
        if let Some(v) = change.matcher_run_id {
            update = update.col_expr(matches::Column::MatcherRunId, Expr::value(v));
        }
        if let Some(v) = change.info {
            update = update.col_expr(matches::Column::Info, Expr::value(v));
        }
        if let Some(v) = change.progress {
            update = update.col_expr(matches::Column::Progress, Expr::value(v));
        }
        if let Some(v) = change.report {
            update = update.col_expr(matches::Column::Report, Expr::value(v));
        }
        if let Some(v) = change.totals {
            update = update.col_expr(matches::Column::Totals, Expr::value(v));
        }
        if let Some(v) = change.usage {
            update = update.col_expr(matches::Column::Usage, Expr::value(v));
        }
        if let Some(v) = change.error {
            update = update.col_expr(matches::Column::Error, Expr::value(v));
        }
        if let Some(v) = change.cancel_requested {
            update = update.col_expr(matches::Column::CancelRequested, Expr::value(v));
        }
        if change.finished {
            update = update.col_expr(matches::Column::FinishedAtMs, Expr::value(now));
        }
        update.exec(&conn).await?;
        Ok(())
    }

    /// The project's notes of one kind.
    pub async fn notes(
        &self,
        tenant: Uuid,
        project: Uuid,
        kind: &str,
    ) -> anyhow::Result<Vec<Note>> {
        let conn = self.db.conn()?;
        Ok(notes::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .filter(
                Condition::all()
                    .add(notes::Column::ProjectId.eq(project))
                    .add(notes::Column::Kind.eq(kind)),
            )
            .order_by(notes::Column::UpdatedAtMs, Order::Desc)
            .all(&conn)
            .await?)
    }

    /// Keep a note, replacing the one about the same thing.
    pub async fn put_note(&self, note: Note) -> anyhow::Result<()> {
        use sea_orm::ActiveValue::Set;
        let conn = self.db.conn()?;
        let tenant = note.tenant_id;
        let key = Condition::all()
            .add(notes::Column::ProjectId.eq(note.project_id))
            .add(notes::Column::Kind.eq(note.kind.clone()))
            .add(notes::Column::Subject.eq(note.subject.clone()))
            .add(notes::Column::GearId.eq(note.gear_id.clone()));
        let updated = notes::Entity::update_many()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .filter(key)
            .col_expr(notes::Column::Value, Expr::value(note.value.clone()))
            .col_expr(notes::Column::Author, Expr::value(note.author.clone()))
            .col_expr(notes::Column::UpdatedAtMs, Expr::value(note.updated_at_ms))
            .col_expr(notes::Column::MatchId, Expr::value(note.match_id))
            .exec(&conn)
            .await?;
        if updated.rows_affected > 0 {
            return Ok(());
        }
        let active = notes::ActiveModel {
            tenant_id: Set(note.tenant_id),
            project_id: Set(note.project_id),
            kind: Set(note.kind),
            subject: Set(note.subject),
            gear_id: Set(note.gear_id),
            value: Set(note.value),
            author: Set(note.author),
            updated_at_ms: Set(note.updated_at_ms),
            match_id: Set(note.match_id),
        };
        notes::Entity::insert(active)
            .secure()
            .scope_unchecked(&AccessScope::for_tenant(tenant))?
            .exec(&conn)
            .await?;
        Ok(())
    }

    /// Forget a note; whether there was one.
    pub async fn delete_note(
        &self,
        tenant: Uuid,
        project: Uuid,
        kind: &str,
        subject: &str,
        gear_id: &str,
    ) -> anyhow::Result<bool> {
        let conn = self.db.conn()?;
        let done = notes::Entity::delete_many()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .filter(
                Condition::all()
                    .add(notes::Column::ProjectId.eq(project))
                    .add(notes::Column::Kind.eq(kind))
                    .add(notes::Column::Subject.eq(subject))
                    .add(notes::Column::GearId.eq(gear_id)),
            )
            .exec(&conn)
            .await?;
        Ok(done.rows_affected > 0)
    }
}
