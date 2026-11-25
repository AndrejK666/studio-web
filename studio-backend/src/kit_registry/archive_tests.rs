use std::collections::BTreeMap;
use std::io::Read;

use async_trait::async_trait;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::*;
use crate::kit_registry::contents::{describe, official_manifest_text};
use crate::kit_registry::installed::Refusal;
use crate::kit_registry::manifest::read_kit_json;
use crate::kit_registry::service::{
    KitDescriptor, SHELF_ORGANIZATION, builtin_catalogue, official_catalogue,
};
use crate::kit_registry::shelf::{Fetched, KitOrigin, SourceInput};

const ORG: Uuid = Uuid::from_u128(0xc31d);

#[tokio::test]
async fn ide_source_stages_only_the_selected_kits_resources_and_refuses_missing_files() {
    let manifest = br#"
[[kits]]
slug = "guide"
[[kits.resources]]
source = "rules/check"
type = "directory"
[[kits]]
slug = "other"
[[kits.resources]]
source = "unrelated.md"
type = "file"
"#;
    let origin = KitOrigin {
        connection_id: ORG,
        provider: "github".into(),
        repository: "tests/kits".into(),
        path: "package".into(),
        git_ref: None,
        commit: "a".repeat(40),
        manifest_file: CF_STUDIO_KIT_TOML.into(),
        added_by: "tester".into(),
        added_at: String::new(),
        refreshed_at: None,
    };
    let mut reader = Files {
        files: BTreeMap::from([
            (format!("package/{CF_STUDIO_KIT_TOML}"), manifest.to_vec()),
            ("package/rules/check/check.md".into(), vec![0xff]),
            ("package/unrelated.md".into(), b"private".to_vec()),
        ]),
        ..Default::default()
    };
    let files = ide_source(&reader, ORG, "guide", &origin).await.unwrap();
    assert_eq!(
        files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
        vec![CF_STUDIO_KIT_TOML, "rules/check/check.md"],
    );
    assert_eq!(files[1].content, "/w==");
    use base64::Engine;
    let manifest = base64::engine::general_purpose::STANDARD
        .decode(&files[0].content)
        .unwrap();
    let manifest = std::str::from_utf8(&manifest).unwrap();
    assert!(
        manifest.contains("guide") && !manifest.contains("other"),
        "{manifest}"
    );

    reader.files.remove("package/rules/check/check.md");
    let error = ide_source(&reader, ORG, "guide", &origin)
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("kit source is incomplete"), "{error}");
}

/// Every entry of a `.tar.gz`, checking each header's checksum.
fn entries(gz: &[u8]) -> Vec<(String, Vec<u8>)> {
    let mut tar = Vec::new();
    flate2::read::GzDecoder::new(gz)
        .read_to_end(&mut tar)
        .expect("gzip");
    assert_eq!(tar.len() % 512, 0, "a tar is whole blocks");
    let mut out = Vec::new();
    let mut at = 0;
    while at + 512 <= tar.len() {
        let h = &tar[at..at + 512];
        if h.iter().all(|b| *b == 0) {
            break;
        }
        let field = |r: std::ops::Range<usize>| {
            String::from_utf8_lossy(&h[r])
                .trim_end_matches('\0')
                .trim()
                .to_owned()
        };
        let sum: u32 = h
            .iter()
            .enumerate()
            .map(|(i, b)| {
                if (148..156).contains(&i) {
                    32
                } else {
                    u32::from(*b)
                }
            })
            .sum();
        assert_eq!(u32::from_str_radix(&field(148..154), 8).unwrap(), sum);
        assert_eq!(&h[257..263], b"ustar\0");
        let (name, prefix) = (field(0..100), field(345..500));
        let size = usize::from_str_radix(&field(124..136), 8).unwrap();
        let full = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        out.push((full, tar[at + 512..at + 512 + size].to_vec()));
        at += 512 + size.div_ceil(512) * 512;
    }
    out
}

fn names(gz: &[u8]) -> Vec<String> {
    entries(gz).into_iter().map(|(n, _)| n).collect()
}

