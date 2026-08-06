//! Connection catalogue and driver dispatch.
//!
//! A *connection* is configuration: which driver, which installation, which
//! credential, who may see it. It is stored as tenant metadata under
//! [`CONNECTIONS_METADATA_TYPE`] — no new database, and the record is
//! GTS-typed and tenant-scoped by construction.
//!
//! The token is never part of that record. It goes to credstore under a
//! per-connection reference, with the sharing mode carrying the visibility the
//! caller asked for: `personal` keeps it to its owner, `workspace` to the
//! tenant, `organization` lets descendant tenants read it. That is credstore's
//! existing contract, so scope needs no bespoke enforcement here.
//!
//! Reads go through `resolve_metadata`, and the schema declares
//! `inheritance_policy: inherit`, so a workspace sees the connections of its
//! organization. Per AM's contract the nearest row wins whole — a tenant with
//! its own catalogue shadows its ancestors' rather than merging with them —
//! and the walk stops at self-managed barriers, so inheritance never crosses
//! an isolation boundary.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use account_management_sdk::{AccountManagementClient, UpsertMetadataRequest};
use anyhow::{Context, anyhow};
use credstore_sdk::{CredStoreClientV1, SecretRef, SecretValue, SharingMode, WritePrecondition};
use gts::GtsTypeId;
use serde::{Deserialize, Serialize};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::driver::{ConnectionAuth, ConnectorDriver, DriverIdentity, RemoteRepo};
use super::gts::CONNECTIONS_METADATA_TYPE;

/// Visibility of a connection, mapped onto credstore sharing modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionScope {
    /// Only the creator.
    Personal,
    /// Everyone in the tenant that owns it.
    Workspace,
    /// The owning tenant and its descendants.
    Organization,
}

