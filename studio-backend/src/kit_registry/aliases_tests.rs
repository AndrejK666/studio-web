use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::*;
use crate::kit_registry::installed::{
    InstalledStore, KIND_ORGANIZATION, KIND_PROJECT, KitAuthority, KitInstaller, PLATFORM_TENANT,
    Refusal,
};
use crate::kit_registry::service::{BUILTIN_VERSION, builtin_catalogue, official_catalogue};

const ORG: Uuid = Uuid::from_u128(0xa1a5);
const PROJECT: Uuid = Uuid::from_u128(0xa1a6);
const ADMIN: Uuid = Uuid::from_u128(0xad);

/// The alias list, as the step that removes it reads it (ADR-0071 step 7,
/// #1089). Changing this list is changing the alias release: say so in the
/// ADR's migration and in `docs/design/studio-kits.md`.
#[test]
fn the_aliases_are_the_adr_s_and_each_says_when_it_goes() {
    let listed: Vec<(&str, &[&str])> = ALIASES.iter().map(|a| (a.retired, a.resolves_to)).collect();
    assert_eq!(
        listed,
        [
            (
                "project-issues",
                &["project-domain-model", "project-git"][..]
            ),
            (
                "project-activity",
                &["project-git", "project-lifecycle"][..]
            ),
            ("product-releases", &["project-product", "delivery"][..]),
            ("org-infrastructure", &["delivery"][..]),
            ("org-connections", &[][..]),
            ("project-team", &[][..]),
            ("project-artifacts", &[][..]),
        ]
    );
    let builtin: Vec<String> = builtin_catalogue().into_iter().map(|k| k.slug).collect();
    for a in ALIASES {
        // Retired: no built-in kit has the slug any more...
        assert!(
            !builtin.iter().any(|s| s == a.retired),
            "{} is retired",
            a.retired
        );
        // ...and it resolves to built-in kits only.
        for to in a.resolves_to {
            assert!(builtin.iter().any(|s| s == to), "{} → {to}", a.retired);
        }
        // Every alias names the step that removes it.
        assert!(a.removal.contains("step 7") && a.removal.contains("#1089"));
        println!("alias {} → {:?}: {}", a.retired, a.resolves_to, a.removal);
    }
}

/// The alias release is one release: a Studio past [`REMOVE_AFTER`] that
/// still carries an alias fails here, and step 7 removes the table, its
/// readers and this test.
#[test]
fn the_aliases_go_one_release_after_the_merge() {
    let version = |v: &str| -> (u64, u64) {
        let mut parts = v.split('.').map(|p| p.parse::<u64>().unwrap_or(0));
        (parts.next().unwrap_or(0), parts.next().unwrap_or(0))
    };
    assert!(
        ALIASES.is_empty() || version(BUILTIN_VERSION) <= version(REMOVE_AFTER),
        "Studio {BUILTIN_VERSION} still carries the kit slug aliases: remove them (ADR-0071 \
         step 7, #1089, docs/design/studio-kits.md \"Slug aliases\")"
    );
}

/// The files that may name a retired slug in code (a quoted string) during
/// the alias release. Step 7 (#1089) removes the aliases and empties this
/// list: the table, its readers' tests and these assertions.
const MAY_NAME_A_RETIRED_SLUG: &[&str] = &[
    "kit_registry/aliases.rs",
    "kit_registry/aliases_tests.rs",
    "kit_registry/contents_tests.rs",
    "kit_registry/installed_tests.rs",
    "kit_registry/owners_tests.rs",
];

/// No code outside [`MAY_NAME_A_RETIRED_SLUG`] names a retired slug: what
/// reads a kit by its slug names the kit that brings it now, so removing the
/// aliases (step 7) breaks nothing.
#[test]
fn no_code_names_a_retired_slug_outside_the_alias_readers() {
    fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out);
            } else if path
                .extension()
                .is_some_and(|e| e == "rs" || e == "json" || e == "gdl" || e == "toml")
            {
                out.push(path);
            }
        }
    }
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    walk(&src, &mut files);
    let mut stray: Vec<String> = Vec::new();
    for file in files {
        let rel = file
            .strip_prefix(&src)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        if MAY_NAME_A_RETIRED_SLUG.contains(&rel.as_str()) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&file) else {
            continue;
        };
        for a in ALIASES {
            if text.contains(&format!("\"{}\"", a.retired)) {
                stray.push(format!("{rel}: {}", a.retired));
            }
        }
    }
    assert!(
        stray.is_empty(),
        "retired kit slugs named in code (ADR-0071 §8): {stray:?}"
    );
}