fn text_of(gz: &[u8], name: &str) -> String {
    entries(gz)
        .into_iter()
        .find(|(n, _)| n == name)
        .map(|(_, b)| String::from_utf8(b).unwrap())
        .unwrap_or_else(|| panic!("no {name}"))
}

/// A repository of files at any commit; `fail` answers every read with an
/// error.
#[derive(Default)]
struct Files {
    files: BTreeMap<String, Vec<u8>>,
    fail: bool,
}

#[async_trait]
impl KitSourceReader for Files {
    async fn fetch(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: &SourceInput,
    ) -> Result<Fetched, Refusal> {
        Err(Refusal::Invalid("not here".into()))
    }

    async fn read_file(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        origin: &KitOrigin,
        path: &str,
    ) -> Result<Option<Vec<u8>>, Refusal> {
        self.read_at(ctx, org, &RepoAt::from(origin), path).await
    }

    async fn list_at(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: &RepoAt,
    ) -> Result<Vec<(String, Option<i64>)>, Refusal> {
        if self.fail {
            return Err(Refusal::Invalid("the host said no".into()));
        }
        Ok(self
            .files
            .iter()
            .map(|(p, b)| (p.clone(), Some(b.len() as i64)))
            .collect())
    }

    async fn read_at(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: &RepoAt,
        path: &str,
    ) -> Result<Option<Vec<u8>>, Refusal> {
        if self.fail {
            return Err(Refusal::Invalid("the host said no".into()));
        }
        Ok(self.files.get(path).cloned())
    }
}

fn library_kit(slug: &str) -> KitDescriptor {
    builtin_catalogue()
        .into_iter()
        .chain(official_catalogue())
        .find(|k| k.slug == slug)
        .unwrap()
}

fn toml(slug: &str) -> &'static str {
    official_manifest_text(&library_kit(slug)).unwrap()
}

#[test]
fn only_safe_paths_go_into_an_archive() {
    assert_eq!(
        safe_path("artifacts/ADR/template.md").as_deref(),
        Some("artifacts/ADR/template.md")
    );
    assert_eq!(safe_path("scripts/").as_deref(), Some("scripts"));
    for bad in [
        "",
        "/etc/passwd",
        "../secret",
        "a/../../b",
        "a/./b",
        "a//b",
        "C:/x",
        "a\\b",
        "a\u{0}b",
        &"x".repeat(241),
    ] {
        assert_eq!(safe_path(bad), None, "{bad:?}");
    }
    let mut archive = Archive::new("kit");
    assert!(!archive.add("../escape", b"x".to_vec()));
    assert!(!archive.add("big", vec![0u8; MAX_FILE_BYTES + 1]));
    assert!(archive.add("ok/file.txt", b"x".to_vec()));
    assert_eq!(archive.paths(), ["ok/file.txt"]);
    assert_eq!(archive.notes.len(), 2);
}

#[test]
fn a_long_path_is_split_into_the_ustar_prefix() {
    let mut archive = Archive::new("kit");
    let long = format!("{}/{}/file.md", "d".repeat(90), "e".repeat(60));
    assert!(archive.add(&long, b"hello".to_vec()));
    let gz = archive.finish("# readme").unwrap();
    let all = entries(&gz);
    assert_eq!(all[0].0, "kit/README.md");
    assert_eq!(all[1], (format!("kit/{long}"), b"hello".to_vec()));
}

#[test]
fn the_official_kits_material_comes_from_each_resources_source() {
    let sdlc = toml_material(toml("sdlc"), "sdlc");
    assert!(sdlc.contains(&Wanted {
        into: "material/artifacts/ADR/template.md".into(),
        from: "artifacts/ADR/template.md".into(),
        directory: false,
    }));
    let compete = toml_material(toml("compete"), "compete");
    assert!(compete.contains(&Wanted {
        into: "material/scripts".into(),
        from: "kits/compete/scripts".into(),
        directory: true,
    }));
    assert!(compete.contains(&Wanted {
        into: "material/AGENTS.md".into(),
        from: "kits/compete/agents-res.md".into(),
        directory: false,
    }));
    // As many as the kit's page lists.
    for (slug, wanted) in [("sdlc", &sdlc), ("compete", &compete)] {
        let detail = describe(library_kit(slug));
        assert_eq!(wanted.len(), detail.contents.material.len(), "{slug}");
    }
    assert!(toml_material(toml("sdlc"), "nope").is_empty());
}

