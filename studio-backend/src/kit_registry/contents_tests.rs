use super::{
    KitContents, MANIFEST_BUILTIN, MANIFEST_CF_STUDIO_KIT, MANIFEST_COPIES, describe, find,
    read_manifest,
};
use crate::kit_registry::service::{builtin_catalogue, official_catalogue};

#[test]
fn every_builtin_kit_has_a_detail() {
    for kit in builtin_catalogue() {
        let slug = kit.slug.clone();
        let detail = describe(kit);
        assert_eq!(detail.kit.slug, slug);
        assert_eq!(detail.manifest, Some(MANIFEST_BUILTIN), "{slug}");
        // A built-in kit brings nothing into a checkout.
        assert!(detail.contents.material.is_empty(), "{slug}");
        for screen in &detail.contents.screens {
            assert!(matches!(screen.kind, "tab" | "section"), "{slug}");
            assert!(detail.kit.levels.contains(&screen.level), "{slug}");
        }
    }
}

#[test]
fn the_builtin_screens_are_today_s_tabs() {
    let screens = |slug: &str| {
        let kit = builtin_catalogue()
            .into_iter()
            .find(|kit| kit.slug == slug)
            .unwrap();
        describe(kit)
            .contents
            .screens
            .into_iter()
            .map(|s| (s.label, s.route))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        screens("project-tests"),
        [
            ("Tests".to_owned(), Some("/tests".to_owned())),
            // Its open pull requests section, which needs project-git's type.
            ("Open pull requests".to_owned(), Some("/tests".to_owned()))
        ]
    );
    // Connections, the project's People and Artifacts are the shell's
    // (ADR-0071 step 6): no kit brings them.
    for gone in ["org-connections", "project-team", "project-artifacts"] {
        assert!(builtin_catalogue().iter().all(|k| k.slug != gone), "{gone}");
    }
    assert_eq!(
        screens("project-git"),
        [("Activity".to_owned(), Some("/projects/activity".to_owned()))]
    );
    // The Spec graph kit's one tab, drawn by spec-graph-mfe.
    assert_eq!(
        screens("spec-graph"),
        [("Spec graph".to_owned(), Some("/spec-graph".to_owned()))]
    );
    // Issues went to the Project model, as Open questions; Timeline to
    // Planning, with no `needs` (ADR-0071 step 4); Activity to Git
    // collaboration (step 5).
    assert_eq!(
        screens("project-domain-model"),
        [
            (
                "Project domain model".to_owned(),
                Some("/domain-model".to_owned())
            ),
            ("Open questions".to_owned(), Some("/issues".to_owned())),
        ]
    );
    assert_eq!(
        screens("project-lifecycle"),
        [
            (
                "Project templates".to_owned(),
                Some("/project-templates".to_owned())
            ),
            ("Timeline".to_owned(), Some("/projects/timeline".to_owned())),
        ]
    );
    assert_eq!(
        screens("project-specs"),
        [
            (
                "Document types".to_owned(),
                Some("/document-types".to_owned())
            ),
            ("Specs".to_owned(), Some("/projects/specs".to_owned())),
        ]
    );
    assert_eq!(
        screens("org-reports"),
        [("Reports".to_owned(), Some("/reports".to_owned()))]
    );
    assert_eq!(
        screens("org-costs"),
        [("Costs".to_owned(), Some("/costs".to_owned()))]
    );
    // A section of the product menu, not a tab.
    let docs = describe(
        builtin_catalogue()
            .into_iter()
            .find(|kit| kit.slug == "studio-api-docs")
            .unwrap(),
    );
    let screen = &docs.contents.screens[0];
    assert_eq!(
        (screen.kind, screen.level.as_str(), screen.slot.as_deref()),
        ("section", "platform", Some("product-menu"))
    );
    assert_eq!(screen.route.as_deref(), Some("/api-docs"));
    assert_eq!(docs.contents.permissions.reads, ["GET /openapi.json"]);

    // Screens still being ported: the tabs are named, a route only where
    // the new portal has one.
    let levels = |slug: &str| {
        let kit = builtin_catalogue()
            .into_iter()
            .find(|kit| kit.slug == slug)
            .unwrap();
        describe(kit)
            .contents
            .screens
            .into_iter()
            .map(|s| (s.level, s.label, s.route))
            .collect::<Vec<_>>()
    };
    let at = |level: &str, label: &str, route: Option<&str>| {
        (level.to_owned(), label.to_owned(), route.map(str::to_owned))
    };
    assert_eq!(
        levels("components"),
        [
            at("platform", "Components", Some("/platform/components")),
            at("platform", "Repositories", Some("/platform/repositories")),
            at(
                "platform",
                "Publication requests",
                Some("/platform/publication-requests")
            ),
            at("organization", "Components", Some("/components")),
        ]
    );
    assert_eq!(
        levels("delivery"),
        [
            at("organization", "Infrastructure", Some("/infrastructure")),
            at("project", "Releases", Some("/releases"))
        ]
    );
    assert_eq!(
        levels("project-product"),
        [
            at("project", "Product", Some("/product")),
            at("project", "Components", Some("/project-components"))
        ]
    );
    assert_eq!(
        levels("project-domain-model"),
        [
            at("project", "Project domain model", Some("/domain-model")),
            at("project", "Open questions", Some("/issues"))
        ]
    );
    // Constructor Research: one organization tab, and the MCP tools that
    // make a Research environment.
    assert_eq!(
        levels("constructor-research"),
        [at(
            "organization",
            "Constructor Research",
            Some("/constructor-research")
        )]
    );
    let research = describe(
        builtin_catalogue()
            .into_iter()
            .find(|kit| kit.slug == "constructor-research")
            .unwrap(),
    );
    let tools: Vec<&str> = research
        .contents
        .mcp_tools
        .iter()
        .map(|t| t.name.as_str())
        .collect();
    assert_eq!(tools, ["research_projects", "research_hardware"]);
    let mcp: Vec<&str> = crate::mcp::tools().iter().map(|t| t.name).collect();
    assert!(tools.iter().all(|t| mcp.contains(t)), "{tools:?}");
    // Gears matcher (ADR-0072): the project's Gear match, out of Product,
    // and the organization's page with its default assembly strategy.
    assert_eq!(
        levels("gears-matcher"),
        [
            at("project", "Gear match", Some("/gear-match")),
            at("organization", "Gears matcher", Some("/gears-matcher"))
        ]
    );
    let matcher = describe(
        builtin_catalogue()
            .into_iter()
            .find(|kit| kit.slug == "gears-matcher")
            .unwrap(),
    );
    let tools: Vec<&str> = matcher
        .contents
        .mcp_tools
        .iter()
        .map(|t| t.name.as_str())
        .collect();
    assert_eq!(
        tools,
        [
            "project_gear_match",
            "project_gear_match_report",
            "gear_match_usage"
        ]
    );
    assert_eq!(matcher.contents.requires, ["project-product"]);
    let inbox: Vec<&str> = matcher
        .contents
        .inbox
        .iter()
        .map(|s| s.id.as_str())
        .collect();
    assert_eq!(inbox, ["gear-match-questions"]);
}

