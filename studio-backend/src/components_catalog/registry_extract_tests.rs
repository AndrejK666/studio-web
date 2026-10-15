//! Extract (ADR-0044 §1): where each file goes, the project's edits, the two
//! pull requests, the refusals, and completing it -- with fake repository
//! files, fake repositories and a fake studio-product writer.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use uuid::Uuid;

use super::*;
use crate::catalog_graph::MemorySink;
use crate::components_catalog::project_gears::LocalGear;
use crate::components_catalog::registry::{
    GearRepository, OccurrenceRecord, Owner, RepoRead, STATE_DEPRECATED, STATE_EXTRACTED, Walk,
    plan,
};
use crate::components_catalog::registry_decisions::apply;
use crate::product::port::DeclarationWritten;

const ORG: Uuid = Uuid::from_u128(0x0a6);
const P1: Uuid = Uuid::from_u128(0x101);
const GEAR_CONNECTION: Uuid = Uuid::from_u128(0xc2);

fn ctx_in(tenant: Uuid) -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(0xca7))
        .subject_type("user")
        .subject_tenant_id(tenant)
        .build()
        .expect("security context")
}

const MANIFEST: &str = "[package]\nname = \"app\"\nedition = \"2024\"\n\n[dependencies]\nserde = { workspace = true }\nserde_json = \"1\"\n";

/// The readiness check's clean module, `billing`, in `acme/app`.
fn repository() -> Vec<(String, String)> {
    [
        ("app/Cargo.toml", MANIFEST),
        (
            "app/src/billing/mod.rs",
            "pub mod port;\npub mod sdk;\nmod repo;\nuse serde::Serialize;\nuse crate::billing::sdk::Invoice;\n",
        ),
        ("app/src/billing/port.rs", "use super::sdk::Invoice;\n"),
        (
            "app/src/billing/sdk.rs",
            "use serde_json::Value;\npub struct Invoice;\n",
        ),
        ("app/src/billing/repo.rs", "use crate::billing::sdk::Invoice;\n"),
        ("app/src/billing/gear.gdl", "gear(id = \"billing\")\n"),
        (
            "app/src/main.rs",
            "pub mod billing;\nmod other;\nuse crate::billing::sdk::Invoice;\n",
        ),
        ("app/src/other.rs", "use crate::billing::sdk::Invoice;\n"),
    ]
    .into_iter()
    .map(|(p, t)| (p.to_owned(), t.to_owned()))
    .collect()
}

struct Files(Vec<(String, String)>);

#[async_trait]
impl OccurrenceFiles for Files {
    async fn listing(
        &self,
        _ctx: &SecurityContext,
        _occ: &OccurrenceRecord,
    ) -> anyhow::Result<Vec<(String, Option<i64>)>> {
        Ok(self.0.iter().map(|(p, _)| (p.clone(), Some(100))).collect())
    }

    async fn read(
        &self,
        _ctx: &SecurityContext,
        _occ: &OccurrenceRecord,
        paths: &[String],
    ) -> anyhow::Result<Vec<(String, Option<String>)>> {
        Ok(paths
            .iter()
            .map(|p| {
                let t = self.0.iter().find(|(q, _)| q == p).map(|(_, t)| t.clone());
                (p.clone(), t)
            })
            .collect())
    }
}

/// Repositories: which `repo:path` are on the base branch.
#[derive(Default)]
struct Repos {
    present: Mutex<BTreeSet<String>>,
}

#[async_trait]
impl ExtractionRepos for Repos {
    async fn default_branch(
        &self,
        _ctx: &SecurityContext,
        _at: &RepositoryTarget,
    ) -> anyhow::Result<String> {
        Ok("trunk".into())
    }

    async fn has_file(
        &self,
        _ctx: &SecurityContext,
        at: &RepositoryTarget,
        path: &str,
    ) -> anyhow::Result<bool> {
        Ok(self
            .present
            .lock()
            .unwrap()
            .contains(&format!("{}:{path}", at.repo)))
    }
}