#[tokio::test]
async fn a_built_in_kit_s_archive_holds_its_manifest_model_and_claims() {
    let mut detail = describe(library_kit("project-lifecycle"));
    with_tool_descriptions(&mut detail.contents);
    let gz = build(&detail, None, None, &Files::default(), ORG)
        .await
        .unwrap();
    assert_eq!(
        names(&gz),
        [
            "project-lifecycle/README.md",
            "project-lifecycle/kit.gdl",
            "project-lifecycle/kit.json",
            "project-lifecycle/model/overlay.json",
            "project-lifecycle/model/contents.json",
            "project-lifecycle/claims.json",
        ]
    );
    let readme = text_of(&gz, "project-lifecycle/README.md");
    assert!(
        readme.contains("Its screens ship in Studio's portal image"),
        "{readme}"
    );
    assert!(readme.contains("rendered by Studio from"), "{readme}");
    assert!(!readme.contains("Partial"), "{readme}");
    assert_eq!(
        text_of(&gz, "project-lifecycle/kit.json"),
        crate::kit_registry::manifest::builtin_manifest_text("project-lifecycle").unwrap()
    );
    let gdl = text_of(&gz, "project-lifecycle/kit.gdl");
    assert!(
        gdl.contains("model = path(\"model/overlay.json\")"),
        "{gdl}"
    );
    let overlay: Value =
        serde_json::from_str(&text_of(&gz, "project-lifecycle/model/overlay.json")).unwrap();
    assert!(overlay.get("lifecycles").is_some());
    let model: Value =
        serde_json::from_str(&text_of(&gz, "project-lifecycle/model/contents.json")).unwrap();
    assert_eq!(model["types"][0]["brings"], "new");
    let claims: Value =
        serde_json::from_str(&text_of(&gz, "project-lifecycle/claims.json")).unwrap();
    assert!(!claims["gears"].as_array().unwrap().is_empty());
    // Each claimed tool carries its description from the MCP registry.
    let tools = claims["mcp_tools"].as_array().unwrap();
    assert!(!tools.is_empty());
    assert!(
        tools.iter().all(|t| t["description"].is_string()),
        "{tools:?}"
    );
}

#[tokio::test]
async fn an_official_kit_s_archive_reads_its_material_at_the_pin() {
    let detail = describe(library_kit("sdlc"));
    let wanted = toml_material(toml("sdlc"), "sdlc");
    let mut repo = Files::default();
    for w in &wanted {
        if w.directory {
            repo.files
                .insert(format!("{}/one.md", w.from), b"in a directory".to_vec());
        } else {
            repo.files
                .insert(w.from.clone(), w.from.as_bytes().to_vec());
        }
    }
    // A file the manifest names that the repository does not have.
    let gone = wanted.iter().find(|w| !w.directory).unwrap().from.clone();
    repo.files.remove(&gone);
    let gz = build(&detail, None, None, &repo, ORG).await.unwrap();
    let all = names(&gz);
    assert!(all.contains(&"sdlc/.cf-studio-kit.toml".to_owned()));
    assert!(all.contains(&"sdlc/kit.gdl".to_owned()));
    assert!(!all.iter().any(|n| n.starts_with("sdlc/model/overlay")));
    let material = all
        .iter()
        .filter(|n| n.starts_with("sdlc/material/"))
        .count();
    assert_eq!(material, wanted.len() - 1);
    assert_eq!(
        text_of(&gz, "sdlc/material/artifacts/ADR/rules.md"),
        "artifacts/ADR/rules.md"
    );
    let readme = text_of(&gz, "sdlc/README.md");
    assert!(readme.contains("## Partial"), "{readme}");
    assert!(readme.contains(&gone), "{readme}");
}

