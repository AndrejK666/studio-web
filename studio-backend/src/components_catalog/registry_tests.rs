//! The registry's rules (ADR-0041 P1), over [`plan`] and the in-memory sink.

use super::*;
use crate::catalog_graph::MemorySink;
use crate::components_catalog::project_gears::{fingerprint, unchanged};

const ORG: Uuid = Uuid::from_u128(0x0a6);
const P1: Uuid = Uuid::from_u128(0x101);
const P2: Uuid = Uuid::from_u128(0x102);

fn gear(name: &str, path: &str, declared: &str) -> LocalGear {
    LocalGear {
        name: name.into(),
        kind: "gear".into(),
        description: Some(format!("{name} does things")),
        category: None,
        path: path.into(),
        declared_in: declared.into(),
        repo: "acme/app".into(),
        capabilities: vec!["cap".into()],
        runtime: vec!["rest".into()],
        built: true,
        doc: Some((format!("{path}/README.md"), "Readme.".into())),
    }
}

fn read(project: Uuid, repo_key: &str, print: &str, gears: Vec<LocalGear>) -> RepoRead {
    RepoRead {
        project_id: project,
        project_name: format!("project {}", project.as_u128()),
        repo: "acme/app".into(),
        repo_key: repo_key.into(),
        git_ref: "main".into(),
        commit: Some("c0ffee".into()),
        fingerprint: print.into(),
        gears,
        ..RepoRead::default()
    }
}

fn walk(now: &str, reads: Vec<RepoRead>, resolved: &[(Uuid, &str)]) -> Walk {
    Walk {
        org: ORG,
        now: now.into(),
        reads,
        resolved: resolved.iter().map(|(p, k)| (*p, k.to_string())).collect(),
        projects_resolved: resolved.iter().map(|(p, _)| *p).collect(),
        in_scope: Some(resolved.iter().map(|(p, _)| *p).collect()),
    }
}

/// The stored state after applying a plan to `before`: what a sink holds.
#[derive(Clone, Debug, Default)]
struct Store {
    entries: Vec<(String, EntryRecord)>,
    occurrences: Vec<(String, OccurrenceRecord)>,
    reads: Vec<(String, ReadRecord)>,
}

impl Store {
    fn apply(&mut self, plan: &Plan) {
        for id in &plan.retire {
            self.occurrences.retain(|(i, _)| i != id);
            self.reads.retain(|(i, _)| i != id);
        }
        for node in &plan.upsert {
            let id = node.instance_id.clone();
            match node.type_id {
                gts::REGISTRY_ENTRY_TYPE => {
                    self.entries.retain(|(i, _)| *i != id);
                    self.entries
                        .push((id, serde_json::from_value(node.value.clone()).unwrap()));
                }
                gts::OCCURRENCE_TYPE => {
                    self.occurrences.retain(|(i, _)| *i != id);
                    self.occurrences
                        .push((id, serde_json::from_value(node.value.clone()).unwrap()));
                }
                gts::REGISTRY_READ_TYPE => {
                    self.reads.retain(|(i, _)| *i != id);
                    self.reads
                        .push((id, serde_json::from_value(node.value.clone()).unwrap()));
                }
                other => panic!("a walk wrote {other}"),
            }
        }
    }

    fn run(&mut self, walk: &Walk) -> Plan {
        let plan = plan(walk, &self.entries, &self.occurrences, &self.reads);
        self.apply(&plan);
        plan
    }

    fn entry(&self, name: &str) -> &EntryRecord {
        &self
            .entries
            .iter()
            .find(|(_, e)| e.name == name)
            .unwrap_or_else(|| panic!("no entry {name}"))
            .1
    }

    fn occurrences_of(&self, name: &str) -> Vec<&OccurrenceRecord> {
        self.occurrences
            .iter()
            .map(|(_, o)| o)
            .filter(|o| o.entry == name)
            .collect()
    }
}

