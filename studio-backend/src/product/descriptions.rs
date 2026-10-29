//! A product's description, kept by Studio by revision (ADR-0053 §1).
//!
//! The text is the project's `product.gdl`, exactly what the engine reads.
//! Each save is a new revision -- its number, the text, who saved it, when,
//! and the text's SHA-256 -- in `studio_product_descriptions`, keyed by the
//! tenant the request acts in and the project. The tenant is the same scope
//! the project's product record lives in (the catalogue graph is read in the
//! request's tenant), so a caller who cannot read the record cannot read its
//! description either.
//!
//! A save is made against the revision the editor started from. When that is
//! no longer the latest, nothing is written and the caller gets the latest
//! back ([`Saved::Stale`]): the REST layer answers 409 with both texts. Two
//! saves racing for the same number collide on the primary key; the loser is
//! told the same way.
//!
//! PostgreSQL only, like every gear table here (studio-backend/AGENTS.md).

use sea_orm::{ColumnTrait, Condition, EntityTrait, Order};
use sha2::{Digest, Sha256};
use toolkit_db::Db;
use toolkit_db::secure::{SecureEntityExt, SecureInsertExt};
use toolkit_security::AccessScope;
use uuid::Uuid;

/// Where a revision came from.
pub const SOURCE_STUDIO: &str = "studio";
/// Read back from the repository's base branch (ADR-0053 §3).
pub const SOURCE_REPOSITORY: &str = "repository";
/// Taken from where the project's record said it was last saved, when the
/// project had no revision yet (ADR-0053 §5).
pub const SOURCE_MIGRATED: &str = "migrated";

/// How large a description may be. A product.gdl is kilobytes; this is a
/// ceiling against a mistake, not a budget.
pub const MAX_TEXT_BYTES: usize = 512 * 1024;

pub mod entity {
    use sea_orm::entity::prelude::*;
    use toolkit_db::secure::Scopable;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
    #[sea_orm(table_name = "studio_product_descriptions")]
    // A description belongs to the tenant the project's product record is
    // kept in; nothing finer is checked here than it is there.
    #[secure(tenant_col = "tenant_id", no_owner, no_type, no_resource)]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub tenant_id: Uuid,
        #[sea_orm(primary_key, auto_increment = false)]
        pub project_id: Uuid,
        /// 1, 2, 3 ... per project, never reused.
        #[sea_orm(primary_key, auto_increment = false)]
        pub revision: i64,
        #[sea_orm(column_type = "Text")]
        pub text: String,
        /// The person's subject id; `studio` for a revision Studio took itself.
        pub author: String,
        pub created_at_ms: i64,
        /// Hex SHA-256 of `text`.
        pub sha256: String,
        /// `studio` | `repository` | `migrated`.
        pub source: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {}

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            unreachable!("studio_product_descriptions has no relations")
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

/// One revision of a project's description.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Revision {
    pub revision: i64,
    pub text: String,
    pub author: String,
    pub created_at_ms: i64,
    pub sha256: String,
    pub source: String,
}

impl From<entity::Model> for Revision {
    fn from(m: entity::Model) -> Self {
        Self {
            revision: m.revision,
            text: m.text,
            author: m.author,
            created_at_ms: m.created_at_ms,
            sha256: m.sha256,
            source: m.source,
        }
    }
}

/// What a save did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Saved {
    /// A new revision.
    Created(Revision),
    /// The text is the latest's already: nothing new was written.
    Unchanged(Revision),
    /// The save was made against a revision that is no longer the latest; the
    /// latest is this one, and nothing was written.
    Stale(Revision),
}

/// A new revision, as a caller asks for it.
#[derive(Debug, Clone)]
pub struct NewRevision<'a> {
    /// The revision the editor started from; `None` for a project's first.
    pub base_revision: Option<i64>,
    pub text: &'a str,
    pub author: &'a str,
    pub source: &'a str,
}

/// Hex SHA-256 of a description.
pub fn digest(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

/// Whether a save made against `base` may follow `latest`: it was made
/// against the latest, or the project has none and it says so.
pub fn is_current(base: Option<i64>, latest: Option<&Revision>) -> bool {
    base.unwrap_or(0) == latest.map_or(0, |l| l.revision)
}

/// A refusal of a text before anything is stored: empty, too large, or not a
/// description's characters.
pub fn checked_text(text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("a description is not empty".into());
    }
    if text.len() > MAX_TEXT_BYTES {
        return Err(format!(
            "a description is at most {} KiB",
            MAX_TEXT_BYTES / 1024
        ));
    }
    if text.contains('\0') {
        return Err("a description holds no NUL characters".into());
    }
    Ok(())
}

pub struct DescriptionStore {
    db: Db,
}

impl DescriptionStore {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// The project's latest revision; `None` before its first.
    pub async fn latest(&self, tenant: Uuid, project: Uuid) -> anyhow::Result<Option<Revision>> {
        let conn = self.db.conn()?;
        Ok(entity::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .filter(Condition::all().add(entity::Column::ProjectId.eq(project)))
            .order_by(entity::Column::Revision, Order::Desc)
            .limit(1)
            .one(&conn)
            .await?
            .map(Revision::from))
    }