struct Write {
    tenant: Uuid,
    target: RepositoryTarget,
    branch: String,
    files: Vec<DeclarationFile>,
    deleted: Vec<String>,
    text: PullRequestText,
}

#[derive(Default)]
struct Writer {
    writes: Mutex<Vec<Write>>,
    tags: Mutex<Vec<(Uuid, String, String)>>,
}

#[async_trait]
impl GearContributions for Writer {
    async fn contribute(
        &self,
        ctx: &SecurityContext,
        target: &RepositoryTarget,
        branch: &str,
        files: &[DeclarationFile],
        text: &PullRequestText,
    ) -> anyhow::Result<DeclarationWritten> {
        self.contribute_changes(ctx, target, branch, files, &[], text)
            .await
    }

    async fn contribute_changes(
        &self,
        ctx: &SecurityContext,
        target: &RepositoryTarget,
        branch: &str,
        files: &[DeclarationFile],
        deleted: &[String],
        text: &PullRequestText,
    ) -> anyhow::Result<DeclarationWritten> {
        let mut writes = self.writes.lock().unwrap();
        writes.push(Write {
            tenant: ctx.subject_tenant_id(),
            target: target.clone(),
            branch: branch.to_owned(),
            files: files.to_vec(),
            deleted: deleted.to_vec(),
            text: text.clone(),
        });
        Ok(DeclarationWritten {
            branch: branch.to_owned(),
            commit_sha: "abc".into(),
            pr_url: Some(format!("https://github.com/{}/pull/{}", target.repo, writes.len())),
        })
    }

    async fn tag(
        &self,
        ctx: &SecurityContext,
        target: &RepositoryTarget,
        tag: &str,
    ) -> anyhow::Result<String> {
        self.tags.lock().unwrap().push((
            ctx.subject_tenant_id(),
            target.repo.clone(),
            tag.to_owned(),
        ));
        Ok("7a9".into())
    }
}

fn service() -> CatalogService {
    CatalogService::new(Arc::new(MemorySink::tenant_scoped()), "k".to_string(), None)
}

fn by() -> Decider {
    Decider {
        id: "person-ada".into(),
        name: Some("Ada".into()),
    }
}

/// `billing` declared in P1's `acme/app`, registered; the organization's gear
/// repository set when `gear_repo`.
async fn seeded(svc: &CatalogService, gear_repo: bool) {
    let ctx = ctx_in(ORG);
    let w = Walk {
        org: ORG,
        now: "t1".into(),
        reads: vec![RepoRead {
            project_id: P1,
            project_name: "app".into(),
            repo: "acme/app".into(),
            repo_key: "k1".into(),
            git_ref: String::new(),
            commit: Some("c0ffee".into()),
            fingerprint: "f1".into(),
            gears: vec![LocalGear {
                name: "billing".into(),
                kind: "gear".into(),
                description: Some("Invoices.".into()),
                category: None,
                path: "app/src/billing".into(),
                declared_in: "app/src/billing/gear.gdl".into(),
                repo: "acme/app".into(),
                capabilities: Vec::new(),
                runtime: Vec::new(),
                built: true,
                doc: None,
            }],
            tenant: Some(P1),
            ..RepoRead::default()
        }],
        resolved: [(P1, "k1".to_string())].into_iter().collect(),
        projects_resolved: [P1].into_iter().collect(),
        in_scope: Some([P1].into_iter().collect()),
        ..Walk::default()
    };
    let p = plan(&w, &[], &[], &[]);
    svc.sink.upsert(&ctx, &p.upsert, &p.edges).await.unwrap();
    let register = DecisionInput {
        action: "register".into(),
        owner: Some(Owner {
            kind: "team".into(),
            id: None,
            name: "Billing team".into(),
        }),
        ..DecisionInput::default()
    };
    svc.decide_registry(&ctx, "billing", &register, &by())
        .await
        .unwrap();
    if gear_repo {
        svc.store_gear_repository(
            &ctx,
            Some(GearRepository {
                tenant: ORG,
                connection_id: GEAR_CONNECTION,
                repo: "acme/gears".into(),
                branch: "main".into(),
                connection_label: None,
                set_by: None,
                set_at: None,
            }),
        )
        .await
        .unwrap();
    }
}