#[test]
fn an_unchanged_repository_is_not_read_again() {
    let files = vec![
        ("src/a/mod.rs".to_string(), "1".to_string()),
        ("src/a/gear.toml".to_string(), "2".to_string()),
    ];
    let stored = fingerprint(&files);
    assert!(unchanged(Some(&stored), &fingerprint(&files)));
    let mut moved = files.clone();
    moved[1].1 = "3".into();
    assert!(!unchanged(Some(&stored), &fingerprint(&moved)));
    // Nothing stored yet: read it.
    assert!(!unchanged(None, &stored));
}

#[test]
fn a_component_found_anew_is_declared_with_its_occurrence() {
    let mut store = Store::default();
    let plan = store.run(&walk(
        "t1",
        vec![read(
            P1,
            "k1",
            "f1",
            vec![gear("studio-tasks", "src/tasks", "src/tasks/mod.rs")],
        )],
        &[(P1, "k1")],
    ));
    assert_eq!(plan.created, 1);
    assert_eq!(plan.occurrences_written, 1);
    assert_eq!(plan.edges.len(), 1);
    assert_eq!(plan.edges[0].type_id, gts::REL_FOUND_IN);
    let e = store.entry("studio-tasks");
    assert_eq!(e.state, STATE_DECLARED);
    assert_eq!(e.first_seen.as_deref(), Some("t1"));
    assert_eq!(e.last_seen.as_deref(), Some("t1"));
    assert_eq!(e.fingerprint.as_deref(), Some("f1"));
    assert!(!e.orphaned);
    let occ = store.occurrences_of("studio-tasks");
    assert_eq!(occ.len(), 1);
    assert_eq!(occ[0].declared_in, "attribute");
    assert_eq!(occ[0].project_id, Some(P1));
    assert_eq!(occ[0].commit.as_deref(), Some("c0ffee"));
    assert_eq!(occ[0].git_ref.as_deref(), Some("main"));
    // The fingerprint is kept for the next walk.
    assert_eq!(store.reads.len(), 1);
    assert_eq!(store.reads[0].1.fingerprint, "f1");
}

#[test]
fn a_repository_skipped_as_unchanged_keeps_everything_and_writes_nothing() {
    let mut store = Store::default();
    store.run(&walk(
        "t1",
        vec![read(P1, "k1", "f1", vec![gear("a", "a", "a/gear.toml")])],
        &[(P1, "k1")],
    ));
    let before = store.clone();
    // Resolved, not read: its fingerprint held.
    let plan = store.run(&walk("t2", Vec::new(), &[(P1, "k1")]));
    assert!(plan.upsert.is_empty(), "{:?}", plan.upsert);
    assert!(plan.retire.is_empty());
    assert_eq!(store.occurrences.len(), before.occurrences.len());
    assert_eq!(store.entry("a").last_seen.as_deref(), Some("t1"));
}

#[test]
fn discovery_never_moves_a_state_and_never_resurrects_a_rejected_entry() {
    let mut store = Store::default();
    store.run(&walk(
        "t1",
        vec![read(
            P1,
            "k1",
            "f1",
            vec![
                gear("kept", "kept", "kept/gear.toml"),
                gear("owned", "owned", "owned/gear.gdl"),
            ],
        )],
        &[(P1, "k1")],
    ));
    // A person (P2) rejects one and registers the other, with an owner.
    for (_, e) in &mut store.entries {
        if e.name == "kept" {
            e.state = STATE_REJECTED.into();
        } else {
            e.state = STATE_REGISTERED.into();
            e.owner = Some(Owner {
                kind: "person".into(),
                id: Some("ada-id".into()),
                name: "Ada".into(),
            });
            e.description = Some("what a person wrote".into());
        }
    }
    // Read again under the same fingerprint, then under a new one.
    for (now, print) in [("t2", "f1"), ("t3", "f2")] {
        let mut changed = vec![
            gear("kept", "kept", "kept/gear.toml"),
            gear("owned", "owned", "owned/gear.gdl"),
        ];
        changed[1].description = Some("what the repository says now".into());
        let plan = store.run(&walk(
            now,
            vec![read(P1, "k1", print, changed)],
            &[(P1, "k1")],
        ));
        assert_eq!(plan.created, 0);
        assert_eq!(store.entry("kept").state, STATE_REJECTED, "{now}");
        let owned = store.entry("owned");
        assert_eq!(owned.state, STATE_REGISTERED);
        assert_eq!(owned.owner.as_ref().map(|o| o.name.as_str()), Some("Ada"));
        // What a person owns is theirs; a walk only says when it saw it.
        assert_eq!(owned.description.as_deref(), Some("what a person wrote"));
        assert_eq!(owned.last_seen.as_deref(), Some(now));
    }
}

