//! Where report sources are kept: graph-storage, one node per report per
//! organization; in memory when the build has no graph.

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::source::ReportSource;

#[async_trait]
pub trait ReportStore: Send + Sync {
    /// The organization's source for a report, if it saved one.
    async fn get(
        &self,
        ctx: &SecurityContext,
        report: &str,
    ) -> anyhow::Result<Option<ReportSource>>;
    async fn put(&self, ctx: &SecurityContext, source: &ReportSource) -> anyhow::Result<()>;
    /// Drop the organization's source for a report: what a move into the
    /// domain model does to the copy it moved from.
    async fn delete(&self, _ctx: &SecurityContext, _report: &str) -> anyhow::Result<()> {
        Ok(())
    }
}

/// Per tenant, per report. What a build without graph-storage keeps, and what
/// the tests run on.
#[derive(Default)]
pub struct MemoryStore {
    sources: Mutex<HashMap<(Uuid, String), ReportSource>>,
}

#[async_trait]
impl ReportStore for MemoryStore {
    async fn get(
        &self,
        ctx: &SecurityContext,
        report: &str,
    ) -> anyhow::Result<Option<ReportSource>> {
        let map = self
            .sources
            .lock()
            .map_err(|_| anyhow::anyhow!("report store poisoned"))?;
        Ok(map
            .get(&(ctx.subject_tenant_id(), report.to_string()))
            .cloned())
    }

    async fn delete(&self, ctx: &SecurityContext, report: &str) -> anyhow::Result<()> {
        self.sources
            .lock()
            .map_err(|_| anyhow::anyhow!("report store poisoned"))?
            .remove(&(ctx.subject_tenant_id(), report.to_string()));
        Ok(())
    }

    async fn put(&self, ctx: &SecurityContext, source: &ReportSource) -> anyhow::Result<()> {
        let mut map = self
            .sources
            .lock()
            .map_err(|_| anyhow::anyhow!("report store poisoned"))?;
        map.insert(
            (ctx.subject_tenant_id(), source.report.clone()),
            source.clone(),
        );
        Ok(())
    }
}

#[cfg(feature = "graph")]
pub use graph::GraphStore;

/// Report sources as domain objects (ADR-0066 §8a, `storage.sources`): one
/// `report-source` object per organization and report, kept by this gear. A
/// source the model has not seen is read from `legacy` once and copied in.
pub struct ModelStore {
    legacy: std::sync::Arc<dyn ReportStore>,
    port: PortSource,
    /// `storage.sources` set back: the model's copy returns to `legacy`.
    returning: bool,
}

enum PortSource {
    Hub(std::sync::Arc<toolkit::client_hub::ClientHub>),
    #[cfg(test)]
    Fixed(std::sync::Arc<dyn crate::domain_model::port::DomainObjects>),
}

const SOURCE_ENTITY: &str = "report-source";

impl ModelStore {
    pub fn new(
        legacy: std::sync::Arc<dyn ReportStore>,
        hub: std::sync::Arc<toolkit::client_hub::ClientHub>,
    ) -> Self {
        Self {
            legacy,
            port: PortSource::Hub(hub),
            returning: false,
        }
    }

    /// The old store, with a source the model holds moved back on first read.
    pub fn returning(
        legacy: std::sync::Arc<dyn ReportStore>,
        hub: std::sync::Arc<toolkit::client_hub::ClientHub>,
    ) -> Self {
        Self {
            returning: true,
            ..Self::new(legacy, hub)
        }
    }

    async fn back_to_legacy(&self, ctx: &SecurityContext, report: &str) {
        let Some(port) = self.port() else {
            return;
        };
        let id = Self::object_id(ctx.subject_tenant_id(), report);
        let result = async {
            let (found, _) = port
                .query(ctx, serde_json::json!({"type": SOURCE_ENTITY, "where": {"id": {"_eq": id}}, "limit": 1}))
                .await?;
            let Some(o) = found.into_iter().next() else {
                return anyhow::Ok(());
            };
            let mut v = o.payload;
            if let Some(m) = v.as_object_mut() {
                for f in ["report_tenant", "name", "_scope"] {
                    m.remove(f);
                }
            }
            self.legacy.put(ctx, &unpack(v)?).await?;
            port.remove_objects(ctx, SOURCE_ENTITY, vec![id.clone()]).await?;
            anyhow::Ok(())
        }
        .await;
        if let Err(e) = result {
            tracing::warn!(report, error = %e, "studio-reports: a source could not move back yet");
        }
    }