fn extract() -> DecisionInput {
    DecisionInput {
        action: "extract".into(),
        ..DecisionInput::default()
    }
}

fn refusal(r: Result<(RegistryEntry, Vec<DecisionRecord>), ExtractFailure>) -> ExtractError {
    match r {
        Err(ExtractFailure::Refused(e)) => e,
        Err(other) => panic!("not a refusal: {other:?}"),
        Ok((e, _)) => panic!("extracted: {:?}", e.entry.state),
    }
}

// ── The pure rules ──

#[test]
fn the_project_depends_on_the_crate_at_its_tag() {
    let url = "https://github.com/acme/gears.git";
    let out = depend_on(MANIFEST, "billing", url, "billing/v0.1.0");
    assert!(
        out.contains("[dependencies]\nbilling = { git = \"https://github.com/acme/gears.git\", tag = \"billing/v0.1.0\" }\nserde"),
        "{out}"
    );
    // No section: one is added.
    let bare = depend_on("[package]\nname = \"app\"\n", "billing", url, "billing/v0.1.0");
    assert!(bare.ends_with("\n[dependencies]\nbilling = { git = \"https://github.com/acme/gears.git\", tag = \"billing/v0.1.0\" }\n"), "{bare}");
    // Already named: left alone.
    let named = format!("{MANIFEST}billing = \"0.1\"\n");
    assert_eq!(depend_on(&named, "billing", url, "billing/v0.1.0"), named);
}

#[test]
fn the_module_declaration_becomes_the_crate_under_the_same_name() {
    assert_eq!(
        reexport("pub mod billing;\nmod other;\n", "billing", "billing_gear").as_deref(),
        Some("pub use billing_gear as billing;\nmod other;\n")
    );
    assert_eq!(
        reexport("  pub(crate) mod billing;", "billing", "b").as_deref(),
        Some("  pub(crate) use b as billing;")
    );
    assert_eq!(
        reexport("mod billing;\n", "billing", "b").as_deref(),
        Some("use b as billing;\n")
    );
    // Not this module, or not a declaration.
    assert_eq!(reexport("mod billings;\nmod billing { }\n", "billing", "b"), None);
}

#[test]
fn a_module_becomes_a_crate_with_its_own_manifest() {
    let listing: Vec<String> = repository().into_iter().map(|(p, _)| p).collect();
    let unit = registry_readiness::locate(&listing, "app/src/billing").unwrap();
    let texts: BTreeMap<String, String> = repository().into_iter().collect();
    let deps = vec![
        Dependency {
            name: "serde".into(),
            spec: Some("{ workspace = true }".into()),
        },
        Dependency {
            name: "serde_json".into(),
            spec: Some("\"1\"".into()),
        },
    ];
    let (files, skipped) = crate_files(&unit, &texts, "gears/billing", "billing", "2024", &deps);
    assert!(skipped.is_empty());
    let at = |p: &str| {
        files
            .iter()
            .find(|f| f.path == p)
            .unwrap_or_else(|| panic!("{p} in {:?}", files.iter().map(|f| &f.path).collect::<Vec<_>>()))
            .content
            .clone()
    };
    // The top file is the crate root, its paths re-homed.
    assert!(at("gears/billing/src/lib.rs").contains("use crate::sdk::Invoice;"));
    assert_eq!(at("gears/billing/src/repo.rs"), "use crate::sdk::Invoice;\n");
    assert_eq!(at("gears/billing/src/port.rs"), "use super::sdk::Invoice;\n");
    // Its description sits beside the manifest.
    assert_eq!(at("gears/billing/gear.gdl"), "gear(id = \"billing\")\n");
    let manifest = at("gears/billing/Cargo.toml");
    assert!(manifest.starts_with("[package]\nname = \"billing\"\nversion = \"0.1.0\"\nedition = \"2024\""), "{manifest}");
    assert!(manifest.contains("serde = { workspace = true }\nserde_json = \"1\"\n"), "{manifest}");
    assert!(manifest.contains("resolve against the gear repository's workspace"), "{manifest}");
}