#[derive(Default)]
struct Memory {
    docs: Mutex<HashMap<Uuid, InstalledDocument>>,
}

#[async_trait]
impl InstalledStore for Memory {
    async fn read(&self, _: &SecurityContext, tenant: Uuid) -> anyhow::Result<InstalledDocument> {
        Ok(self
            .docs
            .lock()
            .unwrap()
            .get(&tenant)
            .cloned()
            .unwrap_or_default())
    }

    async fn update(
        &self,
        tenant: Uuid,
        change: &mut (
                 dyn for<'d> FnMut(
            &'d mut InstalledDocument,
        ) -> Result<Option<InstalledKit>, Refusal>
                     + Send
             ),
    ) -> Result<Option<InstalledKit>, Refusal> {
        let mut docs = self.docs.lock().unwrap();
        let mut doc = docs.get(&tenant).cloned().unwrap_or_default();
        let answer = change(&mut doc)?;
        docs.insert(tenant, doc);
        Ok(answer)
    }

    async fn organization_of(&self, _: &SecurityContext, tenant: Uuid) -> Uuid {
        if tenant == PROJECT { ORG } else { tenant }
    }

    async fn is_project(&self, _: &SecurityContext, tenant: Uuid) -> bool {
        tenant == PROJECT
    }
}

struct Everyone;

#[async_trait]
impl KitAuthority for Everyone {
    async fn is_platform_admin(&self, _: &SecurityContext) -> bool {
        true
    }
    async fn may_manage(&self, _: &SecurityContext, _: Uuid) -> bool {
        true
    }
}

fn caller(home: Uuid) -> SecurityContext {
    SecurityContext::builder()
        .subject_id(ADMIN)
        .subject_type("user")
        .subject_tenant_id(home)
        .token_scopes(vec!["studio".into()])
        .build()
        .unwrap()
}

fn record(slug: &str) -> InstalledRecord {
    InstalledRecord {
        kit_slug: slug.into(),
        version: "0.0.9".into(),
        shelf: SHELF_BUILTIN.into(),
        installed_by: "someone".into(),
        installed_at: "2026-10-01T00:00:00Z".into(),
    }
}

/// An installer over documents as the stand stores them today: written by
/// a Studio that had the old slugs.
fn stand(docs: &[(Uuid, InstalledDocument)]) -> (KitInstaller, Arc<Memory>) {
    let store = Arc::new(Memory::default());
    store.docs.lock().unwrap().extend(docs.iter().cloned());
    let mut catalogue = builtin_catalogue();
    catalogue.extend(official_catalogue());
    (
        KitInstaller::new(catalogue, store.clone(), Arc::new(Everyone)),
        store,
    )
}

fn slugs(kits: &[InstalledKit]) -> Vec<&str> {
    kits.iter().map(|k| k.kit_slug.as_str()).collect()
}

