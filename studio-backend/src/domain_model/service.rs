//! The domain-model service: the ontology plus the object store.
//!
//! It answers the three goals directly — create objects of the domain types,
//! extend a type with a new field, and read the ontology back so the frontend
//! can be regenerated from the stored model.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::gts;
use super::ontology::{FieldSpec, ModelEdgeKind, Ontology};
use super::store::{DomainStore, EdgeUpsert, EdgeView, NodeUpsert, ObjectNode};

/// The outcome of creating an object.
#[derive(Debug, Clone)]
pub struct CreatedObject {
    pub type_id: String,
    pub instance_id: String,
}

/// One relation as registered — its verb, edge type id and endpoint typing.
#[derive(Debug, Clone)]
pub struct RelationEntry {
    pub relation_kind: String,
    pub type_id: String,
    pub src_type_ids: Vec<String>,
    pub dst_type_ids: Vec<String>,
}

/// The relation catalog: relation verbs with their endpoints, every declared
/// relation (with cardinality), plus the targets not yet resolvable.
#[derive(Debug, Clone)]
pub struct RelationCatalog {
    pub relations: Vec<RelationEntry>,
    pub declared: Vec<super::ontology::DeclaredRelation>,
    pub unresolved: Vec<(String, String)>,
}

/// One model-graph edge with its properties (for `declares`: name / verb /
/// cardinality / label; for `inherits`: the base).
#[derive(Debug, Clone)]
pub struct ModelGraphEdge {
    pub type_id: String,
    pub from: String,
    pub to: String,
    pub payload: Value,
}

/// One created object as a graph node (its entity type + bucket for colouring,
/// plus the full stored payload — the object's document in Graph Storage).
#[derive(Debug, Clone)]
pub struct ObjectGraphNode {
    pub instance_id: String,
    pub entity: String,
    pub bucket: String,
    pub name: String,
    pub value: Value,
}

/// What a model-graph sync wrote.
#[derive(Debug, Clone)]
pub struct ModelSyncReport {
    /// Object-type nodes upserted (one per entity).
    pub object_types: u64,
    /// `inherits` edges upserted.
    pub inherits: u64,
    /// `declares` edges upserted.
    pub declares: u64,
    /// Endpoints skipped because they named no modeled entity (no dangling
    /// edge was produced).
    pub skipped_endpoints: u64,
}

/// The outcome of importing an uploaded model.
#[derive(Debug, Clone)]
pub struct ImportSummary {
    pub entities: u64,
    pub buckets: u64,
    pub node_types: u64,
    pub edge_types: u64,
}

pub struct DomainModelService {
    /// The live ontology (mutable: a field can be appended to a type, or the
    /// whole model replaced by an uploaded one).
    ontology: Mutex<Ontology>,
    store: Arc<dyn DomainStore>,
    /// Which ontology generation each tenant's types are registered for. The
    /// type registry is tenant-scoped, so this is keyed by tenant rather than
    /// being a single flag.
    registered: Mutex<HashMap<Uuid, u64>>,
    /// Bumped whenever the type *set* changes — that is, on an import. Adding a
    /// field to a type does not change the set, so it does not bump.
    generation: AtomicU64,
}

impl DomainModelService {
    pub fn new(store: Arc<dyn DomainStore>) -> Self {
        Self {
            ontology: Mutex::new(Ontology::load()),
            store,
            registered: Mutex::new(HashMap::new()),
            generation: AtomicU64::new(0),
        }
    }

