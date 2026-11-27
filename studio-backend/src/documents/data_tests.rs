//! The gear's records kept as domain objects: the move out of the tables,
//! upserts that keep what the tables kept, long fields, cascades and pages.
//!
//! The model is the real one, in memory; the tables are the real Postgres of
//! [`super::repo_tests`].

#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::sync::Arc;

use serde_json::json;
use time::{Duration, OffsetDateTime};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::data::DocumentsData;
use super::entity::{analysis, document, document_binding};
use super::repo::{DocScope, analysis_row_id, binding_row_id};
use crate::domain_model::port::{DomainObjects, in_memory};

fn ctx() -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(1))
        .subject_tenant_id(Uuid::from_u128(1))
        .token_scopes(vec!["*".to_string()])
        .build()
        .expect("test security context")
}

struct Rig {
    data: DocumentsData,
    repo: Arc<super::repo::DocumentsRepo>,
    port: Arc<dyn DomainObjects>,
    ws: Uuid,
}

async fn rig() -> Rig {
    let repo = Arc::new(super::repo_tests::repo().await);
    let port = in_memory();
    Rig {
        data: DocumentsData::with_port(Arc::clone(&repo), Arc::clone(&port)),
        repo,
        port,
        ws: Uuid::new_v4(),
    }
}

fn at(seconds: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp(1_790_000_000).unwrap() + Duration::seconds(seconds)
}

fn doc(
    ws: Uuid,
    project: Option<Uuid>,
    title: &str,
    content: &str,
    updated: i64,
) -> document::Model {
    document::Model {
        id: Uuid::new_v4(),
        tenant_id: ws,
        project_id: project,
        type_key: "prd".to_string(),
        title: title.to_string(),
        content: content.to_string(),
        status: 0,
        conforms: false,
        validation: "{}".to_string(),
        capabilities: "[]".to_string(),
        requirements: "[]".to_string(),
        inferred_capabilities: "[]".to_string(),
        created_by: "someone".to_string(),
        created_at: at(0),
        updated_at: at(updated),
    }
}

fn binding(ws: Uuid, node: &str, path: &str, created: i64) -> document_binding::Model {
    document_binding::Model {
        id: binding_row_id(ws, None, node),
        tenant_id: ws,
        project_id: None,
        node_id: node.to_string(),
        path: path.to_string(),
        type_key: Some("prd".to_string()),
        state: "detected".to_string(),
        confidence: Some(0.5),
        source: Some("heuristic".to_string()),
        candidates: "[]".to_string(),
        conforms: Some(false),
        validation: "{}".to_string(),
        capabilities: "[]".to_string(),
        requirements: "[]".to_string(),
        inferred_capabilities: "[]".to_string(),
        content_sha: "sha".to_string(),
        confirmed_by: None,
        created_at: at(created),
        updated_at: at(created),
    }
}

fn verdict(ws: Uuid, binding_id: Uuid, detector: &str) -> analysis::Model {
    analysis::Model {
        id: analysis_row_id(binding_id, detector),
        tenant_id: ws,
        document_id: None,
        binding_id: Some(binding_id),
        detector: detector.to_string(),
        state: "passed".to_string(),
        task_id: None,
        summary: String::new(),
        created_at: at(0),
        updated_at: at(0),
    }
}

#[tokio::test]
async fn what_the_tables_held_moves_on_the_first_touch_and_only_then() {
    let r = rig().await;
    r.repo
        .upsert_binding(binding(r.ws, "n-a", "docs/a.md", 0))
        .await
        .unwrap();
    r.repo
        .upsert_binding(binding(r.ws, "n-b", "docs/b.md", 0))
        .await
        .unwrap();

    let (rows, total) = r
        .data
        .list_bindings(&ctx(), r.ws, DocScope::WorkspaceLevel, 0, None)
        .await
        .unwrap();
    assert_eq!(total, 2);
    let paths: Vec<&str> = rows.iter().map(|b| b.path.as_str()).collect();
    assert_eq!(
        paths,
        ["docs/a.md", "docs/b.md"],
        "in path order, as the table answered"
    );
    let (left, _) = r
        .repo
        .list_bindings(r.ws, DocScope::WorkspaceLevel, 0, None)
        .await
        .unwrap();
    assert!(
        left.is_empty(),
        "the tables' copies are dropped once the model holds them"
    );

    // The model answers now: a row the table gains later is not read.
    r.repo
        .upsert_binding(binding(r.ws, "n-c", "docs/c.md", 0))
        .await
        .unwrap();
    let (_, total) = r
        .data
        .list_bindings(&ctx(), r.ws, DocScope::WorkspaceLevel, 0, None)
        .await
        .unwrap();
    assert_eq!(total, 2);
}