    #[cfg(test)]
    pub fn with_port(
        legacy: std::sync::Arc<dyn ReportStore>,
        port: std::sync::Arc<dyn crate::domain_model::port::DomainObjects>,
    ) -> Self {
        Self {
            legacy,
            port: PortSource::Fixed(port),
            returning: false,
        }
    }

    fn port(&self) -> Option<std::sync::Arc<dyn crate::domain_model::port::DomainObjects>> {
        match &self.port {
            PortSource::Hub(hub) => hub
                .get::<dyn crate::domain_model::port::DomainObjects>()
                .ok(),
            #[cfg(test)]
            PortSource::Fixed(port) => Some(std::sync::Arc::clone(port)),
        }
    }

    pub(super) fn need() -> crate::domain_model::port::TypeNeed {
        let f = |n: &str, t: &str| (n.to_owned(), t.to_owned(), String::new());
        crate::domain_model::port::TypeNeed {
            declared_by: "studio-reports".to_owned(),
            id: SOURCE_ENTITY.to_owned(),
            name: "Report Source".to_owned(),
            description: "Where an organization's report reads from: its connection, plan file, board, and the plan as last read.".to_owned(),
            extends: Some("record".to_owned()),
            bucket: Some("operations".to_owned()),
            fields: vec![
                f("report", "string"),
                f("report_tenant", "string"),
                f("connection_id", "string?"),
                f("plan_file", "string?"),
                f("board", "string?"),
                f("snapshot", "JSON?"),
            ],
            relations: Vec::new(),
            held_by: Some("studio-reports".to_owned()),
            searchable: false,
        }
    }

    fn object_id(tenant: Uuid, report: &str) -> String {
        format!("{SOURCE_ENTITY}:{tenant}:{report}")
    }

    async fn write(
        &self,
        ctx: &SecurityContext,
        port: &dyn crate::domain_model::port::DomainObjects,
        source: &ReportSource,
    ) -> anyhow::Result<()> {
        let tenant = ctx.subject_tenant_id();
        let mut payload = pack(source)?;
        payload["report_tenant"] = serde_json::json!(tenant);
        payload["name"] = serde_json::json!(source.report);
        port.put_objects(
            ctx,
            SOURCE_ENTITY,
            vec![crate::domain_model::port::OwnedObject {
                id: Self::object_id(tenant, &source.report),
                scope: String::new(),
                payload,
            }],
        )
        .await?;
        Ok(())
    }
}

#[async_trait]
impl ReportStore for ModelStore {
    async fn get(
        &self,
        ctx: &SecurityContext,
        report: &str,
    ) -> anyhow::Result<Option<ReportSource>> {
        if self.returning {
            self.back_to_legacy(ctx, report).await;
            return self.legacy.get(ctx, report).await;
        }
        let Some(port) = self.port() else {
            return self.legacy.get(ctx, report).await;
        };
        port.ensure_type(ctx, &Self::need()).await?;
        let id = Self::object_id(ctx.subject_tenant_id(), report);
        let (found, _) = port
            .query(
                ctx,
                serde_json::json!({"type": SOURCE_ENTITY, "where": {"id": {"_eq": id}}, "limit": 1}),
            )
            .await?;
        if let Some(o) = found.into_iter().next() {
            let mut v = o.payload;
            if let Some(m) = v.as_object_mut() {
                for f in ["report_tenant", "name", "_scope"] {
                    m.remove(f);
                }
            }
            return Ok(Some(unpack(v)?));
        }
        let Some(old) = self.legacy.get(ctx, report).await? else {
            return Ok(None);
        };
        self.write(ctx, port.as_ref(), &old).await?;
        // Held once: the old store's copy goes.
        if let Err(e) = self.legacy.delete(ctx, report).await {
            tracing::warn!(report, error = %e, "studio-reports: the old store's copy of a moved source stays");
        }
        Ok(Some(old))
    }