#[tokio::test]
async fn installations_under_the_old_slugs_count_as_the_kits_they_resolve_to() {
    let (installer, store) = stand(&[
        // The platform removed Issues only, and recorded Activity itself.
        (
            PLATFORM_TENANT,
            InstalledDocument {
                kits: vec![record("project-activity")],
                removed_builtin: vec!["project-issues".into()],
                ..InstalledDocument::default()
            },
        ),
        // The organization installed Infrastructure for itself.
        (
            ORG,
            InstalledDocument {
                kits: vec![record("org-infrastructure")],
                ..InstalledDocument::default()
            },
        ),
        // A project installed Product & Releases for itself.
        (
            PROJECT,
            InstalledDocument {
                kits: vec![record("product-releases")],
                ..InstalledDocument::default()
            },
        ),
    ]);
    let org = installer.installed(&caller(ORG), ORG).await.unwrap();
    // Issues was removed while the Project model and Git stayed: the merged
    // kits apply (ADR-0071 §8), and nothing names a retired slug.
    assert_eq!(
        slugs(&org.base),
        [
            "assistant",
            "components",
            "delivery",
            "org-costs",
            "org-reports",
            "project-domain-model",
            "project-git",
            "project-lifecycle",
            "project-product",
            "project-specs",
            "project-tests",
            "spec-mapping",
            "studio-api-docs"
        ]
    );
    // The base record of Activity is now one of each kit it went to.
    for k in ["project-git", "project-lifecycle"] {
        let kit = org.base.iter().find(|x| x.kit_slug == k).unwrap();
        assert!(!kit.by_default, "{k} is recorded");
        assert_eq!(kit.version, BUILTIN_VERSION);
    }
    assert_eq!(slugs(&org.organization), ["delivery"]);
    assert_eq!(org.organization[0].kind, KIND_ORGANIZATION);
    assert!(!slugs(&org.effective).iter().any(|s| resolve(s).is_some()));

    let project = installer
        .installed_in_project(&caller(ORG), PROJECT)
        .await
        .unwrap();
    assert_eq!(slugs(&project.project), ["delivery", "project-product"]);
    assert!(project.project.iter().all(|k| k.kind == KIND_PROJECT));

    // During the alias release an old client still finds the old slugs in
    // `effective`, wherever everything they resolve to applies.
    let old = with_retired(&project.effective);
    for retired in [
        "project-issues",
        "project-activity",
        "product-releases",
        "org-infrastructure",
        // The shell's: always.
        "org-connections",
        "project-team",
        "project-artifacts",
    ] {
        let k = old.iter().find(|k| k.kit_slug == retired).unwrap();
        assert!(k.retired, "{retired}");
    }
    // The report says what was shown again.
    let reports = installer.rename_reports(&caller(ORG), PROJECT).await;
    assert!(
        reports.iter().any(
            |r| r.shown_again.contains(&"project-domain-model".to_owned())
                && r.shown_again.contains(&"project-git".to_owned())
        ),
        "{reports:?}"
    );

    // Nothing was written by reading.
    assert_eq!(
        store.docs.lock().unwrap()[&PLATFORM_TENANT].removed_builtin,
        ["project-issues"]
    );
    // The sweep stores every document under the current slugs, and the
    // answer does not change.
    for t in [PLATFORM_TENANT, ORG, PROJECT] {
        assert!(installer.rename_installations(t).await.unwrap(), "{t}");
        assert!(!installer.rename_installations(t).await.unwrap(), "once");
    }
    {
        let docs = store.docs.lock().unwrap();
        for doc in docs.values() {
            assert!(!needs_migration(doc));
        }
        assert!(docs[&PLATFORM_TENANT].removed_builtin.is_empty());
        assert_eq!(
            docs[&PROJECT]
                .kits
                .iter()
                .map(|r| r.kit_slug.as_str())
                .collect::<Vec<_>>(),
            ["delivery", "project-product"]
        );
    }
    let again = installer
        .installed_in_project(&caller(ORG), PROJECT)
        .await
        .unwrap();
    assert_eq!(again.effective, project.effective);
}