#[test]
fn a_declared_entry_follows_what_its_repository_says() {
    let mut store = Store::default();
    store.run(&walk(
        "t1",
        vec![read(P1, "k1", "f1", vec![gear("a", "a", "a/gear.toml")])],
        &[(P1, "k1")],
    ));
    let mut g = gear("a", "a", "a/gear.toml");
    g.description = Some("new words".into());
    g.kind = "plugin".into();
    let plan = store.run(&walk(
        "t2",
        vec![read(P1, "k1", "f2", vec![g])],
        &[(P1, "k1")],
    ));
    assert_eq!(plan.updated, 1);
    let e = store.entry("a");
    assert_eq!(e.description.as_deref(), Some("new words"));
    assert_eq!(e.kind, "plugin");
    assert_eq!(e.first_seen.as_deref(), Some("t1"));
}

#[test]
fn a_reread_repository_drops_what_it_no_longer_declares_and_the_entry_is_orphaned() {
    let mut store = Store::default();
    store.run(&walk(
        "t1",
        vec![read(
            P1,
            "k1",
            "f1",
            vec![gear("a", "a", "a/gear.toml"), gear("b", "b", "b/gear.toml")],
        )],
        &[(P1, "k1")],
    ));
    let plan = store.run(&walk(
        "t2",
        vec![read(P1, "k1", "f2", vec![gear("a", "a", "a/gear.toml")])],
        &[(P1, "k1")],
    ));
    assert_eq!(plan.occurrences_removed, 1);
    assert_eq!(plan.orphaned, 1);
    assert!(store.occurrences_of("b").is_empty());
    // Kept, with its state, and said to be orphaned.
    let b = store.entry("b");
    assert!(b.orphaned);
    assert_eq!(b.state, STATE_DECLARED);
    assert!(!store.entry("a").orphaned);

    // Back in the repository: found again, no longer orphaned.
    store.run(&walk(
        "t3",
        vec![read(
            P1,
            "k1",
            "f3",
            vec![gear("a", "a", "a/gear.toml"), gear("b", "b", "b/gear.toml")],
        )],
        &[(P1, "k1")],
    ));
    assert!(!store.entry("b").orphaned);
    assert_eq!(store.entry("b").first_seen.as_deref(), Some("t1"));
}

#[test]
fn a_component_in_two_projects_is_one_entry_with_two_occurrences() {
    let mut store = Store::default();
    store.run(&walk(
        "t1",
        vec![
            read(P1, "k1", "f1", vec![gear("shared", "x", "x/gear.toml")]),
            read(P2, "k2", "f2", vec![gear("Shared", "y", "y/gear.toml")]),
        ],
        &[(P1, "k1"), (P2, "k2")],
    ));
    assert_eq!(store.entries.len(), 1);
    assert_eq!(store.occurrences_of("shared").len(), 2);
}