#[test]
fn a_builtin_kit_names_only_routes_the_backend_serves() {
    // The gateway's own document is not a gear's operation.
    const GATEWAY: &[&str] = &["GET /openapi.json"];
    let contract: serde_json::Value =
        serde_json::from_str(include_str!("../../docs/api-contract.json")).unwrap();
    let served: std::collections::BTreeSet<String> = contract["operations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|op| {
            format!(
                "{} {}",
                op["method"].as_str().unwrap(),
                op["path"].as_str().unwrap()
            )
        })
        .collect();
    for kit in builtin_catalogue() {
        let slug = kit.slug.clone();
        let permissions = describe(kit).contents.permissions;
        for route in permissions.reads.iter().chain(&permissions.writes) {
            assert!(
                served.contains(route) || GATEWAY.contains(&route.as_str()),
                "{slug}: {route} is not a route of the backend"
            );
        }
        // A read never changes anything, so it is never a PUT, PATCH or DELETE.
        for route in &permissions.reads {
            assert!(
                route.starts_with("GET ") || route.starts_with("POST "),
                "{slug}: {route}"
            );
        }
        for route in &permissions.writes {
            assert!(!route.starts_with("GET "), "{slug}: {route}");
        }
        let mut all: Vec<&String> = permissions
            .reads
            .iter()
            .chain(&permissions.writes)
            .collect();
        let total = all.len();
        all.sort();
        all.dedup();
        assert_eq!(all.len(), total, "{slug}: a route named twice");
    }
}