    async fn put(&self, ctx: &SecurityContext, source: &ReportSource) -> anyhow::Result<()> {
        if self.returning {
            self.back_to_legacy(ctx, &source.report).await;
            return self.legacy.put(ctx, source).await;
        }
        let Some(port) = self.port() else {
            return self.legacy.put(ctx, source).await;
        };
        port.ensure_type(ctx, &Self::need()).await?;
        self.write(ctx, port.as_ref(), source).await
    }
}

/// A source as a node payload: the plan's text deflated and base64'd, so a
/// plan many times larger than graph-storage's 64 KB payload cap still fits.
pub fn pack(source: &ReportSource) -> anyhow::Result<serde_json::Value> {
    use base64::Engine as _;
    use std::io::Write as _;
    let mut v = serde_json::to_value(source)?;
    if let Some(snap) = v
        .get_mut("snapshot")
        .and_then(serde_json::Value::as_object_mut)
        && let Some(serde_json::Value::String(text)) = snap.remove("text")
    {
        let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::best());
        enc.write_all(text.as_bytes())?;
        let packed = base64::engine::general_purpose::STANDARD.encode(enc.finish()?);
        snap.insert("text_deflate".into(), serde_json::Value::String(packed));
    }
    Ok(v)
}

/// A node payload back as a source; a payload written before compression
/// reads too.
pub fn unpack(mut v: serde_json::Value) -> anyhow::Result<ReportSource> {
    use base64::Engine as _;
    use std::io::Read as _;
    if let Some(snap) = v
        .get_mut("snapshot")
        .and_then(serde_json::Value::as_object_mut)
        && let Some(serde_json::Value::String(packed)) = snap.remove("text_deflate")
    {
        let bytes = base64::engine::general_purpose::STANDARD.decode(packed)?;
        let mut text = String::new();
        flate2::read::DeflateDecoder::new(bytes.as_slice()).read_to_string(&mut text)?;
        snap.insert("text".into(), serde_json::Value::String(text));
    }
    Ok(serde_json::from_value(v)?)
}

#[cfg(feature = "graph")]
mod graph {
    use std::collections::HashSet;
    use std::sync::{Arc, Mutex};

    use anyhow::anyhow;
    use async_trait::async_trait;
    use graph_storage_sdk::GraphStorageClientV1;
    use serde_json::{Value, json};
    use toolkit_security::SecurityContext;
    use uuid::Uuid;

    use super::super::gts;
    use super::super::source::ReportSource;
    use super::ReportStore;

    /// The payload field a deleted source carries, as a domain object's does
    /// (`domain_model::store::DELETED_FIELD`): graph-storage never lets a
    /// deleted node's key be written again, and a source's key is derived
    /// from its report, so deleting the node would forbid ever saving that
    /// report's source again in this organization.
    const DELETED_FIELD: &str = "_deleted";

    pub struct GraphStore {
        client: Arc<dyn GraphStorageClientV1>,
        /// Tenants whose types are registered by this process. Per tenant,
        /// because graph-storage resolves a type in the caller's tenant
        /// scope: a registration made in one organization is not another's.
        registered: Mutex<HashSet<Uuid>>,
    }

    impl GraphStore {
        pub fn new(client: Arc<dyn GraphStorageClientV1>) -> Self {
            Self {
                client,
                registered: Mutex::new(HashSet::new()),
            }
        }

        fn is_registered(&self, tenant: Uuid) -> bool {
            self.registered
                .lock()
                .map(|r| r.contains(&tenant))
                .unwrap_or(false)
        }