    /// Import an uploaded model document (the domain-entity shape), making it
    /// the active ontology and registering its types. This is what the frontend
    /// upload posts — the model is loaded through the UI rather than only from
    /// the embedded default. Idempotent per type; new types are added.
    pub async fn import_model(
        &self,
        ctx: &SecurityContext,
        doc: Value,
    ) -> anyhow::Result<ImportSummary> {
        let ontology = Ontology::from_value(doc).map_err(|e| anyhow::anyhow!("{e}"))?;
        let summary = ImportSummary {
            entities: ontology.entities().len() as u64,
            buckets: ontology.bucket_count() as u64,
            node_types: ontology.node_types().len() as u64,
            edge_types: ontology.edge_types().len() as u64,
        };
        {
            let mut o = self
                .ontology
                .lock()
                .map_err(|_| anyhow::anyhow!("ontology lock poisoned"))?;
            *o = ontology;
        }
        // A new model is a new type set, so every tenant's registration is
        // stale: bump the generation, which is what `ensure_types` keys on.
        self.generation.fetch_add(1, Ordering::AcqRel);
        // Register the uploaded model's types with the graph + type-registry.
        self.ensure_types(ctx).await?;
        Ok(summary)
    }

    /// The whole ontology document — the source the frontend regenerates from.
    pub fn ontology_document(&self) -> anyhow::Result<Value> {
        let o = self
            .ontology
            .lock()
            .map_err(|_| anyhow::anyhow!("ontology lock poisoned"))?;
        Ok(o.document().clone())
    }

    /// The relation catalog — how relations are synced into the graph and the
    /// type-registry: each relation kind with its endpoint typing, plus the
    /// cross-bucket targets still pending a wider sync.
    pub fn relation_catalog(&self) -> anyhow::Result<RelationCatalog> {
        let o = self
            .ontology
            .lock()
            .map_err(|_| anyhow::anyhow!("ontology lock poisoned"))?;
        let relations = o
            .edge_types()
            .into_iter()
            .map(|e| RelationEntry {
                relation_kind: e.relation_kind,
                type_id: e.type_id,
                src_type_ids: e.src_type_ids,
                dst_type_ids: e.dst_type_ids,
            })
            .collect();
        let declared = o.declared_relations();
        let unresolved = o.unresolved_relation_targets();
        Ok(RelationCatalog {
            relations,
            declared,
            unresolved,
        })
    }

    /// Register every domain node and edge type with the store, once per
    /// (tenant, ontology generation).
    ///
    /// Registration is idempotent but far from free: it ships every node and
    /// edge schema the model declares — for the core model, 145 of them — so
    /// doing it ahead of each write made a single object creation cost ~470 ms
    /// against ~35 ms for the equivalent ingest, and capped the endpoint at
    /// ~15 objects/s no matter the concurrency. The type *set* only changes
    /// when a model is imported, which bumps `generation`; adding a field to a
    /// type leaves the set alone (the registered schema is open).
    ///
    /// Two writers racing a cold tenant may both register — the call is
    /// idempotent and converges, which is the cheaper trade than holding a lock
    /// across the await.
    async fn ensure_types(&self, ctx: &SecurityContext) -> anyhow::Result<()> {
        let tenant = ctx.subject_tenant_id();
        let generation = self.generation.load(Ordering::Acquire);
        {
            let done = self
                .registered
                .lock()
                .map_err(|_| anyhow::anyhow!("registration cache lock poisoned"))?;
            if done.get(&tenant) == Some(&generation) {
                return Ok(());
            }
        }
        let (node_types, edge_types) = {
            let o = self
                .ontology
                .lock()
                .map_err(|_| anyhow::anyhow!("ontology lock poisoned"))?;
            (o.node_types(), o.edge_types())
        };
        self.store
            .register_types(ctx, &node_types, &edge_types)
            .await?;
        self.registered
            .lock()
            .map_err(|_| anyhow::anyhow!("registration cache lock poisoned"))?
            .insert(tenant, generation);
        Ok(())
    }