#[tokio::test]
async fn a_repository_that_does_not_answer_leaves_a_partial_archive_with_a_note() {
    let detail = describe(library_kit("compete"));
    let repo = Files {
        fail: true,
        ..Files::default()
    };
    let gz = build(&detail, None, None, &repo, ORG).await.unwrap();
    let all = names(&gz);
    assert!(all.contains(&"compete/kit.gdl".to_owned()));
    assert!(!all.iter().any(|n| n.starts_with("compete/material/")));
    let readme = text_of(&gz, "compete/README.md");
    assert!(readme.contains("could not be read"), "{readme}");
    assert!(readme.contains("could not be listed"), "{readme}");
}

#[tokio::test]
async fn an_organization_s_kit_archive_reads_beside_its_manifest() {
    let manifest = read_kit_json(
        r#"{"slug": "ops", "name": "Ops", "levels": ["project"],
            "mfe": ["mfe/board"],
            "screens": [{"kind": "tab", "level": "project", "label": "Board", "route": "/board"}],
            "material": [{"path": "runbooks/"}, {"path": "README.md"}]}"#,
    )
    .unwrap();
    let origin = KitOrigin {
        connection_id: Uuid::from_u128(0xc0),
        provider: "github".into(),
        repository: "acme/kits".into(),
        path: "ops".into(),
        git_ref: None,
        commit: "1111111111111111111111111111111111111111".into(),
        manifest_file: "kit.json".into(),
        added_by: "a".into(),
        added_at: "2026-11-16T00:00:00Z".into(),
        refreshed_at: None,
    };
    let kit = crate::kit_registry::shelf::ShelfKit {
        kit: KitDescriptor {
            slug: "ops".into(),
            name: "Ops".into(),
            description: String::new(),
            publisher: "Acme".into(),
            visibility: "public".into(),
            source: "github".into(),
            repository_url: "https://github.com/acme/kits".into(),
            default_version: origin.commit.clone(),
            manifest_path: "kit.json".into(),
            shelf: SHELF_ORGANIZATION.into(),
            levels: vec!["project".into()],
            icon: None,
        },
        origin,
        manifest,
    };
    let detail = crate::kit_registry::shelf::detail(&kit);
    let mut repo = Files::default();
    repo.files
        .insert("ops/kit.json".into(), b"{\"as\": \"written\"}".to_vec());
    repo.files
        .insert("ops/README.md".into(), b"readme".to_vec());
    repo.files
        .insert("ops/runbooks/restart.md".into(), b"restart".to_vec());
    repo.files
        .insert("ops/mfe/board/remoteEntry.js".into(), b"js".to_vec());
    repo.files
        .insert("ops/mfe/board/assets/a.js".into(), b"js".to_vec());
    repo.files.insert("elsewhere/x.md".into(), b"no".to_vec());
    let gz = build(&detail, Some(&kit), None, &repo, ORG).await.unwrap();
    assert_eq!(
        names(&gz),
        [
            "ops/README.md",
            "ops/kit.gdl",
            "ops/kit.json",
            "ops/model/contents.json",
            "ops/claims.json",
            "ops/material/README.md",
            "ops/material/runbooks/restart.md",
            "ops/mfe/board/assets/a.js",
            "ops/mfe/board/remoteEntry.js",
        ]
    );
    assert_eq!(text_of(&gz, "ops/kit.json"), "{\"as\": \"written\"}");
    assert_eq!(
        kind_of(&detail).kind,
        crate::kit_registry::kind::KIND_RUNTIME
    );
    assert_eq!(file_name(&detail), "ops-111111111111.tar.gz");
}

#[test]
fn every_kit_says_what_its_gdl_is_rendered_from_and_which_manifest_it_has() {
    for kit in builtin_catalogue() {
        let detail = describe(kit);
        assert_eq!(source_file(&detail), Some("kit.json"));
        assert!(rendered_from(&detail).is_some());
    }
    for kit in official_catalogue() {
        let detail = describe(kit);
        assert_eq!(source_file(&detail), Some(".cf-studio-kit.toml"));
        assert_eq!(rendered_from(&detail), Some(".cf-studio-kit.toml"));
    }
}
