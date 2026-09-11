//! studio-user-settings — a person's preferences, keyed on the person.
//!
//! This gear is a Studio-owned stand-in for the platform's
//! `simple-user-settings`, taken over rather than configured (ADR-0017).
//!
//! The platform gear files a row under `(ctx.subject_id(), subject_tenant_id)`:
//! the identity that signed in, in the organization it signed into. For a
//! product where each human has one login and one organization those are the
//! same thing as the human. Studio is not that product — a person reaches one
//! account through an e-mail login and a brokered GitHub login, two accounts
//! that turn out to be one human get merged, and a person belongs to several
//! organizations. Under that key a preference forks the moment somebody signs
//! in the other way, with nothing logged and nothing for them to see: their
//! theme is simply gone.
//!
//! So this one keys on the canonical person from `studio-user` and drops the
//! organization from the key entirely. Same three operations on the same
//! resource shape as the platform gear, under Studio's own path, so the move
//! back is a base-path change.
//!
//! **The intent is to give this back.** `constructorfabric/gears-rust#4785`
//! proposes the hook that would let a deployment tell the platform gear who a
//! caller is; when that lands and the organization question is settled too,
//! this gear's reason to exist goes with it. Until then it is ours to develop.
//!
//! No database configured → the gear stands down (routes answer 503) rather
//! than failing a boot, mirroring studio-user and studio-credstore-pg.

mod entity;
mod migrations;
mod rest;
mod service;
mod store;

use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use axum::Router;
use toolkit::api::OpenApiRegistry;
use toolkit::client_hub::ClientScope;
use toolkit::contracts::{DatabaseCapability, RestApiCapability};
use toolkit::{Gear, GearCtx};
use toolkit_db::DBProvider;
use tracing::{info, warn};

use service::SettingsService;

#[toolkit::gear(
    name = "studio-user-settings",
    deps = [account_management],
    capabilities = [rest, db]
)]
#[derive(Default)]
pub struct StudioUserSettingsGear {
    /// Built in the REST phase, not in `init`: the service needs
    /// `studio-user`'s person resolver, this gear does not declare a dependency
    /// on that gear, and so init order guarantees nothing — whereas every
    /// gear's `init` has run before any gear's REST phase.
    service: OnceLock<Option<Arc<SettingsService>>>,
    db: OnceLock<Option<Arc<DBProvider<anyhow::Error>>>>,
}

#[async_trait]
impl Gear for StudioUserSettingsGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let db = match ctx.db_required() {
            Ok(raw) => Some(Arc::new(DBProvider::<anyhow::Error>::new(raw.db()))),
            Err(e) => {
                warn!(
                    "studio-user-settings: no database configured — gear stands down (settings \
                     API answers 503 until a `database:` section is added): {e}"
                );
                None
            }
        };
        self.db
            .set(db)
            .map_err(|_| anyhow::anyhow!("studio-user-settings already initialized"))?;
        Ok(())
    }
}

impl DatabaseCapability for StudioUserSettingsGear {
    fn migrations(&self) -> Vec<Box<dyn toolkit_db::sea_orm_migration::MigrationTrait>> {
        use toolkit_db::sea_orm_migration::MigratorTrait;
        migrations::Migrator::migrations()
    }
}

#[async_trait]
impl RestApiCapability for StudioUserSettingsGear {
    fn register_rest(
        &self,
        ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        let service = self.build_service(ctx);
        let _ = self.service.set(service.clone());
        Ok(rest::register_routes(router, openapi, service))
    }
}

impl StudioUserSettingsGear {
    /// The service, if both halves it needs are present.
    ///
    /// A database of its own, and `studio-user` to turn a caller into a person.
    /// Without the second the gear refuses to serve rather than falling back to
    /// the token subject: falling back is precisely the behaviour this gear was
    /// taken over to stop, and doing it silently would scatter people's
    /// preferences across their logins exactly as before.
    fn build_service(&self, ctx: &GearCtx) -> Option<Arc<SettingsService>> {
        let db = self.db.get().cloned().flatten()?;
        let people = ctx
            .client_hub()
            .get_scoped::<dyn crate::user_profile::PersonResolver>(&ClientScope::gts_id(
                crate::user_profile::IDENTITY_INSTANCE_ID,
            ))
            .inspect_err(|_| {
                warn!(
                    "studio-user-settings: studio-user person resolver not registered — the \
                     settings API answers 503 rather than filing preferences under a sign-in \
                     method"
                );
            })
            .ok()?;
        info!("studio-user-settings: preferences are keyed on the canonical person");
        Some(Arc::new(SettingsService::new(
            Arc::new(store::PgStore::new(db)),
            people,
        )))
    }
}