    /// Create (or upsert) an object of a domain type. `type_ref` may be an
    /// ontology id (`role-assignment`), a node type id
    /// (`gts.cf.studio.domain.role_assignment.v1~`) or its leaf. `key` is a
    /// caller-chosen stable key; the same `(type, key)` upserts.
    pub async fn create_object(
        &self,
        ctx: &SecurityContext,
        type_ref: &str,
        key: &str,
        scope: Option<&str>,
        mut payload: Value,
    ) -> anyhow::Result<CreatedObject> {
        let entity_id = {
            let o = self
                .ontology
                .lock()
                .map_err(|_| anyhow::anyhow!("ontology lock poisoned"))?;
            o.resolve_entity_id(type_ref)
                .ok_or_else(|| anyhow::anyhow!("unknown domain type: {type_ref}"))?
        };
        let type_id = gts::node_type_id(&entity_id);
        // Types are tenant/platform-shared; an object is scoped by an optional
        // workspace/project key, so the same `key` in two scopes is two objects
        // and a scoped listing shows only its own. The scope is folded into the
        // instance id and tagged on the payload (`_scope`) for filtering.
        let scope = scope.map(str::trim).filter(|s| !s.is_empty());
        let instance_key = match scope {
            Some(s) => format!("{s}|{key}"),
            None => key.to_string(),
        };
        let instance_id = gts::instance_id(&type_id, &instance_key);
        if let Some(s) = scope
            && let Some(obj) = payload.as_object_mut()
        {
            obj.insert("_scope".to_string(), Value::String(s.to_string()));
        }
        let name = payload
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string);