impl ConnectionScope {
    pub fn parse(raw: &str) -> anyhow::Result<Self> {
        match raw.trim().to_lowercase().as_str() {
            "personal" => Ok(Self::Personal),
            "" | "workspace" | "tenant" => Ok(Self::Workspace),
            "organization" | "org" | "shared" => Ok(Self::Organization),
            other => Err(anyhow!(
                "unknown scope '{other}' (expected personal | workspace | organization)"
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Personal => "personal",
            Self::Workspace => "workspace",
            Self::Organization => "organization",
        }
    }

    fn sharing(self) -> SharingMode {
        match self {
            Self::Personal => SharingMode::Private,
            Self::Workspace => SharingMode::Tenant,
            Self::Organization => SharingMode::Shared,
        }
    }
}

/// A stored connection. Serialised into the tenant-metadata catalogue.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Connection {
    pub id: Uuid,
    /// Driver key: `gitlab`, `github`, …
    pub provider: String,
    pub label: String,
    pub base_url: String,
    /// credstore reference holding the token. Never returned over the API.
    pub secret_ref: String,
    /// `personal` | `workspace` | `organization`
    pub scope: String,
    pub created_at_epoch_secs: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Catalogue {
    #[serde(default)]
    items: Vec<Connection>,
}

/// A provider the assembly can actually serve, i.e. one whose plugin gear is
/// linked and registered.
#[derive(Debug, Clone)]
pub struct ProviderInfo {
    pub provider: String,
    pub display_name: String,
    pub default_base_url: String,
    pub instance_id: String,
    /// `source_code` | `ai` — decides whether repositories can be browsed.
    pub category: String,
    /// Field label for the credential ("Personal Access Token (PAT)", "API Key").
    pub credential_label: String,
    /// Placeholder hinting at the credential's shape.
    pub credential_hint: String,
}

pub struct ConnectorService {
    am: Arc<dyn AccountManagementClient>,
    credstore: Arc<dyn CredStoreClientV1>,
    /// Resolved drivers keyed by provider key, in registration order.
    drivers: BTreeMap<String, (String, Arc<dyn ConnectorDriver>)>,
}

impl ConnectorService {
    pub fn new(
        am: Arc<dyn AccountManagementClient>,
        credstore: Arc<dyn CredStoreClientV1>,
        drivers: Vec<(String, Arc<dyn ConnectorDriver>)>,
    ) -> Arc<Self> {
        let drivers = drivers
            .into_iter()
            .map(|(instance_id, d)| (d.provider().to_string(), (instance_id, d)))
            .collect();
        Arc::new(Self {
            am,
            credstore,
            drivers,
        })
    }

    pub fn providers(&self) -> Vec<ProviderInfo> {
        self.drivers
            .values()
            .map(|(instance_id, d)| ProviderInfo {
                provider: d.provider().to_string(),
                display_name: d.display_name().to_string(),
                default_base_url: d.default_base_url().to_string(),
                instance_id: instance_id.clone(),
                category: d.category().as_str().to_string(),
                credential_label: d.credential_label().to_string(),
                credential_hint: d.credential_hint().to_string(),
            })
            .collect()
    }

    fn driver(&self, provider: &str) -> anyhow::Result<&Arc<dyn ConnectorDriver>> {
        self.drivers
            .get(provider)
            .map(|(_, d)| d)
            .ok_or_else(|| anyhow!("no driver for provider '{provider}' in this deployment"))
    }

    fn type_id() -> GtsTypeId {
        GtsTypeId::new(CONNECTIONS_METADATA_TYPE)
    }

    /// Catalogue visible to the caller: the tenant's own row, or the nearest
    /// ancestor's when it has none of its own.
    async fn load(&self, ctx: &SecurityContext) -> anyhow::Result<Catalogue> {
        let entry = self
            .am
            .resolve_metadata(ctx, ctx.subject_tenant_id(), Self::type_id())
            .await
            .map_err(|e| anyhow!("cannot read the connection catalogue: {e}"))?;
        match entry {
            Some(e) => Ok(serde_json::from_value(e.value).unwrap_or_default()),
            None => Ok(Catalogue::default()),
        }
    }

    /// Catalogue stored directly on the caller's tenant. Writes must not
    /// silently absorb an inherited catalogue into the child tenant, so
    /// mutations read the direct row only.
    async fn load_own(&self, ctx: &SecurityContext) -> anyhow::Result<Catalogue> {
        match self
            .am
            .get_metadata(ctx, ctx.subject_tenant_id(), Self::type_id())
            .await
        {
            Ok(e) => Ok(serde_json::from_value(e.value).unwrap_or_default()),
            // Absent row is the common case on the first connection; AM
            // raises NotFound for an unregistered schema, which the gear logs
            // at init, so treating both as "empty" keeps the happy path clean.
            Err(_) => Ok(Catalogue::default()),
        }
    }

    async fn store(&self, ctx: &SecurityContext, catalogue: &Catalogue) -> anyhow::Result<()> {
        self.am
            .upsert_metadata(
                ctx,
                ctx.subject_tenant_id(),
                // #[non_exhaustive]: build through the constructor. No
                // expected_version — last-write-wins is right here, the
                // catalogue is edited by one person at a time and a lost
                // update would only mean re-adding a connection.
                UpsertMetadataRequest::new(Self::type_id(), serde_json::to_value(catalogue)?),
            )
            .await
            .map_err(|e| anyhow!("cannot write the connection catalogue: {e}"))?;
        Ok(())
    }

    pub async fn list(&self, ctx: &SecurityContext) -> anyhow::Result<Vec<Connection>> {
        Ok(self.load(ctx).await?.items)
    }

    async fn find(&self, ctx: &SecurityContext, id: Uuid) -> anyhow::Result<Connection> {
        self.load(ctx)
            .await?
            .items
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| anyhow!("connection {id} not found"))
    }

    /// Assemble driver credentials for a stored connection.
    async fn auth(&self, ctx: &SecurityContext, c: &Connection) -> anyhow::Result<ConnectionAuth> {
        let key = SecretRef::new(&c.secret_ref)
            .map_err(|e| anyhow!("bad secret reference '{}': {e}", c.secret_ref))?;
        let secret = self
            .credstore
            .get(ctx, &key)
            .await
            .map_err(|e| anyhow!("credstore: {e}"))?
            .ok_or_else(|| {
                anyhow!(
                    "the token for connection '{}' is not readable — it may belong to \
                     another user (personal scope) or have been removed",
                    c.label
                )
            })?;
        let token = String::from_utf8(secret.value.as_bytes().to_vec())
            .context("stored token is not valid UTF-8")?;
        Ok(ConnectionAuth {
            base_url: c.base_url.clone(),
            token,
        })
    }

    /// Verify credentials, store them, and append the connection. The test
    /// runs *before* anything is written: a typo should not leave a dead
    /// entry behind.
    pub async fn create(
        &self,
        ctx: &SecurityContext,
        provider: &str,
        label: &str,
        base_url: Option<&str>,
        token: &str,
        scope: &str,
    ) -> anyhow::Result<(Connection, DriverIdentity)> {
        let driver = self.driver(provider)?;
        let label = label.trim();
        if label.is_empty() {
            return Err(anyhow!("label is required"));
        }
        let token = token.trim();
        if token.is_empty() {
            return Err(anyhow!("token is required"));
        }
        let base_url = base_url
            .map(str::trim)
            .filter(|u| !u.is_empty())
            .unwrap_or_else(|| driver.default_base_url())
            .to_string();
        let scope = ConnectionScope::parse(scope)?;

        let identity = driver
            .test(&ConnectionAuth {
                base_url: base_url.clone(),
                token: token.to_string(),
            })
            .await
            .context("the credential was rejected by the provider")?;

        let id = Uuid::new_v4();
        let secret_ref = format!("studio-connection-{id}");
        let key = SecretRef::new(&secret_ref).map_err(|e| anyhow!("bad secret reference: {e}"))?;
        self.credstore
            .create(
                ctx,
                &key,
                SecretValue::new(token.as_bytes().to_vec()),
                scope.sharing(),
            )
            .await
            .map_err(|e| anyhow!("cannot store the token: {e}"))?;

        let connection = Connection {
            id,
            provider: provider.to_string(),
            label: label.to_string(),
            base_url,
            secret_ref,
            scope: scope.as_str().to_string(),
            created_at_epoch_secs: now_secs(),
        };
        let mut catalogue = self.load_own(ctx).await?;
        catalogue.items.push(connection.clone());
        self.store(ctx, &catalogue).await?;
        Ok((connection, identity))
    }

    /// Verify a credential without storing anything — the "Test connection"
    /// button next to "Test & save". Takes no security context because
    /// nothing is read from or written to the tenant.
    pub async fn probe(
        &self,
        provider: &str,
        base_url: Option<&str>,
        token: &str,
    ) -> anyhow::Result<DriverIdentity> {
        let driver = self.driver(provider)?;
        let token = token.trim();
        if token.is_empty() {
            return Err(anyhow!("token is required"));
        }
        let base_url = base_url
            .map(str::trim)
            .filter(|u| !u.is_empty())
            .unwrap_or_else(|| driver.default_base_url())
            .to_string();
        driver
            .test(&ConnectionAuth {
                base_url,
                token: token.to_string(),
            })
            .await
    }

    pub async fn delete(&self, ctx: &SecurityContext, id: Uuid) -> anyhow::Result<bool> {
        let mut catalogue = self.load_own(ctx).await?;
        let Some(pos) = catalogue.items.iter().position(|c| c.id == id) else {
            return Ok(false);
        };
        let removed = catalogue.items.remove(pos);
        self.store(ctx, &catalogue).await?;
        // Best-effort: an orphaned secret is harmless, a failed delete of the
        // catalogue entry would not be.
        if let Ok(key) = SecretRef::new(&removed.secret_ref)
            && let Err(e) = self
                .credstore
                .delete(ctx, &key, WritePrecondition::Exists)
                .await
        {
            tracing::warn!(
                reference = %removed.secret_ref,
                "studio-connector: connection removed but its token could not be deleted ({e})"
            );
        }
        Ok(true)
    }

    pub async fn test(
        &self,
        ctx: &SecurityContext,
        id: Uuid,
    ) -> anyhow::Result<(Connection, DriverIdentity)> {
        let c = self.find(ctx, id).await?;
        let driver = self.driver(&c.provider)?;
        let auth = self.auth(ctx, &c).await?;
        let identity = driver.test(&auth).await?;
        Ok((c, identity))
    }

    pub async fn repositories(
        &self,
        ctx: &SecurityContext,
        id: Uuid,
        search: Option<&str>,
        limit: u32,
    ) -> anyhow::Result<Vec<RemoteRepo>> {
        let c = self.find(ctx, id).await?;
        let driver = self.driver(&c.provider)?;
        let auth = self.auth(ctx, &c).await?;
        driver.list_repositories(&auth, search, limit).await
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}