#[tokio::test]
async fn a_merged_kit_stays_removed_only_where_everything_merged_into_it_was() {
    let removed = |slugs: &[&str]| InstalledDocument {
        removed_builtin: slugs.iter().map(|s| (*s).to_owned()).collect(),
        ..InstalledDocument::default()
    };
    // Both halves of delivery removed: delivery stays removed, and so does
    // the product, which only product-releases made.
    let (installer, _) = stand(&[(
        PLATFORM_TENANT,
        removed(&["product-releases", "org-infrastructure"]),
    )]);
    let base = installer.installed(&caller(ORG), ORG).await.unwrap().base;
    assert!(!slugs(&base).contains(&"delivery"));
    assert!(!slugs(&base).contains(&"project-product"));
    // One half removed: delivery applies again, reported.
    let (installer, _) = stand(&[(PLATFORM_TENANT, removed(&["org-infrastructure"]))]);
    let base = installer.installed(&caller(ORG), ORG).await.unwrap().base;
    assert!(slugs(&base).contains(&"delivery"));
    assert!(slugs(&base).contains(&"project-product"));
    let reports = installer.rename_reports(&caller(ORG), ORG).await;
    assert_eq!(reports[0].shown_again, ["delivery"]);
    // A surviving slug removed with all that merged into it stays removed;
    // with part of it kept, it applies again.
    let (installer, _) = stand(&[(
        PLATFORM_TENANT,
        removed(&["project-git", "project-issues", "project-activity"]),
    )]);
    let base = installer.installed(&caller(ORG), ORG).await.unwrap().base;
    assert!(!slugs(&base).contains(&"project-git"));
    // project-issues also went into the Project model, which was not removed.
    assert!(slugs(&base).contains(&"project-domain-model"));
    // A document naming no retired slug is already current: its removal of
    // project-git stands (a removal from before the merge with nothing else
    // removed cannot be told from one after it).
    let (installer, _) = stand(&[(PLATFORM_TENANT, removed(&["project-git"]))]);
    let base = installer.installed(&caller(ORG), ORG).await.unwrap().base;
    assert!(!slugs(&base).contains(&"project-git"));
    // With a retired slug beside it, the document is from before the merge:
    // part of what project-git merges was kept, so it applies again.
    let (installer, _) = stand(&[(PLATFORM_TENANT, removed(&["project-git", "project-issues"]))]);
    let base = installer.installed(&caller(ORG), ORG).await.unwrap().base;
    assert!(slugs(&base).contains(&"project-git"));
}

#[tokio::test]
async fn a_request_naming_a_retired_slug_acts_on_what_it_resolves_to() {
    let (installer, _) = stand(&[]);
    let platform = caller(PLATFORM_TENANT);
    installer
        .uninstall_base(&platform, "product-releases")
        .await
        .unwrap();
    let base = installer.installed(&caller(ORG), ORG).await.unwrap().base;
    assert!(!slugs(&base).contains(&"project-product"));
    assert!(!slugs(&base).contains(&"delivery"));
    installer
        .install_base(&platform, "org-infrastructure", None)
        .await
        .unwrap();
    let base = installer.installed(&caller(ORG), ORG).await.unwrap().base;
    assert!(slugs(&base).contains(&"delivery"));
}

#[tokio::test]
async fn an_installation_of_what_went_to_the_shell_is_nothing_and_its_tab_always_shows() {
    let (installer, store) = stand(&[
        (
            PLATFORM_TENANT,
            InstalledDocument {
                removed_builtin: vec!["org-connections".into(), "project-team".into()],
                ..InstalledDocument::default()
            },
        ),
        (
            ORG,
            InstalledDocument {
                kits: vec![record("project-artifacts")],
                ..InstalledDocument::default()
            },
        ),
    ]);
    let org = installer.installed(&caller(ORG), ORG).await.unwrap();
    assert!(org.organization.is_empty());
    for gone in ["org-connections", "project-team", "project-artifacts"] {
        assert!(!slugs(&org.effective).contains(&gone));
        // An old portal still finds them: the shell always has them.
        assert!(slugs(&with_retired(&org.effective)).contains(&gone));
    }
    installer
        .rename_installations(PLATFORM_TENANT)
        .await
        .unwrap();
    installer.rename_installations(ORG).await.unwrap();
    {
        let docs = store.docs.lock().unwrap();
        assert!(docs[&PLATFORM_TENANT].removed_builtin.is_empty());
        assert!(docs[&ORG].kits.is_empty());
    }
    // Asking for one is refused: there is no kit to install.
    assert!(matches!(
        installer
            .install_for_organization(&caller(ORG), ORG, "org-connections", None)
            .await,
        Err(Refusal::Invalid(_))
    ));
}