#[test]
fn an_excluded_project_loses_its_occurrences_and_a_failed_one_keeps_them() {
    let mut store = Store::default();
    store.run(&walk(
        "t1",
        vec![
            read(P1, "k1", "f1", vec![gear("a", "a", "a/gear.toml")]),
            read(P2, "k2", "f2", vec![gear("b", "b", "b/gear.toml")]),
        ],
        &[(P1, "k1"), (P2, "k2")],
    ));
    // P2 is excluded now: out of scope. P1's repositories could not be
    // listed this time: in scope, but not resolved.
    let w = Walk {
        org: ORG,
        now: "t2".into(),
        reads: Vec::new(),
        resolved: BTreeSet::new(),
        projects_resolved: BTreeSet::new(),
        in_scope: Some([P1].into_iter().collect()),
    };
    let plan = store.run(&w);
    assert_eq!(plan.occurrences_removed, 1);
    assert_eq!(
        store.occurrences_of("a").len(),
        1,
        "could not tell is not none"
    );
    assert!(store.occurrences_of("b").is_empty());
    assert!(store.entry("b").orphaned);
    // P2's fingerprint goes too, so including it again reads it again.
    assert!(store.reads.iter().all(|(_, r)| r.project_id == P1));
}

#[test]
fn a_repository_a_project_no_longer_names_loses_its_occurrences() {
    let mut store = Store::default();
    store.run(&walk(
        "t1",
        vec![read(P1, "old", "f1", vec![gear("a", "a", "a/gear.toml")])],
        &[(P1, "old")],
    ));
    store.run(&walk(
        "t2",
        vec![read(P1, "new", "f2", vec![gear("c", "c", "c/gear.toml")])],
        &[(P1, "new")],
    ));
    assert!(store.occurrences_of("a").is_empty());
    assert!(store.entry("a").orphaned);
    assert_eq!(store.occurrences_of("c").len(), 1);
    assert!(store.reads.iter().all(|(_, r)| r.repo_key == "new"));
}

#[test]
fn a_walk_of_named_projects_leaves_the_others_alone() {
    let mut store = Store::default();
    store.run(&walk(
        "t1",
        vec![
            read(P1, "k1", "f1", vec![gear("a", "a", "a/gear.toml")]),
            read(P2, "k2", "f2", vec![gear("b", "b", "b/gear.toml")]),
        ],
        &[(P1, "k1"), (P2, "k2")],
    ));
    let mut w = walk(
        "t2",
        vec![read(P1, "k1", "f3", vec![gear("a", "a", "a/gear.toml")])],
        &[(P1, "k1")],
    );
    w.in_scope = None;
    store.run(&w);
    assert_eq!(store.occurrences_of("b").len(), 1);
    assert!(!store.entry("b").orphaned);
}

#[test]
fn a_registry_entry_answers_a_projects_gears_as_project_gears_did() {
    let mut store = Store::default();
    let g = gear("studio-tasks", "src/tasks", "src/tasks/mod.rs");
    store.run(&walk(
        "t1",
        vec![read(P1, "k1", "f1", vec![g.clone()])],
        &[(P1, "k1")],
    ));
    let entries = join(
        store.entries.clone(),
        store.occurrences.iter().map(|(_, o)| o.clone()).collect(),
    );
    let (nodes, profiles) = crate::components_catalog::port::project_gears_of(&entries, P1);
    let (want_nodes, want_profiles) =
        crate::components_catalog::project_gears::catalogue_shape(&[g]);
    assert_eq!(nodes, want_nodes);
    assert_eq!(profiles, want_profiles);
    assert_eq!(nodes[0]["origin"], "project");
    assert_eq!(nodes[0]["path"], "src/tasks");
    // Nothing found in another project.
    assert!(
        crate::components_catalog::port::project_gears_of(&entries, P2)
            .0
            .is_empty()
    );
}

