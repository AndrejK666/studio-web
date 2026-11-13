//! studio-artifact-ingest — pull issues, pull requests and files from a
//! connector source into the graph as typed GTS nodes.
//!
//! Three channels feed the artifact graph: the connector API (issues, pull
//! requests) and files. Files are read from the studio-session workspace
//! checkout when the IDE has already cloned the repo (one shared clone,
//! `STUDIO_WORKSPACES_ROOT`); otherwise from our own shallow clone
//! (`STUDIO_ARTIFACT_WORKDIR`, opt-in), otherwise the connector tree API
//! (metadata only). Entities are normalized to `gts.cf.studio.artifact.*`
//! instances with deterministic ids and upserted into a graph store (an
//! in-memory store, readable back by the portal, until the real
//! `hypothesis/graph-storage` adapter lands).

mod activity;
mod builds; // builds the IDE reports, and Build in CI (ADR-0045)
mod ci_runs;
mod comment_threads;
mod entity;
mod graph;
#[cfg(feature = "graph")]
pub(crate) mod graph_backend;
pub(crate) mod gts;
mod index;
mod mcp;
pub(crate) use mcp::tools as mcp_tools;
mod detach_task; // a source taken out of a project as one run (#1042)
mod ingest_task;
pub mod sdk;
pub(crate) use ingest_task::{IngestPayload, TASK_TYPE as INGEST_TASK_TYPE};
mod migrations;
mod model_store;
mod outputs; // what the builds produced: CI artifacts and releases
pub mod port;
mod pull_request_waits;
mod rest;
mod service;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, anyhow};
use async_trait::async_trait;
use axum::Router;
use credstore_sdk::CredStoreClientV1;
use serde::Deserialize;
use toolkit::api::OpenApiRegistry;
use toolkit::client_hub::ClientScope;
use toolkit::contracts::{DatabaseCapability, RestApiCapability};
use toolkit::{Gear, GearCtx};
use tracing::{info, warn};
use types_registry_sdk::{RegisterResult, TypesRegistryClient};

use crate::connectors::sdk::ConnectorDriver;
use graph::InMemoryGraphStore;
use service::IngestService;

/// `gears.studio-artifact-ingest.config`.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct ArtifactIngestConfig {
    /// Where each kind of this gear's data is kept (ADR-0066 §8a).
    pub storage: ArtifactStorageConfig,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct ArtifactStorageConfig {
    /// The artifact graph: `model` (domain objects, the default) or `graph`
    /// (the gear's own graph types).
    pub artifacts: model_store::ArtifactStorage,
}

#[toolkit::gear(
    name = "studio-artifact-ingest",
    deps = [types_registry, credstore],
    capabilities = [db, rest]
)]
#[derive(Default)]
pub struct StudioArtifactIngestGear {
    /// `None` inside the `OnceLock` = booted without a driver → routes 503.
    service: std::sync::OnceLock<Option<Arc<IngestService>>>,
    /// The artifact index (see [`index`]). `None` = no database configured,
    /// and every listing reads the graph as it did before the index existed.
    index: std::sync::OnceLock<Option<Arc<index::ArtifactIndex>>>,
}

#[async_trait]
impl Gear for StudioArtifactIngestGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        // Register the artifact GTS type schemas (idempotent — same documents
        // every boot). The rest of the wiring — drivers, credstore, and the
        // graph store — is resolved in the REST phase, where every gear is
        // initialized: the graph-storage client must not be fetched in `init`,
        // which has no ordering guarantee against the graph-storage gear.
        let registry = ctx.client_hub().get::<dyn TypesRegistryClient>()?;
        let results = registry.register(gts::type_schemas()).await?;
        RegisterResult::ensure_all_ok(&results)?;
        info!("studio-artifact-ingest: types registered");

        // The index is optional in the same way studio-events' log is: without
        // a `database:` section nothing is lost but speed, so the gear says so
        // and carries on reading the graph.
        let index = match ctx.db_required() {
            Ok(db) => {
                info!(
                    "studio-artifact-ingest: artifact index enabled — scoped listings read Postgres"
                );
                Some(Arc::new(index::ArtifactIndex::new(db.db())))
            }
            Err(e) => {
                warn!(
                    "studio-artifact-ingest: no database configured — no artifact index, every \
                     listing walks the graph. Add a `database:` section (server + dbname) to \
                     enable it: {e}"
                );
                None
            }
        };
        let _ = self.index.set(index);
        Ok(())
    }
}

impl DatabaseCapability for StudioArtifactIngestGear {
    fn migrations(&self) -> Vec<Box<dyn toolkit_db::sea_orm_migration::MigrationTrait>> {
        use toolkit_db::sea_orm_migration::MigratorTrait;
        migrations::Migrator::migrations()
    }
}