#[test]
fn the_official_kits_are_read_from_their_pinned_manifests() {
    let kits = official_catalogue();
    let sdlc = describe(kits[0].clone());
    assert_eq!(sdlc.manifest, Some(MANIFEST_CF_STUDIO_KIT));
    assert_eq!(
        sdlc.contents.kinds,
        ["ADR", "DECOMPOSITION", "DESIGN", "FEATURE", "PRD"]
    );
    let paths: Vec<&str> = sdlc
        .contents
        .material
        .iter()
        .map(|m| m.path.as_str())
        .collect();
    assert!(paths.contains(&"artifacts/PRD/template.md"));
    assert!(paths.contains(&"workflows/pr-review.md"));
    assert!(paths.contains(&"AGENTS.md"));
    assert!(paths.contains(&"scripts/"), "a directory ends in a slash");
    assert!(
        sdlc.contents
            .material
            .iter()
            .all(|m| m.description.is_some())
    );

    let compete = describe(kits[1].clone());
    assert_eq!(compete.manifest, Some(MANIFEST_CF_STUDIO_KIT));
    assert_eq!(compete.contents.kinds.len(), 11);
    assert!(
        compete
            .contents
            .kinds
            .contains(&"COMPARISON-MATRIX".to_owned())
    );
    assert!(
        compete
            .contents
            .material
            .iter()
            .any(|m| m.path == "workflows/compare.md")
    );
    // Neither brings screens, types or code of its own: material only.
    for detail in [&sdlc, &compete] {
        assert!(detail.contents.screens.is_empty());
        assert!(detail.contents.types.is_empty());
        assert!(detail.contents.functions.is_empty());
        assert!(detail.contents.mcp_tools.is_empty());
    }
}

#[test]
fn each_manifest_copy_is_at_the_commit_the_catalogue_pins() {
    // Moving a pin in `official_catalogue()` without replacing the copy would
    // describe a version nobody installs.
    for copy in MANIFEST_COPIES {
        let kit = official_catalogue()
            .into_iter()
            .find(|kit| kit.slug == copy.slug)
            .unwrap();
        assert_eq!(kit.default_version, copy.commit, "{}", copy.slug);
        assert!(super::same_repository(
            copy.repository_url,
            &kit.repository_url
        ));
        assert!(copy.body.contains(copy.commit), "{}", copy.slug);
    }
}

#[test]
fn an_unknown_slug_is_not_found_and_a_known_one_lists_every_section() {
    let library = || {
        let mut all = builtin_catalogue();
        all.extend(official_catalogue());
        all
    };
    assert!(find(library(), "no-such-kit").is_none());
    assert!(find(library(), "not a slug!").is_none());
    assert!(find(Vec::new(), "sdlc").is_none());
    // A slug is matched as the installer normalises it.
    assert_eq!(find(library(), "SDLC").unwrap().kit.slug, "sdlc");
    // Every section is present on the wire, empty or not.
    for kit in library() {
        let detail = find(library(), &kit.slug).unwrap();
        let dto = crate::kit_registry::rest::KitDetailDto::from(detail);
        let json = serde_json::to_value(&dto).unwrap();
        assert!(json.get("manifest").is_some(), "{}", kit.slug);
        let contents = json["contents"].as_object().unwrap();
        for field in [
            "screens",
            "types",
            "rules",
            "functions",
            "services",
            "inbox",
            "mcp_tools",
            "material",
            "kinds",
            "docs",
        ] {
            assert!(contents[field].is_array(), "{} {field}", kit.slug);
        }
        for field in ["reads", "writes", "listens"] {
            assert!(
                contents["permissions"][field].is_array(),
                "{} {field}",
                kit.slug
            );
        }
        for screen in contents["screens"].as_array().unwrap() {
            assert!(screen.get("route").is_some() && screen.get("slot").is_some());
        }
    }
}

#[test]
fn a_kit_pinned_elsewhere_is_not_described() {
    let mut kit = official_catalogue().remove(0);
    kit.default_version = "v9.9.9".to_owned();
    let detail = describe(kit);
    assert_eq!(detail.manifest, None);
    assert_eq!(detail.contents, KitContents::default());

    let mut kit = official_catalogue().remove(0);
    kit.repository_url = "https://github.com/acme/studio-kit-sdlc".to_owned();
    assert_eq!(describe(kit).manifest, None);
}