#[test]
fn the_registry_is_narrowed_by_state_project_and_text() {
    let mut store = Store::default();
    store.run(&walk(
        "t1",
        vec![
            read(P1, "k1", "f1", vec![gear("alpha", "a", "a/gear.toml")]),
            read(P2, "k2", "f2", vec![gear("Beta", "b", "b/gear.toml")]),
        ],
        &[(P1, "k1"), (P2, "k2")],
    ));
    let all = join(
        store.entries.clone(),
        store.occurrences.iter().map(|(_, o)| o.clone()).collect(),
    );
    let names =
        |v: Vec<RegistryEntry>| -> Vec<String> { v.into_iter().map(|e| e.entry.name).collect() };
    assert_eq!(
        names(filter_entries(all.clone(), None, None, None)),
        ["alpha", "Beta"]
    );
    assert_eq!(
        names(filter_entries(all.clone(), None, Some(P2), None)),
        ["Beta"]
    );
    assert_eq!(
        names(filter_entries(all.clone(), None, None, Some("BET"))),
        ["Beta"]
    );
    assert_eq!(
        names(filter_entries(all.clone(), None, None, Some("alpha does"))),
        ["alpha"]
    );
    assert!(filter_entries(all, Some("registered"), None, None).is_empty());
}

#[test]
fn what_declares_a_component_is_named_by_its_file() {
    assert_eq!(declared_in_of("x/gear.toml"), "gear.toml");
    assert_eq!(declared_in_of("gear.gdl"), "gear.gdl");
    assert_eq!(declared_in_of("src/x/mod.rs"), "attribute");
    assert_eq!(declared_in_of("packages/x/package.json"), "package");
    assert_eq!(declared_in_of("kits/x/.cf-studio-kit.toml"), "kit");
}

fn ctx() -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(0xca7))
        .subject_type("service")
        .subject_tenant_id(ORG)
        .build()
        .expect("security context")
}

fn service() -> CatalogService {
    CatalogService::new(Arc::new(MemorySink::default()), "k".to_string(), None)
}

fn source(repo: &str, git_ref: &str, mode: &str) -> RepoSource {
    RepoSource {
        tenant: ORG,
        connection_id: Some(Uuid::from_u128(0xc0)),
        repo: repo.into(),
        git_ref: git_ref.into(),
        mode: mode.into(),
    }
}

#[tokio::test]
async fn sources_round_trip_and_a_replace_drops_what_it_does_not_name() {
    let svc = service();
    let ctx = ctx();
    assert!(svc.list_sources(&ctx).await.unwrap().is_empty());
    let saved = svc
        .replace_sources(
            &ctx,
            vec![
                source("acme/gears", "main", "gears"),
                source(" acme/frontx ", "", ""),
                source("Acme/Gears", "main", "gears"),
                source("  ", "main", "gears"),
            ],
        )
        .await
        .unwrap();
    assert_eq!(saved.len(), 2, "a blank one dropped, a repeat kept once");
    let listed = svc.list_sources(&ctx).await.unwrap();
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].repo, "acme/gears");
    assert_eq!(listed[0].git_ref, "main");
    assert_eq!(listed[0].connection_id, Some(Uuid::from_u128(0xc0)));
    assert_eq!(listed[1].repo, "acme/frontx");
    assert_eq!(listed[1].mode, "gears");

    svc.replace_sources(&ctx, vec![source("acme/kits", "v1", "kits")])
        .await
        .unwrap();
    let listed = svc.list_sources(&ctx).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].repo, "acme/kits");
    assert_eq!(listed[0].mode, "kits");
}

#[tokio::test]
async fn excluded_projects_round_trip() {
    let svc = service();
    let ctx = ctx();
    assert!(svc.excluded_projects(&ctx).await.unwrap().is_empty());
    let saved = svc
        .set_excluded_projects(&ctx, vec![P2, P1, P2])
        .await
        .unwrap();
    assert_eq!(saved, vec![P2, P1]);
    assert_eq!(svc.excluded_projects(&ctx).await.unwrap(), vec![P2, P1]);
    svc.set_excluded_projects(&ctx, Vec::new()).await.unwrap();
    assert!(svc.excluded_projects(&ctx).await.unwrap().is_empty());
}