/// Resolve the artifact graph store. Prefers the real graph-storage gear (when
/// the `graph` feature is on and its client is published); otherwise the
/// in-memory fallback so the pipeline still runs and the portal still shows
/// what was ingested.
fn build_graph_store(ctx: &GearCtx) -> Arc<dyn graph::GraphStore> {
    #[cfg(feature = "graph")]
    {
        match ctx
            .client_hub()
            .get::<dyn graph_storage_sdk::GraphStorageClientV1>()
        {
            Ok(client) => {
                info!(
                    "studio-artifact-ingest: using the graph-storage gear as the artifact graph store"
                );
                return Arc::new(graph_backend::GraphStorageBackend::new(client));
            }
            Err(e) => warn!(
                error = %e,
                "studio-artifact-ingest: graph-storage client unavailable — using the in-memory store"
            ),
        }
    }
    let _ = ctx;
    Arc::new(InMemoryGraphStore::default())
}

/// A directory path from an env var, `~`-expanded, or `None` if unset/empty.
fn resolve_dir(env: &str) -> Option<PathBuf> {
    let raw = std::env::var(env).ok()?;
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if let Some(rest) = raw.strip_prefix("~/")
        && let Ok(home) = std::env::var("HOME")
    {
        return Some(PathBuf::from(home).join(rest));
    }
    Some(PathBuf::from(raw))
}

#[derive(Default, Deserialize)]
struct IngestGearConfig {
    #[serde(default)]
    client_credentials: ClientCredentialsConfig,
    #[serde(default)]
    mirror_base_url: String,
}

#[derive(Default, Deserialize)]
struct ClientCredentialsConfig {
    #[serde(default)]
    client_id: String,
    #[serde(default)]
    client_secret: String,
}

fn platform_client(ctx: &GearCtx) -> anyhow::Result<Option<service::PlatformClient>> {
    let cfg: IngestGearConfig = ctx.config_or_default()?;
    let creds = cfg.client_credentials;
    if creds.client_id.trim().is_empty() {
        return Ok(None);
    }
    let mirror_base_url = checked_mirror_base_url(&cfg.mirror_base_url)?;
    let authn = ctx
        .client_hub()
        .get::<dyn authn_resolver_sdk::AuthNResolverClient>()?;
    info!(client_id = %creds.client_id, "studio-artifact-ingest: a connection with platform_auth reads with this client's token");
    Ok(Some(service::PlatformClient {
        authn,
        client_id: creds.client_id,
        client_secret: creds.client_secret,
        mirror_base_url,
    }))
}

fn checked_mirror_base_url(raw: &str) -> anyhow::Result<String> {
    let raw = raw.trim().trim_end_matches('/');
    if raw.is_empty() {
        return Ok(String::new());
    }
    let url = reqwest::Url::parse(raw)
        .with_context(|| format!("studio-artifact-ingest.mirror_base_url `{raw}` is not a URL"))?;
    let host = url
        .host_str()
        .unwrap_or_default()
        .trim_start_matches('[')
        .trim_end_matches(']');
    let loopback = host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    match url.scheme() {
        "https" => Ok(raw.to_string()),
        "http" if loopback => Ok(raw.to_string()),
        scheme => Err(anyhow!(
            "studio-artifact-ingest.mirror_base_url `{raw}` must be https:// unless it points at \
             this host (localhost, 127.0.0.1 or ::1); the platform token must not travel over {scheme}"
        )),
    }
}

/// `$HOME/<rel>`, or `None` when `$HOME` is unset.
fn resolve_home_relative(rel: &str) -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .map(|h| PathBuf::from(h).join(rel))
}