#[test]
fn a_crate_moves_as_it_is() {
    let listing = vec![
        "crates/billing/Cargo.toml".to_owned(),
        "crates/billing/src/lib.rs".to_owned(),
    ];
    let unit = registry_readiness::locate(&listing, "crates/billing").unwrap();
    let texts = BTreeMap::from([
        ("crates/billing/Cargo.toml".to_owned(), "[package]\nname = \"cf-billing\"\n".to_owned()),
        ("crates/billing/src/lib.rs".to_owned(), "use crate::x;\n".to_owned()),
    ]);
    let (files, _) = crate_files(&unit, &texts, "gears/billing", "cf-billing", "2021", &[]);
    let paths: Vec<_> = files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, ["gears/billing/Cargo.toml", "gears/billing/src/lib.rs"]);
    assert_eq!(files[1].content, "use crate::x;\n");
    assert_eq!(package_name(&texts["crates/billing/Cargo.toml"]).as_deref(), Some("cf-billing"));
}

#[test]
fn the_manifest_says_the_name_and_edition() {
    assert_eq!(package_name(MANIFEST).as_deref(), Some("app"));
    assert_eq!(package_edition(MANIFEST).as_deref(), Some("2024"));
    assert_eq!(package_edition("[package]\nedition.workspace = true\n"), None);
    assert_eq!(tag_of("Billing Engine", "0.1.0"), "billing-engine/v0.1.0");
    assert_eq!(crate_ident("billing-engine"), "billing_engine");
}