        /// Once per tenant and process: registering is idempotent, and cheap
        /// only the first time. A stored type whose schema here changed is
        /// updated in place (`Update`), as every other Studio store does;
        /// under the default (`Reject`) every report write would fail.
        async fn ensure_types(&self, ctx: &SecurityContext) -> anyhow::Result<()> {
            use graph_storage_sdk::models::{
                OnExisting, TypeRegistration, TypeRegistrationOptions,
            };
            let tenant = ctx.subject_tenant_id();
            if self.is_registered(tenant) {
                return Ok(());
            }
            let batch: Vec<TypeRegistration> = gts::graph_node_type_schemas()
                .into_iter()
                .map(|schema| TypeRegistration {
                    type_id: schema
                        .get("$id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .trim_start_matches("gts://")
                        .to_string(),
                    schema,
                })
                .collect();
            let options = TypeRegistrationOptions {
                on_existing: OnExisting::Update,
                ..Default::default()
            };
            self.client
                .register_types_with(ctx, batch, options)
                .await
                .map_err(|e| {
                    anyhow!("register report types: {}", crate::graph_error::explain(&e))
                })?;
            if let Ok(mut r) = self.registered.lock() {
                r.insert(tenant);
            }
            Ok(())
        }

        async fn write(
            &self,
            ctx: &SecurityContext,
            report: &str,
            payload: Value,
        ) -> anyhow::Result<()> {
            use crate::artifact_ingest::sdk::without_nul;
            use graph_storage_sdk::models::{IngestOptions, IngestRequest, NodeSpec};
            self.ensure_types(ctx).await?;
            let node = NodeSpec {
                node_key: gts::source_key(report),
                type_id: gts::graph_type_id(),
                name: Some(report.to_owned()),
                payload: Some(without_nul(payload)),
                expected_version: None,
            };
            self.client
                .ingest(
                    ctx,
                    IngestRequest {
                        nodes: vec![node],
                        edges: Vec::new(),
                        options: IngestOptions {
                            create_phantoms: Some(false),
                            report_per_item: false,
                            embed: Some(false),
                        },
                        replace_scope: None,
                        idempotency_key: None,
                    },
                )
                .await
                .map_err(|e| {
                    anyhow!("graph-storage ingest: {}", crate::graph_error::explain(&e))
                })?;
            Ok(())
        }
    }

    #[async_trait]
    impl ReportStore for GraphStore {
        async fn get(
            &self,
            ctx: &SecurityContext,
            report: &str,
        ) -> anyhow::Result<Option<ReportSource>> {
            use toolkit_odata::ODataQuery;
            self.ensure_types(ctx).await?;
            let key = gts::source_key(report);
            // The one row, by key: `node_key` is a column the projection
            // filters on, so this reads one payload instead of every report
            // the organization has (each carries its compressed plan), and a
            // report past the first page is still found.
            let raw = format!("node_key eq '{}'", key.replace('\'', "''"));
            let filter = toolkit_odata::parse_filter_string(&raw)
                .map_err(|e| anyhow!("report filter `{raw}`: {e}"))?
                .into_expr();
            let page = self
                .client
                .project_nodes(
                    ctx,
                    &[gts::graph_type_id()],
                    // More than one: the key is the same in every tenant, and a
                    // caller reaching several sees each tenant's row.
                    ODataQuery::default().with_filter(filter).with_limit(50),
                )
                .await
                .map_err(|e| anyhow!("graph-storage projection: {e}"))?;
            let tenant = ctx.subject_tenant_id();
            let mut rows: Vec<_> = page
                .items
                .into_iter()
                .filter(|r| r.node_key == key)
                .collect();
            // The caller's own tenant first, as any one of them was before.
            rows.sort_by_key(|r| r.envelope.tenant_id != tenant);
            let Some(row) = rows.into_iter().next() else {
                return Ok(None);
            };
            let Some(payload) = row.payload else {
                return Ok(None);
            };
            if payload.get(DELETED_FIELD).and_then(Value::as_bool) == Some(true) {
                return Ok(None);
            }
            Ok(Some(super::unpack(payload)?))
        }