#[tokio::test]
async fn the_registry_reads_back_what_a_walk_wrote() {
    let svc = service();
    let ctx = ctx();
    assert!(svc.registry_entries(&ctx).await.unwrap().is_empty());
    let w = walk(
        "t1",
        vec![read(
            P1,
            "k1",
            "f1",
            vec![gear("studio-tasks", "src/tasks", "src/tasks/mod.rs")],
        )],
        &[(P1, "k1")],
    );
    let plan = plan(&w, &[], &[], &[]);
    svc.sink
        .upsert(&ctx, &plan.upsert, &plan.edges)
        .await
        .unwrap();
    let all = svc.registry_entries(&ctx).await.unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].occurrences.len(), 1);
    let one = svc.registry_entry(&ctx, "STUDIO-TASKS").await.unwrap();
    assert_eq!(one.map(|e| e.entry.name).as_deref(), Some("studio-tasks"));
    assert!(svc.registry_entry(&ctx, "nope").await.unwrap().is_none());
}

// ---- what the last walk saw ----------------------------------------------

/// The walk runs as the service. A repository connected with someone's
/// personal token is not readable to it, and the page says what to do about
/// that instead of showing a project with no components.
#[test]
fn a_personal_token_failure_says_to_share_the_connection() {
    let hint = read_failure_hint(
        "the token for connection '222' is not readable — it may belong to another user (personal scope) or have been removed",
    )
    .unwrap();
    assert!(hint.contains("personal token"), "{hint}");
    assert!(hint.contains("Share the connection"), "{hint}");
    assert!(
        read_failure_hint("GitHub said 404 Not Found")
            .unwrap()
            .contains("not found")
    );
    assert_eq!(read_failure_hint("connection reset by peer"), None);
}

fn walked(project: Uuid, name: &str, status: &str) -> ProjectWalk {
    ProjectWalk {
        project_id: project,
        project_name: name.into(),
        at: "2026-10-09T13:00:00Z".into(),
        error: None,
        repos: vec![RepoWalk {
            repo: "o/r".into(),
            status: status.into(),
            components: 3,
            error: None,
            hint: None,
        }],
    }
}

#[test]
fn a_full_walk_replaces_the_statuses_and_a_partial_one_only_its_projects() {
    let before = vec![walked(P1, "a", "read"), walked(P2, "b", "failed")];
    let full = merge_walks(before.clone(), vec![walked(P1, "a", "unchanged")], true);
    assert_eq!(full.len(), 1, "a project out of the full walk drops out");
    let partial = merge_walks(before, vec![walked(P2, "b", "read")], false);
    assert_eq!(partial.len(), 2);
    assert_eq!(
        partial.iter().find(|p| p.project_id == P2).unwrap().repos[0].status,
        "read"
    );
    assert_eq!(
        partial.iter().find(|p| p.project_id == P1).unwrap().repos[0].status,
        "read"
    );
}

#[tokio::test]
async fn saving_the_exclusions_keeps_what_the_last_walk_saw() {
    let svc = service();
    let ctx = ctx();
    svc.sink.register_types(&ctx).await.unwrap();
    let org = ctx.subject_tenant_id();
    let settings = SettingsRecord {
        organization_id: Some(org),
        excluded_project_ids: vec![],
        last_walk: vec![walked(P1, "a", "read")],
        crates_io_keyword: None,
    };
    svc.sink
        .upsert(
            &ctx,
            &[gts::registry_settings_node(
                &org.to_string(),
                serde_json::to_value(&settings).unwrap(),
            )],
            &[],
        )
        .await
        .unwrap();
    svc.set_excluded_projects(&ctx, vec![P2]).await.unwrap();
    assert_eq!(
        svc.last_walk(&ctx).await.unwrap(),
        vec![walked(P1, "a", "read")]
    );
    assert_eq!(svc.excluded_projects(&ctx).await.unwrap(), vec![P2]);
}
