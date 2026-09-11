//! Where a person's preferences live: a typed repository over one table.
//!
//! Every row is in the platform-root partition, so every query is scoped to it
//! through toolkit-db's secure runner — the framework never hands out a raw
//! connection.

use std::sync::Arc;

use anyhow::{Result, anyhow};
use async_trait::async_trait;
use sea_orm::{ActiveValue, ColumnTrait, Condition, EntityTrait};
use time::OffsetDateTime;
use toolkit_db::DBProvider;
use toolkit_db::secure::{SecureEntityExt, SecureInsertExt, SecureOnConflict};
use toolkit_security::AccessScope;
use uuid::Uuid;

use super::entity::{self, ROOT_TENANT};
use super::service::Settings;

fn scope() -> AccessScope {
    AccessScope::for_tenant(ROOT_TENANT)
}

/// What the gear needs of its storage, and nothing more.
#[async_trait]
pub(crate) trait SettingsStore: Send + Sync {
    /// One person's preferences, or `None` when they have never set any.
    async fn get(&self, user_id: Uuid) -> Result<Option<Settings>>;

    /// Write a person's preferences whole.
    ///
    /// `None` in a field clears it, which is what makes a patch expressible as
    /// a read followed by a write: the service decides what a field means,
    /// storage only records the decision.
    async fn upsert(&self, settings: &Settings) -> Result<()>;
}

pub struct PgStore {
    db: Arc<DBProvider<anyhow::Error>>,
}

impl PgStore {
    #[must_use]
    pub fn new(db: Arc<DBProvider<anyhow::Error>>) -> Self {
        Self { db }
    }
}

#[async_trait]
impl SettingsStore for PgStore {
    async fn get(&self, user_id: Uuid) -> Result<Option<Settings>> {
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("settings db connect: {e}"))?;
        Ok(entity::setting::Entity::find()
            .secure()
            .scope_with(&scope())
            .filter(Condition::all().add(entity::setting::Column::UserId.eq(user_id)))
            .one(&conn)
            .await?
            .map(|m| Settings {
                user_id: m.user_id,
                theme: m.theme,
                language: m.language,
            }))
    }

    async fn upsert(&self, settings: &Settings) -> Result<()> {
        let conn = self
            .db
            .conn()
            .map_err(|e| anyhow!("settings db connect: {e}"))?;
        let now = OffsetDateTime::now_utc();
        let am = entity::setting::ActiveModel {
            user_id: ActiveValue::Set(settings.user_id),
            tenant_id: ActiveValue::Set(ROOT_TENANT),
            theme: ActiveValue::Set(settings.theme.clone()),
            language: ActiveValue::Set(settings.language.clone()),
            created_at: ActiveValue::Set(now),
            updated_at: ActiveValue::Set(now),
        };
        // `created_at` is deliberately left out of the update set: the first
        // write is when these preferences began, and a later edit is not.
        let on_conflict =
            SecureOnConflict::<entity::setting::Entity>::columns([entity::setting::Column::UserId])
                .update_columns([
                    entity::setting::Column::Theme,
                    entity::setting::Column::Language,
                    entity::setting::Column::UpdatedAt,
                ])
                .map_err(|e| anyhow!("settings upsert conflict: {e}"))?;
        entity::setting::Entity::insert(am)
            .secure()
            .scope_unchecked(&scope())
            .map_err(|e| anyhow!("settings insert scope: {e}"))?
            .on_conflict(on_conflict)
            .exec(&conn)
            .await?;
        Ok(())
    }
}