    /// One revision of the project's description.
    pub async fn get(
        &self,
        tenant: Uuid,
        project: Uuid,
        revision: i64,
    ) -> anyhow::Result<Option<Revision>> {
        let conn = self.db.conn()?;
        Ok(entity::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .filter(
                Condition::all()
                    .add(entity::Column::ProjectId.eq(project))
                    .add(entity::Column::Revision.eq(revision)),
            )
            .one(&conn)
            .await?
            .map(Revision::from))
    }

    /// The project's revisions, newest first, at most `limit`.
    pub async fn list(
        &self,
        tenant: Uuid,
        project: Uuid,
        limit: u64,
    ) -> anyhow::Result<Vec<Revision>> {
        let conn = self.db.conn()?;
        Ok(entity::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .filter(Condition::all().add(entity::Column::ProjectId.eq(project)))
            .order_by(entity::Column::Revision, Order::Desc)
            .limit(limit)
            .all(&conn)
            .await?
            .into_iter()
            .map(Revision::from)
            .collect())
    }

    /// Save `new` as the next revision, made against `new.base_revision`.
    pub async fn save(
        &self,
        tenant: Uuid,
        project: Uuid,
        new: &NewRevision<'_>,
    ) -> anyhow::Result<Saved> {
        let latest = self.latest(tenant, project).await?;
        // A base past a project with no revision at all is a first save: there
        // is nothing it could have missed.
        if let Some(l) = &latest
            && !is_current(new.base_revision, Some(l))
        {
            return Ok(Saved::Stale(l.clone()));
        }
        let sha256 = digest(new.text);
        if let Some(l) = &latest
            && l.sha256 == sha256
        {
            return Ok(Saved::Unchanged(l.clone()));
        }
        let made = Revision {
            revision: latest.as_ref().map_or(1, |l| l.revision + 1),
            text: new.text.to_owned(),
            author: new.author.to_owned(),
            created_at_ms: now_ms(),
            sha256,
            source: new.source.to_owned(),
        };
        let row = entity::ActiveModel {
            tenant_id: sea_orm::ActiveValue::Set(tenant),
            project_id: sea_orm::ActiveValue::Set(project),
            revision: sea_orm::ActiveValue::Set(made.revision),
            text: sea_orm::ActiveValue::Set(made.text.clone()),
            author: sea_orm::ActiveValue::Set(made.author.clone()),
            created_at_ms: sea_orm::ActiveValue::Set(made.created_at_ms),
            sha256: sea_orm::ActiveValue::Set(made.sha256.clone()),
            source: sea_orm::ActiveValue::Set(made.source.clone()),
        };
        let conn = self.db.conn()?;
        let inserted = entity::Entity::insert(row)
            .secure()
            // The row is new, so there is nothing to clamp against: the tenant
            // is the request's, resolved by the caller.
            .scope_unchecked(&AccessScope::for_tenant(tenant))?
            .exec(&conn)
            .await;
        match inserted {
            Ok(_) => Ok(Saved::Created(made)),
            // Another save took this number first: it is the latest now, and
            // this one was made against the one before it.
            Err(e) => match self.latest(tenant, project).await? {
                Some(l) if l.revision >= made.revision => Ok(Saved::Stale(l)),
                _ => Err(e.into()),
            },
        }
    }
}

fn now_ms() -> i64 {
    let ms = time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
    i64::try_from(ms).unwrap_or(i64::MAX)
}

/// RFC 3339 of a revision's time, for a response.
pub fn rfc3339(ms: i64) -> String {
    time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .ok()
        .and_then(|t| {
            t.format(&time::format_description::well_known::Rfc3339)
                .ok()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rev(n: i64) -> Revision {
        Revision {
            revision: n,
            text: "product shop {}".into(),
            author: "u".into(),
            created_at_ms: 0,
            sha256: digest("product shop {}"),
            source: SOURCE_STUDIO.into(),
        }
    }

    #[test]
    fn a_save_follows_the_latest_or_the_first() {
        assert!(is_current(None, None));
        assert!(is_current(Some(0), None));
        assert!(!is_current(Some(1), None));
        assert!(is_current(Some(3), Some(&rev(3))));
        assert!(!is_current(Some(2), Some(&rev(3))));
        assert!(!is_current(None, Some(&rev(1))));
    }

    #[test]
    fn a_text_is_checked_before_it_is_kept() {
        assert!(checked_text("product shop {}").is_ok());
        assert!(checked_text("  \n").is_err());
        assert!(checked_text("a\0b").is_err());
        assert!(checked_text(&"x".repeat(MAX_TEXT_BYTES + 1)).is_err());
    }

    #[test]
    fn the_digest_is_the_texts_sha256() {
        assert_eq!(
            digest(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
    }
}

#[cfg(test)]
#[path = "descriptions_tests.rs"]
mod pg_tests;