        /// Marked, not deleted: the key stays writable, so the report can
        /// be given a source again (the `returning` path does exactly that).
        async fn delete(&self, ctx: &SecurityContext, report: &str) -> anyhow::Result<()> {
            if self.get(ctx, report).await?.is_none() {
                return Ok(());
            }
            let mut mark = json!({ "report": report });
            mark[DELETED_FIELD] = Value::Bool(true);
            self.write(ctx, report, mark).await
        }

        async fn put(&self, ctx: &SecurityContext, source: &ReportSource) -> anyhow::Result<()> {
            self.write(ctx, &source.report, super::pack(source)?).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(tenant: u128) -> SecurityContext {
        crate::reports::test_ctx(tenant)
    }

    #[tokio::test]
    async fn a_source_moves_into_the_model_once_and_is_the_gears() {
        let legacy = std::sync::Arc::new(MemoryStore::default());
        let old = ReportSource {
            report: "roadmap".into(),
            board: Some("acme/7".into()),
            ..ReportSource::default()
        };
        legacy.put(&ctx(1), &old).await.unwrap();
        let port = crate::domain_model::port::in_memory();
        let store = ModelStore::with_port(legacy.clone(), std::sync::Arc::clone(&port));
        assert_eq!(
            store.get(&ctx(1), "roadmap").await.unwrap(),
            Some(old.clone())
        );

        let newer = ReportSource {
            board: Some("acme/8".into()),
            ..old.clone()
        };
        store.put(&ctx(1), &newer).await.unwrap();
        assert_eq!(store.get(&ctx(1), "roadmap").await.unwrap(), Some(newer));
        assert_eq!(
            legacy.get(&ctx(1), "roadmap").await.unwrap(),
            None,
            "the old store's copy is gone once moved"
        );
        assert_eq!(
            store.get(&ctx(2), "roadmap").await.unwrap(),
            None,
            "another organization's is not this one's"
        );
        let refused = port
            .upsert(
                &ctx(1),
                "report-source",
                "forged",
                serde_json::json!({"report": "x"}),
            )
            .await
            .unwrap_err();
        assert!(
            refused.to_string().contains("kept by studio-reports"),
            "{refused}"
        );
    }

    #[test]
    fn a_plan_is_kept_compressed_and_reads_back_whole() {
        use crate::reports::source::PlanSnapshot;
        // A plan the size the planning team's grows to, and then some.
        let text: String = (0..3000)
            .map(|i| format!("  user{i}: {{ team: t{}, power: 0.5 }}\n", i % 7))
            .collect();
        let s = ReportSource {
            report: "roadmap".into(),
            snapshot: Some(PlanSnapshot {
                text: text.clone(),
                from: "upload".into(),
                sha: None,
                read_at: "t".into(),
                ..PlanSnapshot::default()
            }),
            ..ReportSource::default()
        };
        let packed = pack(&s).expect("packed");
        let size = serde_json::to_string(&packed).unwrap().len();
        assert!(text.len() > 100_000, "the plan is {} bytes", text.len());
        assert!(size < 65_536, "the payload is {size} bytes");
        assert!(packed.pointer("/snapshot/text").is_none());
        assert_eq!(unpack(packed).expect("unpacked"), s);
        // Written before compression: still reads.
        let old = serde_json::to_value(&s).unwrap();
        assert_eq!(unpack(old).unwrap(), s);
        // An upload is never kept as such.
        let with_upload = ReportSource {
            plan_yaml: Some("a: 1".into()),
            ..s.clone()
        };
        assert!(pack(&with_upload).unwrap().get("plan_yaml").is_none());
    }

    #[tokio::test]
    async fn a_source_is_the_organizations_and_the_reports() {
        let store = MemoryStore::default();
        assert!(store.get(&ctx(1), "roadmap").await.unwrap().is_none());
        let s = ReportSource {
            report: "roadmap".into(),
            board: Some("o/48".into()),
            ..ReportSource::default()
        };
        store.put(&ctx(1), &s).await.unwrap();
        assert_eq!(
            store.get(&ctx(1), "roadmap").await.unwrap(),
            Some(s.clone())
        );
        // Another organization does not see it, nor does another report.
        assert!(store.get(&ctx(2), "roadmap").await.unwrap().is_none());
        assert!(store.get(&ctx(1), "other").await.unwrap().is_none());
        // A second put replaces the first.
        let s2 = ReportSource {
            board: Some("o/49".into()),
            ..s
        };
        store.put(&ctx(1), &s2).await.unwrap();
        assert_eq!(
            store
                .get(&ctx(1), "roadmap")
                .await
                .unwrap()
                .and_then(|s| s.board),
            Some("o/49".into())
        );
    }
}

/// The graph-backed store against graph-storage itself, in process.
#[cfg(all(test, feature = "graph"))]
mod graph_tests {
    use std::sync::Arc;