#[tokio::test]
async fn an_upsert_changes_what_the_table_would_and_keeps_the_rest() {
    let r = rig().await;
    r.data
        .upsert_binding(&ctx(), binding(r.ws, "n-a", "docs/a.md", 10))
        .await
        .unwrap();
    let mut again = binding(r.ws, "n-a", "docs/renamed.md", 99);
    again.state = "confirmed".to_string();
    r.data.upsert_binding(&ctx(), again.clone()).await.unwrap();

    let got = r
        .data
        .get_binding(&ctx(), r.ws, again.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(got.path, "docs/renamed.md");
    assert_eq!(got.state, "confirmed");
    assert_eq!(got.updated_at, at(99));
    assert_eq!(
        got.created_at,
        at(10),
        "a re-classified file keeps the date it appeared"
    );
}

#[tokio::test]
async fn a_long_document_is_kept_in_pieces_and_read_back_whole() {
    let r = rig().await;
    let long: String = "Требование: система хранит документы. ".repeat(6_000);
    assert!(long.len() > 200 * 1024);
    let d = doc(r.ws, None, "Long", &long, 1);
    r.data.upsert_doc(&ctx(), d.clone()).await.unwrap();

    let (stored, _) = r
        .port
        .query(&ctx(), json!({"type": "studio-document", "where": {"id": {"_eq": format!("studio-document:{}", d.id)}}}))
        .await
        .unwrap();
    assert!(
        stored[0].payload["content"].get("$chunks").is_some(),
        "{}",
        stored[0].payload
    );

    let got = r.data.get_doc(&ctx(), r.ws, d.id).await.unwrap().unwrap();
    assert_eq!(got.content, long);

    // Shorter again: the old pieces are not read into it.
    let mut short = d.clone();
    short.content = "short".to_string();
    r.data.upsert_doc(&ctx(), short).await.unwrap();
    let got = r.data.get_doc(&ctx(), r.ws, d.id).await.unwrap().unwrap();
    assert_eq!(got.content, "short");
}

#[tokio::test]
async fn deleting_a_binding_takes_its_verdicts() {
    let r = rig().await;
    let a = binding(r.ws, "n-a", "docs/a.md", 0);
    let b = binding(r.ws, "n-b", "docs/b.md", 0);
    r.data
        .upsert_bindings(&ctx(), &[a.clone(), b.clone()])
        .await
        .unwrap();
    r.data
        .upsert_analysis(&ctx(), verdict(r.ws, a.id, "purpose"))
        .await
        .unwrap();
    r.data
        .upsert_analysis(&ctx(), verdict(r.ws, b.id, "purpose"))
        .await
        .unwrap();

    assert_eq!(
        r.data
            .delete_bindings(&ctx(), r.ws, &[a.id, Uuid::new_v4()])
            .await
            .unwrap(),
        1
    );
    assert!(
        r.data
            .list_binding_analyses(&ctx(), r.ws, &[a.id])
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        r.data
            .list_binding_analyses(&ctx(), r.ws, &[b.id])
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(
        !r.data.delete_binding(&ctx(), r.ws, a.id).await.unwrap(),
        "already gone"
    );
}

#[tokio::test]
async fn documents_page_newest_first_within_their_scope() {
    let r = rig().await;
    let project = Uuid::new_v4();
    let other = Uuid::new_v4();
    let old = doc(r.ws, None, "old", "x", 1);
    let mid = doc(r.ws, Some(project), "mid", "x", 2);
    let new = doc(r.ws, None, "new", "x", 3);
    let elsewhere = doc(r.ws, Some(other), "elsewhere", "x", 4);
    for d in [&old, &mid, &new, &elsewhere] {
        r.data.upsert_doc(&ctx(), d.clone()).await.unwrap();
    }

    let (page, total) = r
        .data
        .list_docs(&ctx(), r.ws, DocScope::Effective(project), 1, Some(1))
        .await
        .unwrap();
    assert_eq!(
        total, 3,
        "the workspace's and this project's, not another's"
    );
    assert_eq!(
        page.iter().map(|d| d.title.as_str()).collect::<Vec<_>>(),
        ["mid"]
    );

    let (all, _) = r
        .data
        .list_docs(&ctx(), r.ws, DocScope::WorkspaceLevel, 0, None)
        .await
        .unwrap();
    assert_eq!(
        all.iter().map(|d| d.title.as_str()).collect::<Vec<_>>(),
        ["new", "old"]
    );

    assert!(r.data.delete_doc(&ctx(), r.ws, old.id).await.unwrap());
    assert!(!r.data.delete_doc(&ctx(), r.ws, old.id).await.unwrap());
    let found = r
        .data
        .existing_doc_ids(&ctx(), r.ws, &[old.id, new.id])
        .await
        .unwrap();
    assert_eq!(found.into_iter().collect::<Vec<_>>(), [new.id]);
}

#[tokio::test]
async fn a_gear_record_is_refused_to_the_generic_object_writes() {
    let r = rig().await;
    let d = doc(r.ws, None, "Kept", "x", 1);
    r.data.upsert_doc(&ctx(), d.clone()).await.unwrap();

    let forged = r
        .port
        .upsert(
            &ctx(),
            "studio-document",
            "forged",
            json!({"title": "Forged"}),
        )
        .await
        .unwrap_err();
    assert!(
        forged.to_string().contains("kept by studio-documents"),
        "{forged}"
    );
    let (stored, _) = r
        .port
        .query(
            &ctx(),
            json!({"type": "studio-document", "where": {"title": {"_eq": "Kept"}}}),
        )
        .await
        .unwrap();
    let removed = r
        .port
        .delete(&ctx(), &stored[0].instance_id)
        .await
        .unwrap_err();
    assert!(removed.to_string().contains("kept by"), "{removed}");
    assert!(r.data.get_doc(&ctx(), r.ws, d.id).await.unwrap().is_some());
}

#[tokio::test]
async fn switching_back_to_tables_moves_the_rows_back_and_out_of_the_model() {
    let r = rig().await;
    let d = doc(r.ws, None, "Round trip", "body", 5);
    r.data.upsert_doc(&ctx(), d.clone()).await.unwrap();
    r.data
        .upsert_binding(&ctx(), binding(r.ws, "n-r", "docs/r.md", 0))
        .await
        .unwrap();

    let tables = DocumentsData::back_to_tables_with(
        std::sync::Arc::clone(&r.repo),
        std::sync::Arc::clone(&r.port),
    );
    let (docs, total) = tables
        .list_docs(&ctx(), r.ws, DocScope::WorkspaceLevel, 0, None)
        .await
        .unwrap();
    assert_eq!(total, 1);
    assert_eq!(docs[0].title, "Round trip");
    let (bindings, _) = r
        .repo
        .list_bindings(r.ws, DocScope::WorkspaceLevel, 0, None)
        .await
        .unwrap();
    assert_eq!(
        bindings.len(),
        1,
        "every table came back, not only the one asked about"
    );
    let (left, _) = r
        .port
        .query(
            &ctx(),
            json!({"type": "studio-document", "where": {"tenant_id": {"_eq": r.ws}}}),
        )
        .await
        .unwrap();
    assert!(left.is_empty(), "the model keeps no copy");
}

// ── A table of projects: counted together, the same as one by one ─────────

/// The model, counting what the table asks it: each query and aggregate is
/// a statement (or a few) the read model runs.
struct Counting {
    inner: Arc<dyn DomainObjects>,
    asked: std::sync::atomic::AtomicUsize,
}

#[async_trait::async_trait]
impl DomainObjects for Counting {
    async fn upsert(
        &self,
        ctx: &SecurityContext,
        entity: &str,
        key: &str,
        payload: serde_json::Value,
    ) -> anyhow::Result<String> {
        self.inner.upsert(ctx, entity, key, payload).await
    }
    async fn list(
        &self,
        ctx: &SecurityContext,
        entity: &str,
    ) -> anyhow::Result<Vec<crate::domain_model::port::StoredObject>> {
        self.inner.list(ctx, entity).await
    }
    async fn ensure_type(
        &self,
        ctx: &SecurityContext,
        need: &crate::domain_model::port::TypeNeed,
    ) -> anyhow::Result<()> {
        self.inner.ensure_type(ctx, need).await
    }
    async fn put_objects(
        &self,
        ctx: &SecurityContext,
        entity: &str,
        objects: Vec<crate::domain_model::port::OwnedObject>,
    ) -> anyhow::Result<usize> {
        self.inner.put_objects(ctx, entity, objects).await
    }
    async fn remove_objects(
        &self,
        ctx: &SecurityContext,
        entity: &str,
        ids: Vec<String>,
    ) -> anyhow::Result<usize> {
        self.inner.remove_objects(ctx, entity, ids).await
    }
    async fn query(
        &self,
        ctx: &SecurityContext,
        body: serde_json::Value,
    ) -> anyhow::Result<(Vec<crate::domain_model::port::StoredObject>, usize)> {
        self.asked.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.inner.query(ctx, body).await
    }
    async fn aggregate(
        &self,
        ctx: &SecurityContext,
        body: serde_json::Value,
    ) -> anyhow::Result<(Vec<(Vec<serde_json::Value>, u64)>, usize)> {
        self.asked.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.inner.aggregate(ctx, body).await
    }
}

#[tokio::test]
async fn a_workspaces_projects_are_counted_together_as_one_by_one() {
    use super::spec_rows::{BindingState, summary};
    use std::sync::atomic::Ordering;

    let repo = Arc::new(super::repo_tests::repo().await);
    let counting = Arc::new(Counting {
        inner: in_memory(),
        asked: std::sync::atomic::AtomicUsize::new(0),
    });
    let data = DocumentsData::with_port(Arc::clone(&repo), counting.clone());
    let ws = Uuid::new_v4();
    let (p1, p2, p3, p9) = (
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    );
    let bound = |node: &str, project: Option<Uuid>, state: &str, conforms: Option<bool>| {
        let mut b = binding(ws, node, &format!("docs/{node}.md"), 0);
        b.id = binding_row_id(ws, project, node);
        b.project_id = project;
        b.state = state.to_string();
        b.conforms = conforms;
        b
    };
    data.upsert_bindings(
        &ctx(),
        &[
            // The workspace's own: every project sees it.
            bound("w1", None, "confirmed", Some(true)),
            bound("a1", Some(p1), "confirmed", Some(false)),
            bound("a2", Some(p1), "detected", None),
            bound("a3", Some(p1), "manual", None),
            bound("b1", Some(p2), "manual", Some(false)),
            bound("z1", Some(p9), "confirmed", Some(true)),
        ],
    )
    .await
    .unwrap();
    let mut written = doc(ws, Some(p1), "P1 spec", "body", 1);
    written.conforms = false;
    data.upsert_doc(&ctx(), written).await.unwrap();
    let mut shared = doc(ws, None, "Workspace spec", "body", 2);
    shared.conforms = true;
    data.upsert_doc(&ctx(), shared).await.unwrap();
    data.upsert_doc(&ctx(), doc(ws, Some(p9), "Elsewhere", "body", 3))
        .await
        .unwrap();

    let projects = [p1, p2, p3];
    counting.asked.store(0, Ordering::SeqCst);
    let groups = data
        .project_groups(&ctx(), ws, &projects)
        .await
        .unwrap()
        .expect("the model holds them");
    assert_eq!(
        counting.asked.load(Ordering::SeqCst),
        2,
        "one aggregate per type for every project, not two reads per project"
    );

    for p in projects {
        let (bindings, total) = data
            .list_bindings(&ctx(), ws, DocScope::Effective(p), 0, None)
            .await
            .unwrap();
        let (docs, _) = data
            .list_docs(&ctx(), ws, DocScope::Effective(p), 0, None)
            .await
            .unwrap();
        let expected = summary(
            bindings
                .iter()
                .map(|b| (BindingState::parse(&b.state).unwrap(), b.conforms)),
            docs.iter().map(|d| d.conforms),
        );
        let got = super::service::project_documents_of(&groups, p);
        assert_eq!(got.bindings, Some(u32::try_from(total).unwrap()), "{p}");
        assert_eq!(got.specs, Some(expected), "{p}");
    }
    let p1_counts = super::service::project_documents_of(&groups, p1);
    assert_eq!(p1_counts.bindings, Some(4), "its three and the workspace's");
    let p3_counts = super::service::project_documents_of(&groups, p3);
    assert_eq!(p3_counts.bindings, Some(1), "only the workspace's");
}

// ── An owner moved before a row type existed ──────────────────────────────

/// An owner moved into the model by an earlier build never declared the row
/// types that came later (`spec-upload`, #1029). Reading one must declare
/// it, not fail the whole project domain model with "unknown domain type".
#[tokio::test]
async fn a_row_type_newer_than_the_move_is_declared_before_it_is_read() {
    let r = rig().await;
    r.port
        .put_objects(
            &ctx(),
            "sync-state",
            vec![crate::domain_model::port::OwnedObject {
                id: format!("documents-moved-v2:{}", r.ws),
                scope: r.ws.to_string(),
                payload: json!({"status": "done", "message": "moved by an earlier build"}),
            }],
        )
        .await
        .unwrap();
    let before = r
        .port
        .query(&ctx(), json!({"type": "spec-upload"}))
        .await
        .unwrap_err();
    assert!(
        before.to_string().contains("unknown domain type"),
        "the model lacks the type until the gear declares it: {before}"
    );

    let uploads = r
        .data
        .list_spec_uploads(&ctx(), r.ws, Uuid::new_v4())
        .await
        .expect("reading a row type the move did not know");
    assert!(uploads.is_empty());
}

// ── Specs per source: counted from three fields, as from whole rows ────────

/// One project's bindings the way a synced OpenSpec repository leaves them,
/// plus the workspace's own and another project's.
fn spec_layout(ws: Uuid, p: Uuid, other: Uuid) -> Vec<document_binding::Model> {
    let bound = |node: &str, path: &str, project: Option<Uuid>, state: &str| {
        let mut b = binding(ws, node, path, 0);
        b.id = binding_row_id(ws, project, node);
        b.project_id = project;
        b.state = state.to_string();
        b
    };
    vec![
        // A spec layout's type, confirmed like a front matter's (34bc5841e).
        bound("spec", "openspec/specs/auth/spec.md", Some(p), "confirmed"),
        bound("adr", "docs/adr/0001-pg.md", Some(p), "manual"),
        // A guess is writing, not a spec.
        bound("guess", "docs/guide.md", Some(p), "detected"),
        // The archive is history: writing, never a spec.
        bound(
            "archived",
            "openspec/changes/archive/2025-01-01-add-2fa/proposal.md",
            Some(p),
            "not_a_document",
        ),
        // Tool configuration and a kit's scaffolding are neither.
        bound(
            "tool",
            ".claude/commands/review.md",
            Some(p),
            "not_a_document",
        ),
        bound("nested-tool", "ui/.cursor/rules/x.md", Some(p), "detected"),
        bound(
            "kit",
            "kits/sdlc/artifacts/ADR/template.md",
            Some(p),
            "detected",
        ),
        bound("code", "src/main.rs", Some(p), "unknown"),
        // The workspace decided about the same file: two decisions.
        bound("spec", "openspec/specs/auth/spec.md", None, "confirmed"),
        // Another project's: only the workspace's count sees it.
        bound("elsewhere", "docs/prd.md", Some(other), "confirmed"),
    ]
}

/// What `/specs-per-source` counted before it read keys: every binding whole.
fn counted_whole(rows: &[document_binding::Model]) -> super::service::SourceCounting {
    let mut out = super::service::SourceCounting::default();
    for b in rows {
        if super::classify::is_prose_path(&b.path) {
            out.doc_files.insert(b.node_id.clone());
        }
        if matches!(b.state.as_str(), "confirmed" | "manual") {
            *out.decided.entry(b.node_id.clone()).or_default() += 1;
        }
    }
    out
}

async fn keys_count_as_rows_did(data: &DocumentsData, ws: Uuid, p: Uuid) {
    for (label, scope) in [
        ("the project", DocScope::Effective(p)),
        ("the workspace", DocScope::Everything),
    ] {
        let (rows, _) = data
            .list_bindings(&ctx(), ws, scope_again(&scope), 0, None)
            .await
            .unwrap();
        let keys = data.binding_keys(&ctx(), ws, scope).await.unwrap();
        assert_eq!(
            super::service::SourceCounting::of(&keys),
            counted_whole(&rows),
            "{label}"
        );
    }

    let keys = data
        .binding_keys(&ctx(), ws, DocScope::Effective(p))
        .await
        .unwrap();
    let counting = super::service::SourceCounting::of(&keys);
    assert_eq!(
        counting.files(),
        ["adr", "archived", "guess", "spec"],
        "decided files and prose files, each once"
    );
    let repo_of: std::collections::HashMap<String, String> = [
        ("spec", "repo-a"),
        ("adr", "repo-a"),
        ("guess", "repo-b"),
        ("archived", "repo-b"),
        ("tool", "repo-b"),
    ]
    .into_iter()
    .map(|(n, r)| (n.to_string(), r.to_string()))
    .collect();
    let per = counting.per_repository(&repo_of);
    assert_eq!(
        per.get("repo-a"),
        Some(&(3, 2)),
        "a convention-confirmed spec counts, once per decision; a manual one too"
    );
    assert_eq!(
        per.get("repo-b"),
        Some(&(0, 2)),
        "a guess and the archive are writing, not specs; tooling is neither"
    );
    assert_eq!(per.len(), 2);

    let everything = data
        .binding_keys(&ctx(), ws, DocScope::Everything)
        .await
        .unwrap();
    let all = super::service::SourceCounting::of(&everything);
    assert_eq!(
        all.decided.get("elsewhere"),
        Some(&1),
        "a workspace counts its projects"
    );
    assert_eq!(
        counting.decided.get("elsewhere"),
        None,
        "a project does not count its sibling's"
    );
}

fn scope_again(scope: &DocScope) -> DocScope {
    match scope {
        DocScope::WorkspaceLevel => DocScope::WorkspaceLevel,
        DocScope::Effective(p) => DocScope::Effective(*p),
        DocScope::Everything => DocScope::Everything,
    }
}

#[tokio::test]
async fn specs_per_source_counts_from_keys_what_it_counted_from_rows() {
    let r = rig().await;
    let (p, other) = (Uuid::new_v4(), Uuid::new_v4());
    r.data
        .upsert_bindings(&ctx(), &spec_layout(r.ws, p, other))
        .await
        .unwrap();
    keys_count_as_rows_did(&r.data, r.ws, p).await;
}

#[tokio::test]
async fn specs_per_source_counts_the_same_from_the_tables() {
    let repo = Arc::new(super::repo_tests::repo().await);
    let data = DocumentsData::new(
        Arc::clone(&repo),
        super::model_table::TableStorage::Tables,
        None,
    );
    let ws = Uuid::new_v4();
    let (p, other) = (Uuid::new_v4(), Uuid::new_v4());
    for row in spec_layout(ws, p, other) {
        repo.upsert_binding(row).await.unwrap();
    }
    keys_count_as_rows_did(&data, ws, p).await;
}