#[test]
fn a_multi_kit_manifest_answers_for_the_kit_asked() {
    let body = r#"
manifest_version = "1.0"

[[kits]]
slug = "one"

[[kits.resources]]
install_path = "a.md"
description = "A"

[kits.resources.artifacts]
[kits.resources.artifacts."X-ONE"]
template = "a"

[[kits]]
slug = "two"

[[kits.resources]]
install_path = "tools"
type = "directory"
"#;
    let one = read_manifest(body, "one").unwrap();
    assert_eq!(one.material.len(), 1);
    assert_eq!(one.material[0].path, "a.md");
    assert_eq!(one.material[0].description.as_deref(), Some("A"));
    assert_eq!(one.kinds, ["X-ONE"]);
    let two = read_manifest(body, "two").unwrap();
    assert_eq!(two.material[0].path, "tools/");
    assert_eq!(two.material[0].description, None);
    assert!(two.kinds.is_empty());
    assert!(read_manifest(body, "three").is_none());
}

/// A built-in kit's `kit.json` names the micro-frontend that draws each of
/// its screens, and the portal says the same from its side: every
/// `mfe_packages/<package>/mfe.json` extension with `presentation.kit = X`
/// is in a package kit X lists, and every package a kit lists names the kit.
/// A package may draw several kits' screens (`activity-mfe`, `product-mfe`,
/// `infrastructure-mfe`, `projects-mfe`).
#[test]
fn builtin_kits_and_the_portal_s_mfes_name_each_other() {
    use std::collections::BTreeSet;

    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../studio-frontend/src-app/mfe_packages");
    let Ok(dirs) = std::fs::read_dir(&root) else {
        // A checkout without the frontend (a crate-only build) has nothing to
        // hold the manifests to.
        return;
    };
    // (package, kit) and (package, route, kit), as the portal declares them.
    let mut portal: BTreeSet<(String, String)> = BTreeSet::new();
    let mut portal_routes: BTreeSet<(String, String, String)> = BTreeSet::new();
    for dir in dirs.flatten() {
        let Ok(body) = std::fs::read_to_string(dir.path().join("mfe.json")) else {
            continue;
        };
        let package = dir.file_name().to_string_lossy().into_owned();
        let doc: serde_json::Value = serde_json::from_str(&body).unwrap();
        for ext in doc["extensions"].as_array().into_iter().flatten() {
            let Some(kit) = ext["presentation"]["kit"].as_str() else {
                continue;
            };
            portal.insert((package.clone(), kit.to_owned()));
            if let Some(route) = ext["presentation"]["route"].as_str() {
                portal_routes.insert((package.clone(), route.to_owned(), kit.to_owned()));
            }
        }
    }
    assert!(!portal.is_empty(), "no mfe.json under {}", root.display());

    let mut kits: BTreeSet<(String, String)> = BTreeSet::new();
    let mut kit_routes: BTreeSet<(String, String, String)> = BTreeSet::new();
    for kit in builtin_catalogue() {
        let m = crate::kit_registry::manifest::builtin_manifest(&kit.slug).unwrap();
        for s in m.screens {
            let package = s.mfe.unwrap_or_else(|| {
                panic!(
                    "builtin/{}.kit.json: screen `{}` names no `mfe`",
                    kit.slug, s.label
                )
            });
            kits.insert((package.clone(), kit.slug.clone()));
            if let Some(route) = s.route {
                kit_routes.insert((package, route, kit.slug.clone()));
            }
        }
    }

    let unlisted: Vec<_> = portal.difference(&kits).collect();
    assert!(
        unlisted.is_empty(),
        "(package, kit): an mfe.json gives the kit a screen its kit.json does not list: {unlisted:?}"
    );
    let unclaimed: Vec<_> = kits.difference(&portal).collect();
    assert!(
        unclaimed.is_empty(),
        "(package, kit): a kit.json lists a package whose mfe.json does not name the kit: \
         {unclaimed:?}"
    );
    let missing: Vec<_> = kit_routes.difference(&portal_routes).collect();
    assert!(
        missing.is_empty(),
        "(package, route, kit): a kit.json screen no mfe.json extension declares: {missing:?}"
    );
    let undeclared: Vec<_> = portal_routes.difference(&kit_routes).collect();
    assert!(
        undeclared.is_empty(),
        "(package, route, kit): an mfe.json extension no kit.json screen declares: {undeclared:?}"
    );
}