#[test]
fn a_modules_declaration_is_in_its_parent() {
    let listing: Vec<String> = [
        "app/Cargo.toml",
        "app/src/lib.rs",
        "app/src/a/mod.rs",
        "app/src/b.rs",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    let m = |p: &[&str]| p.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
    assert_eq!(
        parent_module_file(&listing, "app/Cargo.toml", &m(&["billing"])).as_deref(),
        Some("app/src/lib.rs")
    );
    assert_eq!(
        parent_module_file(&listing, "app/Cargo.toml", &m(&["a", "billing"])).as_deref(),
        Some("app/src/a/mod.rs")
    );
    assert_eq!(
        parent_module_file(&listing, "app/Cargo.toml", &m(&["b", "billing"])).as_deref(),
        Some("app/src/b.rs")
    );
    assert_eq!(parent_module_file(&listing, "app/Cargo.toml", &[]), None);
}

#[test]
fn extracted_sits_between_registered_and_published() {
    use super::super::registry_decisions::transition;
    assert_eq!(transition(Action::Extract, STATE_REGISTERED, true), Some(STATE_REGISTERED));
    assert_eq!(transition(Action::Extract, STATE_EXTRACTED, true), None);
    assert_eq!(
        transition(Action::CompleteExtraction, STATE_REGISTERED, true),
        Some(STATE_EXTRACTED)
    );
    // Publishing starts from extracted (ADR-0044 §5) and leaves it there.
    assert_eq!(transition(Action::Publish, STATE_EXTRACTED, true), Some(STATE_EXTRACTED));
    assert_eq!(
        transition(Action::MarkPublished, STATE_EXTRACTED, true),
        Some(registry::STATE_PUBLISHED)
    );
    assert_eq!(transition(Action::Deprecate, STATE_EXTRACTED, true), Some(STATE_DEPRECATED));

    // A deprecated gear that had left its project is restored as extracted.
    let entry = EntryRecord {
        name: "billing".into(),
        state: STATE_DEPRECATED.into(),
        extraction: Some(Extraction {
            completed_at: Some("t".into()),
            ..Extraction::default()
        }),
        ..EntryRecord::default()
    };
    let restore = DecisionInput {
        action: "restore".into(),
        ..DecisionInput::default()
    };
    let applied = apply(&entry, true, &restore, &|_| None).unwrap();
    assert_eq!(applied.to, STATE_REGISTERED);
    assert_eq!(applied.entry.state, STATE_EXTRACTED);
}

// ── The service ──

#[tokio::test]
async fn extract_opens_both_pull_requests_and_completing_it_tags_the_version() {
    let svc = service();
    seeded(&svc, true).await;
    let ctx = ctx_in(ORG);
    let files = Files(repository());
    let repos = Repos::default();
    let writer = Writer::default();

    // A dry run answers both sides and writes nothing.
    let (_, plan) = svc
        .plan_extract(&ctx, "billing", &by(), &files, &repos)
        .await
        .unwrap();
    assert_eq!(plan.gear_target.repo, "acme/gears");
    assert_eq!(plan.source_target.repo, "acme/app");
    // The occurrence named no ref: the repository's default branch.
    assert_eq!(plan.source_target.base_branch, "trunk");
    assert_eq!(plan.extraction.tag, "billing/v0.1.0");
    assert_eq!(plan.extraction.gear_path, "gears/billing");
    assert!(writer.writes.lock().unwrap().is_empty());

    let (entry, decisions) = svc
        .extract_registry(&ctx, "billing", &extract(), &by(), &files, &repos, &writer)
        .await
        .unwrap();
    assert_eq!(entry.entry.state, STATE_REGISTERED);
    let x = entry.entry.extraction.clone().expect("the extraction");
    assert_eq!(x.gear_pr_url.as_deref(), Some("https://github.com/acme/gears/pull/1"));
    assert_eq!(x.source_pr_url.as_deref(), Some("https://github.com/acme/app/pull/2"));
    assert_eq!(x.source_top.as_deref(), Some("app/src/main.rs"));
    assert_eq!(decisions[0].action, "extract");
    {
        let writes = writer.writes.lock().unwrap();
        assert_eq!(writes.len(), 2);
        // The gear repository is the organization's, written as it.
        let gear = &writes[0];
        assert_eq!((gear.tenant, gear.target.repo.as_str()), (ORG, "acme/gears"));
        assert_eq!(gear.target.connection_id, Some(GEAR_CONNECTION));
        assert_eq!(gear.branch, "extract/billing");
        assert!(gear.deleted.is_empty());
        assert!(gear.files.iter().any(|f| f.path == "gears/billing/src/lib.rs"));
        assert!(gear.text.body.contains("billing/v0.1.0"), "{}", gear.text.body);
        // The project's: written in its tenant, the module gone, the crate in
        // its place.
        let source = &writes[1];
        assert_eq!((source.tenant, source.target.repo.as_str()), (P1, "acme/app"));
        assert_eq!(source.target.base_branch, "trunk");
        assert!(source.deleted.contains(&"app/src/billing/mod.rs".to_owned()));
        assert!(!source.deleted.iter().any(|d| d == "app/src/main.rs"));
        let main = source
            .files
            .iter()
            .find(|f| f.path == "app/src/main.rs")
            .unwrap();
        assert!(main.content.starts_with("pub use billing as billing;\n"), "{}", main.content);
        let manifest = source
            .files
            .iter()
            .find(|f| f.path == "app/Cargo.toml")
            .unwrap();
        assert!(manifest.content.contains("billing = { git = \"https://github.com/acme/gears.git\", tag = \"billing/v0.1.0\" }"));
        assert!(source.text.body.contains(x.gear_pr_url.as_deref().unwrap()));
    }

    // While it is open, it is not opened again.
    let again = svc
        .extract_registry(&ctx, "billing", &extract(), &by(), &files, &repos, &writer)
        .await;
    assert!(matches!(refusal(again), ExtractError::Open { .. }));

    let complete = DecisionInput {
        action: "complete_extraction".into(),
        ..DecisionInput::default()
    };
    // Neither merged: both said, nothing tagged.
    repos
        .present
        .lock()
        .unwrap()
        .insert("acme/app:app/src/billing/mod.rs".into());
    let early = svc
        .complete_extraction(&ctx, "billing", &complete, &by(), &repos, &writer)
        .await;
    match refusal(early) {
        ExtractError::NotMerged { what } => {
            assert!(what.contains("gears/billing/Cargo.toml"), "{what}");
            assert!(what.contains("app/src/billing/mod.rs"), "{what}");
        }
        other => panic!("{other:?}"),
    }
    assert!(writer.tags.lock().unwrap().is_empty());

    // Both merged: tagged in the gear repository, as the organization.
    {
        let mut present = repos.present.lock().unwrap();
        present.clear();
        present.insert("acme/gears:gears/billing/Cargo.toml".into());
    }
    let (entry, decisions) = svc
        .complete_extraction(&ctx, "billing", &complete, &by(), &repos, &writer)
        .await
        .unwrap();
    assert_eq!(entry.entry.state, STATE_EXTRACTED);
    assert_eq!(entry.entry.version.as_deref(), Some("0.1.0"));
    let x = entry.entry.extraction.unwrap();
    assert!(x.completed_at.is_some());
    assert_eq!(x.tagged_commit.as_deref(), Some("7a9"));
    assert_eq!(
        writer.tags.lock().unwrap().as_slice(),
        [(ORG, "acme/gears".to_owned(), "billing/v0.1.0".to_owned())]
    );
    assert_eq!(decisions[0].action, "complete_extraction");
    assert_eq!(decisions[0].to, STATE_EXTRACTED);

    // An extracted gear is extracted once.
    let twice = svc
        .extract_registry(&ctx, "billing", &extract(), &by(), &files, &repos, &writer)
        .await;
    assert!(matches!(refusal(twice), ExtractError::NotRegistered { .. }));
}

#[tokio::test]
async fn extract_needs_a_gear_repository_and_a_ready_gear() {
    let svc = service();
    seeded(&svc, false).await;
    let ctx = ctx_in(ORG);
    let repos = Repos::default();
    let writer = Writer::default();
    let r = svc
        .extract_registry(&ctx, "billing", &extract(), &by(), &Files(repository()), &repos, &writer)
        .await;
    assert_eq!(refusal(r), ExtractError::NoGearRepository);

    let svc = service();
    seeded(&svc, true).await;
    // The module reaches into the rest of the crate.
    let mut files = repository();
    for (p, t) in &mut files {
        if p == "app/src/billing/repo.rs" {
            *t = "use crate::other::Thing;\n".into();
        }
    }
    let r = svc
        .extract_registry(&ctx, "billing", &extract(), &by(), &Files(files), &repos, &writer)
        .await;
    match refusal(r) {
        ExtractError::NotReady { blocking } => {
            assert!(blocking.iter().any(|b| b.starts_with("reaches_out")), "{blocking:?}");
        }
        other => panic!("{other:?}"),
    }
    assert!(writer.writes.lock().unwrap().is_empty());

    // Completing what was never opened.
    let r = svc
        .complete_extraction(
            &ctx,
            "billing",
            &DecisionInput {
                action: "complete_extraction".into(),
                ..DecisionInput::default()
            },
            &by(),
            &repos,
            &writer,
        )
        .await;
    assert_eq!(refusal(r), ExtractError::NotExtracting);
}