    use graph_storage_sdk::models::TypeRegistration;
    use serde_json::{Value, json};
    use uuid::Uuid;

    use super::super::gts;
    use super::super::source::ReportSource;
    use super::{GraphStore, ReportStore};
    use crate::test_graph::{client, ctx};

    fn source(board: &str) -> ReportSource {
        ReportSource {
            report: "roadmap".into(),
            board: Some(board.into()),
            ..ReportSource::default()
        }
    }

    /// Deleting marks the source: the key stays writable, so the report can
    /// be given a source again, which a deleted node's key never could.
    #[tokio::test]
    async fn a_deleted_source_can_be_saved_again() {
        let store = GraphStore::new(client());
        let ctx = ctx(Uuid::now_v7());
        store.put(&ctx, &source("o/1")).await.unwrap();
        store.delete(&ctx, "roadmap").await.unwrap();
        assert_eq!(store.get(&ctx, "roadmap").await.unwrap(), None);
        store
            .delete(&ctx, "roadmap")
            .await
            .expect("deleting twice is fine");
        store
            .put(&ctx, &source("o/2"))
            .await
            .expect("the key is writable");
        assert_eq!(
            store.get(&ctx, "roadmap").await.unwrap(),
            Some(source("o/2"))
        );
    }

    /// Types are registered in each organization that writes, not once for
    /// the process.
    #[tokio::test]
    async fn every_organization_gets_its_types() {
        let store = GraphStore::new(client());
        let (a, b) = (ctx(Uuid::now_v7()), ctx(Uuid::now_v7()));
        store.put(&a, &source("a/1")).await.unwrap();
        store
            .put(&b, &source("b/1"))
            .await
            .expect("the second tenant writes");
        assert_eq!(
            store
                .get(&b, "roadmap")
                .await
                .unwrap()
                .and_then(|s| s.board),
            Some("b/1".into())
        );
        assert_eq!(
            store
                .get(&a, "roadmap")
                .await
                .unwrap()
                .and_then(|s| s.board),
            Some("a/1".into())
        );
    }

    /// A type stored under an older schema is updated in place, not refused:
    /// under `Reject` every report write would fail after a schema change.
    #[tokio::test]
    async fn a_type_stored_under_another_schema_is_updated_not_refused() {
        let client = client();
        let ctx = ctx(Uuid::now_v7());
        let mut older: Value = gts::graph_node_type_schemas().remove(0);
        older["description"] = json!("Where a report reads from (as first registered).");
        let type_id = gts::graph_type_id();
        client
            .register_types(
                &ctx,
                vec![TypeRegistration {
                    type_id: type_id.clone(),
                    schema: older,
                }],
            )
            .await
            .expect("the older schema registers");
        assert!(
            client
                .register_types(
                    &ctx,
                    vec![TypeRegistration {
                        type_id,
                        schema: gts::graph_node_type_schemas().remove(0),
                    }],
                )
                .await
                .is_err(),
            "the default refuses a changed schema"
        );
        let store = GraphStore::new(Arc::clone(&client));
        store
            .put(&ctx, &source("o/1"))
            .await
            .expect("the store updates it");
        assert!(store.get(&ctx, "roadmap").await.unwrap().is_some());
    }
}