        self.ensure_types(ctx).await?;
        self.store
            .create_object(ctx, &type_id, &instance_id, name, payload)
            .await?;
        Ok(CreatedObject {
            type_id,
            instance_id,
        })
    }

    /// Create (or upsert) a relation between two objects, addressed by their
    /// instance ids. `relation_kind` is one of the ontology's relation verbs
    /// (`member`, `owns`, `references`, `composes`).
    pub async fn create_relation(
        &self,
        ctx: &SecurityContext,
        relation_kind: &str,
        from: &str,
        to: &str,
    ) -> anyhow::Result<String> {
        let known = {
            let o = self
                .ontology
                .lock()
                .map_err(|_| anyhow::anyhow!("ontology lock poisoned"))?;
            o.edge_types()
                .into_iter()
                .any(|e| e.relation_kind == relation_kind)
        };
        if !known {
            return Err(anyhow::anyhow!("unknown relation kind: {relation_kind}"));
        }
        let edge_type_id = gts::edge_type_id(relation_kind);
        self.ensure_types(ctx).await?;
        self.store
            .create_relation(ctx, &edge_type_id, from, to)
            .await?;
        Ok(edge_type_id)
    }

    /// List objects, optionally of one type and/or one scope. `None` type =
    /// every domain type; `None` scope = every scope.
    pub async fn list_objects(
        &self,
        ctx: &SecurityContext,
        type_ref: Option<&str>,
        scope: Option<&str>,
    ) -> anyhow::Result<Vec<ObjectNode>> {
        let type_ids: Vec<String> = {
            let o = self
                .ontology
                .lock()
                .map_err(|_| anyhow::anyhow!("ontology lock poisoned"))?;
            match type_ref.map(str::trim).filter(|s| !s.is_empty()) {
                None => o.node_types().into_iter().map(|n| n.type_id).collect(),
                Some(r) => match o.resolve_entity_id(r) {
                    Some(entity_id) => vec![gts::node_type_id(&entity_id)],
                    // Unknown type -> no rows, rather than every row.
                    None => Vec::new(),
                },
            }
        };
        if type_ids.is_empty() {
            return Ok(Vec::new());
        }
        self.ensure_types(ctx).await?;
        let scope = scope.map(str::trim).filter(|s| !s.is_empty());
        self.store.list_objects(ctx, &type_ids, scope, None).await
    }

    /// Sync the model *as a graph*: materialize one object-type node per entity
    /// and the `inherits` / `declares` edges among them, so the domain model —
    /// with its relations — is itself queryable in the graph. Idempotent: node
    /// keys and edge endpoints are deterministic, so a re-sync converges.
    pub async fn sync_model(&self, ctx: &SecurityContext) -> anyhow::Result<ModelSyncReport> {
        // Registers the instance types and the meta layer (object_type node +
        // inherits/declares edges) the sync writes into.
        self.ensure_types(ctx).await?;

        let graph = {
            let o = self
                .ontology
                .lock()
                .map_err(|_| anyhow::anyhow!("ontology lock poisoned"))?;
            o.model_graph()
        };

        let node_key = |entity_id: &str| gts::instance_id(gts::META_OBJECT_TYPE, entity_id);

        let nodes: Vec<NodeUpsert> = graph
            .nodes
            .iter()
            .map(|n| NodeUpsert {
                type_id: gts::META_OBJECT_TYPE.to_string(),
                node_key: node_key(&n.entity_id),
                name: Some(n.name.clone()),
                payload: n.payload.clone(),
            })
            .collect();

        let edges: Vec<EdgeUpsert> = graph
            .edges
            .iter()
            .map(|e| EdgeUpsert {
                type_id: match e.kind {
                    ModelEdgeKind::Inherits => gts::META_INHERITS.to_string(),
                    ModelEdgeKind::Declares => gts::META_DECLARES.to_string(),
                },
                from: node_key(&e.from_entity),
                to: node_key(&e.to_entity),
                discriminator: e.discriminator.clone(),
                payload: Some(e.payload.clone()),
            })
            .collect();

        let inherits = graph
            .edges
            .iter()
            .filter(|e| e.kind == ModelEdgeKind::Inherits)
            .count() as u64;
        let declares = graph
            .edges
            .iter()
            .filter(|e| e.kind == ModelEdgeKind::Declares)
            .count() as u64;

        // Nodes first, then edges: every endpoint exists before its edge. The
        // store's return is the ingest *delta* (0 on an idempotent re-sync), so
        // report what was synced (present in the graph after this call), which
        // is stable across re-runs.
        self.store.upsert_nodes(ctx, &nodes).await?;
        self.store.upsert_edges(ctx, &edges).await?;

        Ok(ModelSyncReport {
            object_types: nodes.len() as u64,
            inherits,
            declares,
            skipped_endpoints: graph.skipped as u64,
        })
    }

    /// Read the model graph back *out of the graph store* (not the embedded
    /// ontology): the `object_type` nodes and their `inherits`/`declares` edges
    /// as materialized by [`Self::sync_model`]. This is the read side of the
    /// sync — proof the model round-trips through Graph Storage, and the data a
    /// visualization renders.
    pub async fn model_graph_view(
        &self,
        ctx: &SecurityContext,
    ) -> anyhow::Result<(Vec<ObjectNode>, Vec<ModelGraphEdge>)> {
        self.ensure_types(ctx).await?;
        // Nodes are read back from the graph (proof they are stored); edges come
        // from the ontology so they carry their properties (verb / cardinality /
        // label / name) — adjacency reads drop the payload, and the ontology is
        // 1:1 with what the sync wrote. Endpoints are the same deterministic node
        // keys the sync used, so they line up with the graph nodes.
        let nodes = self
            .store
            .list_objects(ctx, &[gts::META_OBJECT_TYPE.to_string()], None, None)
            .await?;
        let graph = {
            let o = self
                .ontology
                .lock()
                .map_err(|_| anyhow::anyhow!("ontology lock poisoned"))?;
            o.model_graph()
        };
        let edges = graph
            .edges
            .iter()
            .map(|e| ModelGraphEdge {
                type_id: match e.kind {
                    ModelEdgeKind::Inherits => gts::META_INHERITS.to_string(),
                    ModelEdgeKind::Declares => gts::META_DECLARES.to_string(),
                },
                from: gts::instance_id(gts::META_OBJECT_TYPE, &e.from_entity),
                to: gts::instance_id(gts::META_OBJECT_TYPE, &e.to_entity),
                payload: e.payload.clone(),
            })
            .collect();
        Ok((nodes, edges))
    }

    /// The graph of created *objects* (instances) and the relations between
    /// them (`member`/`owns`/…), read out of Graph Storage — the instance layer,
    /// distinct from the type/model graph. Nodes carry their entity type and
    /// bucket for colouring.
    ///
    /// Bounded: a visualization wants a subgraph, and the instance layer has no
    /// natural ceiling — it grew to 14 657 nodes on a load run, which the
    /// unbounded version answered in 26 s with every payload inlined. `limit`
    /// caps the nodes; `type_ref` and `scope` narrow which ones, with the same
    /// meaning they have on `GET /objects`.
    pub async fn objects_graph(
        &self,
        ctx: &SecurityContext,
        limit: usize,
        type_ref: Option<&str>,
        scope: Option<&str>,
    ) -> anyhow::Result<(Vec<ObjectGraphNode>, Vec<EdgeView>, bool)> {
        self.ensure_types(ctx).await?;
        // type ids to project + a map back to (entity id, bucket) for labels.
        let (type_ids, meta) = {
            let o = self
                .ontology
                .lock()
                .map_err(|_| anyhow::anyhow!("ontology lock poisoned"))?;
            let type_ids: Vec<String> = match type_ref.map(str::trim).filter(|s| !s.is_empty()) {
                None => o.node_types().into_iter().map(|n| n.type_id).collect(),
                // Unknown type -> no rows, rather than every row.
                Some(r) => o
                    .resolve_entity_id(r)
                    .map(|id| vec![gts::node_type_id(&id)])
                    .unwrap_or_default(),
            };
            let mut meta: std::collections::HashMap<String, (String, String)> =
                std::collections::HashMap::new();
            for e in o.entities() {
                if let Some(id) = e.get("id").and_then(Value::as_str) {
                    let bucket = e
                        .get("bucket")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    meta.insert(gts::node_type_id(id), (id.to_string(), bucket));
                }
            }
            (type_ids, meta)
        };
        // One over the bound: if it comes back, there was more to show.
        let scope = scope.map(str::trim).filter(|s| !s.is_empty());
        let mut objs = self
            .store
            .list_objects(ctx, &type_ids, scope, Some(limit + 1))
            .await?;
        let truncated = objs.len() > limit;
        objs.truncate(limit);
        let nodes = objs
            .iter()
            .map(|o| {
                let (entity, bucket) = meta.get(&o.type_id).cloned().unwrap_or_default();
                let name = o
                    .value
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(&o.instance_id)
                    .to_string();
                ObjectGraphNode {
                    instance_id: o.instance_id.clone(),
                    entity,
                    bucket,
                    name,
                    value: o.value.clone(),
                }
            })
            .collect();
        let seeds: std::collections::HashSet<String> =
            objs.iter().map(|o| o.instance_id.clone()).collect();
        let seed_list: Vec<String> = objs.iter().map(|o| o.instance_id.clone()).collect();
        let edges = self
            .store
            .read_edges(ctx, &seed_list)
            .await?
            .into_iter()
            // Domain relations only, and only those whose both endpoints are on
            // the page — a bounded read must not hand back dangling edges.
            .filter(|e| {
                e.type_id.contains(".domainrel.")
                    && seeds.contains(&e.from)
                    && seeds.contains(&e.to)
            })
            .collect();
        Ok((nodes, edges, truncated))
    }

    /// Extend a domain type with a new field. Returns the updated entity. The
    /// registered graph type is open, so this is a pure ontology edit — no
    /// migration, no re-registration.
    pub fn add_field(&self, entity_ref: &str, field: FieldSpec) -> anyhow::Result<Value> {
        let mut o = self
            .ontology
            .lock()
            .map_err(|_| anyhow::anyhow!("ontology lock poisoned"))?;
        let entity_id = o
            .resolve_entity_id(entity_ref)
            .ok_or_else(|| anyhow::anyhow!("unknown domain type: {entity_ref}"))?;
        o.add_field(&entity_id, field)
            .map_err(|e| anyhow::anyhow!("{e}"))
    }
}
