//! studio-secrets-bootstrap — self-heal for config-seeded credstore secrets.
//!
//! The dev credstore value-store (static-credstore-plugin) is in-memory: its
//! values and fence key die with every backend restart, while the secret
//! METADATA lives in Postgres and survives. A restart therefore leaves
//! references like `openai-key` fence-poisoned — `GET` fails closed — and
//! consumers (mini-chat's OAGW upstream provisioning) spin on
//! `failed_precondition` until someone manually PUTs the secret with
//! `If-Match: *`.
//!
//! This gear performs that heal automatically at start: for every configured
//! `(ref, env var)` pair it checks accessibility and, when broken or missing,
//! rewrites the secret via [`WritePrecondition::Exists`] — the SDK's
//! documented healing path for fence-poisoned references (credstore ADR-0003)
//! — falling back to `create` when no metadata exists at all. Boot never
//! fails because of a seed: problems are warnings, consumers keep retrying.

use async_trait::async_trait;
use credstore_sdk::{
    CredStoreClientV1, SecretRef, SecretValue, SharingMode, WritePrecondition,
};
use serde::Deserialize;
use tokio_util::sync::CancellationToken;
use toolkit::{Gear, GearCtx};
use toolkit_security::SecurityContext;
use tracing::{info, warn};
use uuid::Uuid;

/// One secret to ensure at boot.
#[derive(Debug, Clone, Deserialize)]
pub struct SeedSpec {
    /// credstore reference (e.g. "openai-key").
    #[serde(rename = "ref")]
    pub reference: String,
    /// Environment variable holding the value. Empty/unset = skip (warn).
    pub value_env: String,
    /// "shared" (default — cross-tenant, what LLM egress needs) | "tenant" | "private".
    #[serde(default = "default_sharing")]
    pub sharing: String,
}

fn default_sharing() -> String {
    "shared".into()
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SecretsBootstrapConfig {
    #[serde(default)]
    pub secrets: Vec<SeedSpec>,
}

/// Platform root tenant — where cross-tenant (shared) seeds live.
const ROOT_TENANT: Uuid = Uuid::from_u128(0x0000_0000_0000_0000_0000_0000_0000_0001);
/// Stable synthetic subject for the bootstrap writes (shows up in audit).
const BOOTSTRAP_ACTOR: Uuid = Uuid::from_u128(0x0000_0000_0000_0000_0000_0000_0000_b007);

#[toolkit::gear(name = "studio-secrets-bootstrap", deps = [credstore], capabilities = [stateful])]
pub struct SecretsBootstrapGear {
    state: std::sync::OnceLock<(SecretsBootstrapConfig, std::sync::Arc<dyn CredStoreClientV1>)>,
}

impl Default for SecretsBootstrapGear {
    fn default() -> Self {
        Self {
            state: std::sync::OnceLock::new(),
        }
    }
}

#[async_trait]
impl Gear for SecretsBootstrapGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let cfg: SecretsBootstrapConfig = ctx.config_or_default()?;
        let client = ctx.client_hub().get::<dyn CredStoreClientV1>()?;
        info!(seeds = cfg.secrets.len(), "studio-secrets-bootstrap: initialized");
        self.state
            .set((cfg, client))
            .map_err(|_| anyhow::anyhow!("studio-secrets-bootstrap already initialized"))?;
        Ok(())
    }
}

#[async_trait]
impl toolkit::contracts::RunnableCapability for SecretsBootstrapGear {
    /// Heal runs in start (all gears initialized, plugins registered) and in a
    /// spawned task so it never delays the boot sequence.
    async fn start(&self, _cancel: CancellationToken) -> anyhow::Result<()> {
        let Some((cfg, client)) = self.state.get().cloned() else {
            return Ok(());
        };
        tokio::spawn(async move {
            let sec_ctx = match SecurityContext::builder()
                .subject_id(BOOTSTRAP_ACTOR)
                .subject_type("service")
                .subject_tenant_id(ROOT_TENANT)
                .build()
            {
                Ok(c) => c,
                Err(e) => {
                    warn!("studio-secrets-bootstrap: cannot build security context: {e}");
                    return;
                }
            };
            for seed in &cfg.secrets {
                heal_seed(client.as_ref(), &sec_ctx, seed).await;
            }
        });
        Ok(())
    }

    async fn stop(&self, _deadline: CancellationToken) -> anyhow::Result<()> {
        Ok(())
    }
}

async fn heal_seed(client: &dyn CredStoreClientV1, ctx: &SecurityContext, seed: &SeedSpec) {
    let reference = seed.reference.as_str();
    let Some(value) = std::env::var(&seed.value_env)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
    else {
        warn!(
            reference,
            env = %seed.value_env,
            "studio-secrets-bootstrap: env var unset/empty — secret not seeded; dependent features stay off"
        );
        return;
    };
    let sharing = match seed.sharing.as_str() {
        "private" => SharingMode::Private,
        "tenant" => SharingMode::Tenant,
        _ => SharingMode::Shared,
    };
    let key = match SecretRef::new(reference) {
        Ok(k) => k,
        Err(e) => {
            warn!(reference, "studio-secrets-bootstrap: invalid secret ref: {e}");
            return;
        }
    };

    // Accessible already? Then leave it alone (the value store is re-seeded
    // from config every boot, so an accessible secret is also current).
    match client.get(ctx, &key).await {
        Ok(Some(_)) => {
            info!(reference, "studio-secrets-bootstrap: secret accessible — no heal needed");
            return;
        }
        Ok(None) => {
            info!(reference, "studio-secrets-bootstrap: secret missing or fence-poisoned — healing");
        }
        Err(e) => {
            warn!(reference, "studio-secrets-bootstrap: get failed ({e}) — attempting heal anyway");
        }
    }

    // Heal: overwrite whatever generation holds the reference (If-Match: *);
    // when there is no metadata at all, put fails the precondition — create.
    match client
        .put(
            ctx,
            &key,
            SecretValue::new(value.clone().into_bytes()),
            sharing,
            WritePrecondition::Exists,
        )
        .await
    {
        Ok(()) => {
            info!(reference, "studio-secrets-bootstrap: healed (put If-Match:*)");
            return;
        }
        Err(e) if e.is_not_found() || e.is_already_exists() => {
            // fall through to create
        }
        Err(e) => {
            warn!(reference, "studio-secrets-bootstrap: heal put failed: {e}");
            return;
        }
    }
    match client
        .create(ctx, &key, SecretValue::new(value.into_bytes()), sharing)
        .await
    {
        Ok(()) => info!(reference, "studio-secrets-bootstrap: created"),
        Err(e) => warn!(reference, "studio-secrets-bootstrap: create failed: {e}"),
    }
}