#[async_trait]
impl RestApiCapability for StudioArtifactIngestGear {
    fn register_rest(
        &self,
        ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        // Resolve the source connector drivers by the same ClientHub ids the
        // connector gear uses. A provider whose plugin is not linked is skipped.
        let mut drivers: HashMap<String, Arc<dyn ConnectorDriver>> = HashMap::new();
        for id in crate::connectors::source_driver_ids() {
            if let Ok(d) = ctx
                .client_hub()
                .get_scoped::<dyn ConnectorDriver>(&ClientScope::gts_id(id))
            {
                drivers.insert(d.provider().to_string(), d);
            }
        }

        let service = if drivers.is_empty() {
            warn!(
                "studio-artifact-ingest: no connector driver plugins registered — \
                 /sync will answer 503"
            );
            None
        } else {
            let credstore = ctx.client_hub().get::<dyn CredStoreClientV1>()?;
            let graph = build_graph_store(ctx);
            let graph: Arc<dyn graph::GraphStore> = match self.index.get().cloned().flatten() {
                Some(index) => Arc::new(index::IndexedGraphStore::new(graph, index)),
                None => graph,
            };
            // The target scheme (ADR-0066 §8a): the artifacts are domain
            // objects, and the store above only answers until a tenant's have
            // moved.
            let config: ArtifactIngestConfig = ctx.config_or_default()?;
            let held = Arc::new(model_store::ModelGraphStore::new(graph, ctx.client_hub()));
            let in_model = config.storage.artifacts == model_store::ArtifactStorage::Model;
            crate::data_places::note(
                "studio-artifact-ingest",
                "artifacts",
                &crate::data_places::store_name(config.storage.artifacts),
            );
            crate::model_sweep::register(Arc::new(model_store::ArtifactMover {
                store: held.clone(),
                returning: !in_model,
            }));
            let graph: Arc<dyn graph::GraphStore> = if in_model {
                info!("studio-artifact-ingest: artifacts are kept as domain objects");
                Arc::new(model_store::ModelGraph(held))
            } else {
                // Kept in the graph store: what the model holds moves back.
                Arc::new(model_store::ReturningGraph(held))
            };

            // Preferred file source: the studio-session workspaces root. When
            // the IDE has cloned a repo into `{root}/{workspace_id}/{repo_dir}`,
            // ingest reads that same checkout — one shared clone. Mirrors the
            // session gear's default (`~/.cf-studio-workspaces`).
            let workspaces_root = resolve_dir("STUDIO_WORKSPACES_ROOT")
                .or_else(|| resolve_home_relative(".cf-studio-workspaces"));
            if let Some(r) = &workspaces_root {
                info!(dir = %r.display(), "studio-artifact-ingest: reading files from the session workspaces root when present");
            }

            // Optional fallback: our own shallow clone volume (off unless
            // STUDIO_ARTIFACT_WORKDIR is set).
            let mut work_root_failure = None;
            let work_root = match resolve_dir("STUDIO_ARTIFACT_WORKDIR") {
                Some(path) => match std::fs::create_dir_all(&path) {
                    Ok(()) => {
                        // Kept even when it cannot be written: the clones
                        // already in it still read.
                        work_root_failure = service::writable(&path);
                        match &work_root_failure {
                            Some(why) => {
                                tracing::error!(dir = %path.display(), why, "studio-artifact-ingest: the own-clone volume cannot be written — every clone will fail")
                            }
                            None => {
                                info!(dir = %path.display(), "studio-artifact-ingest: fallback own-clone volume enabled")
                            }
                        }
                        Some(path)
                    }
                    Err(e) => {
                        warn!(dir = %path.display(), error = %e, "studio-artifact-ingest: fallback work dir not usable");
                        None
                    }
                },
                None => None,
            };

            // studio-documents, if this deployment runs it. Resolved here, in
            // the REST phase, where every gear has initialized — the same
            // reason the graph client is not fetched in `init`. Absent is a
            // normal state: the gear stands down without a database, and a
            // repository then syncs without being classified.
            let classifier = match ctx
                .client_hub()
                .get::<dyn crate::documents::port::DocumentClassifier>()
            {
                Ok(c) => {
                    info!(
                        "studio-artifact-ingest: studio-documents wired — a sync decides what every file it reads is"
                    );
                    Some(c)
                }
                Err(e) => {
                    warn!(error = %e, "studio-artifact-ingest: studio-documents unavailable — files stay unclassified");
                    None
                }
            };

            Some(Arc::new(
                IngestService::new(
                    credstore,
                    drivers,
                    graph,
                    classifier,
                    workspaces_root,
                    work_root,
                )
                .with_work_root_failure(work_root_failure)
                .with_connectors(crate::connectors::sdk::Connectors::new(ctx.client_hub()))
                .with_platform(platform_client(ctx)?),
            ))
        };

        // A sync is an `artifact.ingest` run on studio-tasks — durable,
        // cancellable, retried with backoff. Registered here because the
        // service it needs is built here, and refused loudly if something else
        // has claimed the task type.
        if let Some(service) = &service {
            crate::tasks::sdk::register(Arc::new(ingest_task::IngestTask::new(Arc::clone(
                service,
            ))))?;
            // Detaching a source writes the project's config and prunes what
            // was synced from it, in one run. Without account-management there
            // is no config to write, and the route answers 503 for want of
            // the task type.
            match ctx
                .client_hub()
                .get::<dyn account_management_sdk::AccountManagementClient>()
            {
                Ok(am) => crate::tasks::sdk::register(Arc::new(detach_task::DetachTask::new(
                    Arc::new(detach_task::InProcess::new(am, Arc::clone(service))),
                )))?,
                Err(e) => {
                    warn!(error = %e, "studio-artifact-ingest: account-management unavailable — sources cannot be detached")
                }
            }
        }

        // Offer the checkout to whoever owns the documents in it.
        //
        // The documents gear knows which files are specs and what type each is;
        // what it has never had is their text, because nobody stores it: the
        // graph keeps an excerpt and a binding keeps a path. Without this the
        // only thing that could join the two was the browser, which read the
        // files out through REST and posted them back to be analysed.
        if let Some(service) = &service {
            ctx.client_hub()
                .register::<dyn port::RepoFileReader>(service.clone());
            // The portfolio's finding count, for whoever composes the rollup.
            ctx.client_hub()
                .register::<dyn port::ArtifactCounter>(service.clone());
            // The projects table's review and source columns, likewise.
            ctx.client_hub()
                .register::<dyn port::ProjectSignalSource>(service.clone());
            // A project's issues, pull requests and commits, for the documents
            // gear to link to the requirements they name.
            ctx.client_hub()
                .register::<dyn port::ProjectWork>(service.clone());
            // CI runs and review waits, for the stage gates (#782).
            ctx.client_hub()
                .register::<dyn port::DeliveryEvidence>(service.clone());
            // A project's builds by id, for the gear that deploys them (ADR-0048).
            ctx.client_hub()
                .register::<dyn port::BuildRecords>(service.clone());
            // Open pull requests and who they wait on, for the organization's overview.
            ctx.client_hub()
                .register::<dyn port::OpenPullRequests>(service.clone());
            // The ingested files, for the gear that decides what each one is.
            ctx.client_hub()
                .register::<dyn port::ArtifactFiles>(service.clone());
            // Where a Spec Quality run writes the findings it records itself.
            ctx.client_hub()
                .register::<dyn port::SpecFindingWriter>(service.clone());
            // Where the spec-mapping gear keeps a member's mapping decisions.
            ctx.client_hub()
                .register::<dyn port::MappingDecisionStore>(service.clone());
        }

        // Retain for the process lifetime; the router also owns a clone.
        let _ = self.service.set(service.clone());
        Ok(rest::register_routes(
            router,
            openapi,
            service,
            ctx.client_hub(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::checked_mirror_base_url;

    #[test]
    fn mirror_base_url_empty_stays_empty() {
        assert_eq!(checked_mirror_base_url("").unwrap(), "");
        assert_eq!(checked_mirror_base_url("   ").unwrap(), "");
    }

    #[test]
    fn mirror_base_url_accepts_https_anywhere() {
        assert_eq!(
            checked_mirror_base_url("https://studio.example.com/cf/").unwrap(),
            "https://studio.example.com/cf"
        );
        assert_eq!(
            checked_mirror_base_url("https://10.1.2.3/cf").unwrap(),
            "https://10.1.2.3/cf"
        );
    }

    #[test]
    fn mirror_base_url_accepts_http_on_loopback() {
        for (raw, expected) in [
            (" http://127.0.0.1:8090/cf/ ", "http://127.0.0.1:8090/cf"),
            ("http://localhost:8090/cf", "http://localhost:8090/cf"),
            ("http://LOCALHOST:8090/cf", "http://LOCALHOST:8090/cf"),
            ("http://[::1]:8090/cf", "http://[::1]:8090/cf"),
            ("http://127.1.2.3:8090/cf", "http://127.1.2.3:8090/cf"),
        ] {
            assert_eq!(checked_mirror_base_url(raw).unwrap(), expected, "{raw}");
        }
    }

    #[test]
    fn mirror_base_url_refuses_http_off_loopback() {
        for raw in [
            "http://studio.example.com/cf",
            "http://10.1.2.3:8090/cf",
            "http://0.0.0.0:8090/cf",
            "http://localhost.example.com/cf",
            "http://studio-web-backend.studio.svc.cluster.local:8090/cf",
        ] {
            let err = checked_mirror_base_url(raw).unwrap_err().to_string();
            assert!(err.contains("must be https://"), "{raw}: {err}");
        }
    }

    #[test]
    fn mirror_base_url_refuses_other_schemes_and_garbage() {
        for raw in [
            "ftp://127.0.0.1/cf",
            "file:///tmp/cf",
            "ws://127.0.0.1:8090/cf",
        ] {
            let err = checked_mirror_base_url(raw).unwrap_err().to_string();
            assert!(err.contains("must be https://"), "{raw}: {err}");
        }
        for raw in ["127.0.0.1:8090/cf", "not a url", "https://"] {
            let err = checked_mirror_base_url(raw).unwrap_err().to_string();
            assert!(err.contains("is not a URL"), "{raw}: {err}");
        }
    }
}
