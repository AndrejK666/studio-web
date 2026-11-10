use super::*;

const OPS: &str = r#"{
  "slug": "ops-runbooks",
  "name": "Ops runbooks",
  "description": "Runbooks and an on-call tab",
  "publisher": "Acme",
  "version": "1.2.0",
  "levels": ["organization", "project"],
  "screens": [{"kind": "tab", "level": "project", "label": "Runbooks"}],
  "model": {"types": [{"name": "runbook", "label": "Runbook", "description": "A procedure"}]},
  "rules": [{"name": "page-on-call"}],
  "functions": [{"name": "summarize", "runtime": "agent"}],
  "inbox": [{"id": "stale-runbooks", "label": "Runbooks nobody checked this quarter"}],
  "mcp_tools": [{"name": "runbook_run", "description": "Run a runbook"}],
  "permissions": {"reads": ["gts.cf.studio.domain.project.v1~"]},
  "material": [{"path": "runbooks/"}],
  "kinds": ["RUNBOOK"]
}"#;

#[test]
fn a_kit_json_says_every_section_a_kit_brings() {
    let m = read_kit_json(OPS).unwrap();
    assert_eq!(m.slug, "ops-runbooks");
    let c = contents_of(&m);
    assert_eq!(c.screens.len(), 1);
    assert_eq!(c.screens[0].kind, "tab");
    assert_eq!(
        c.types[0].gts, "gts.cf.studio.kit.ops_runbooks.runbook.v1~",
        "a kit's type is catalogued under the kit's namespace"
    );
    assert_eq!(c.types[0].name, "Runbook");
    assert_eq!(c.rules[0].name, "page-on-call");
    assert_eq!(c.functions[0].runtime, "agent");
    assert_eq!(c.inbox[0].id, "stale-runbooks");
    assert_eq!(c.mcp_tools[0].name, "runbook_run");
    assert_eq!(c.permissions.reads.len(), 1);
    assert_eq!(c.material[0].path, "runbooks/");
    assert_eq!(c.kinds, ["RUNBOOK"]);
}

#[test]
fn project_lifecycle_is_a_built_in_kit_that_brings_a_model() {
    let m = builtin_manifest("project-lifecycle").expect("compiled in");
    let overlay = overlay_of(&m).unwrap().expect("it brings a model");
    assert!(
        overlay
            .fields
            .iter()
            .any(|f| f.on == "project" && f.name == "phase")
    );
    assert_eq!(overlay.lifecycles[0].field, "phase");
    assert_eq!(
        contents_of(&m).types[0].gts,
        "gts.cf.studio.kit.project_lifecycle.phase.v1~"
    );
    assert!(builtin_manifest("project-tests").is_none());
    // And one Inbox source: a project waiting in its phase on its owner.
    let source = &m.inbox[0];
    assert_eq!(source.id, "phase-waiting");
    assert_eq!(source.query.as_ref().unwrap()["type"], "project");
    assert!(source.query.as_ref().unwrap().to_string().contains("$me"));
}

#[test]
fn a_kit_json_that_does_not_check_is_refused() {
    let with = |key: &str, value: &str| {
        let mut v: serde_json::Value = serde_json::from_str(OPS).unwrap();
        v[key] = serde_json::from_str(value).unwrap();
        v.to_string()
    };
    // A key the manifest does not have: a typo, never ignored.
    assert!(read_kit_json(&with("screnes", "[]")).is_err());
    assert!(read_kit_json(&with("slug", "\"Ops Runbooks\"")).is_err());
    assert!(read_kit_json(&with("name", "\"\"")).is_err());
    // The platform's level is the base kits'.
    assert!(read_kit_json(&with("levels", r#"["platform"]"#)).is_err());
    assert!(
        read_kit_json(&with(
            "screens",
            r#"[{"kind": "tab", "level": "workspace", "label": "x"}]"#
        ))
        .is_err(),
        "a screen on a level the kit does not name"
    );
    assert!(
        read_kit_json(&with(
            "screens",
            r#"[{"kind": "page", "level": "project", "label": "x"}]"#
        ))
        .is_err()
    );
    assert!(read_kit_json(&with("functions", r#"[{"name": "f", "runtime": "lua"}]"#)).is_err());
    assert!(
        read_kit_json(&with(
            "inbox",
            r#"[{"id": "a", "label": "x"}, {"id": "a", "label": "y"}]"#
        ))
        .is_err()
    );
    assert!(read_kit_json(&with("model", "[]")).is_err());
    assert!(
        read_kit_json(&with(
            "inbox",
            r#"[{"id": "a", "label": "x", "query": {"where": {}}}]"#
        ))
        .is_err(),
        "an inbox query names its type"
    );
    // The model overlay is read and checked with the manifest.
    assert!(read_kit_json(&with("model", r#"{"types": [{"name": "Bad Name"}]}"#)).is_err());
    assert!(read_kit_json(&with("model", r#"{"tables": []}"#)).is_err());
    assert!(read_kit_json(&with("manifest_version", "\"2\"")).is_err());
    assert!(read_kit_json("not json").is_err());
}

const TOML_TWO: &str = r#"
manifest_version = "1.0"

[[kits]]
slug = "prd"
name = "Product requirements"

[[kits.resources]]
id = "t"
install_path = "artifacts/PRD/template.md"
type = "file"

[kits.resources.artifacts.PRD]
x = 1

[[kits]]
slug = "adr"
name = "Decisions"
"#;

#[test]
fn a_cf_studio_kit_toml_brings_material_for_one_kit() {
    assert_eq!(
        toml_kits(TOML_TWO),
        [
            ("prd".to_owned(), "Product requirements".to_owned()),
            ("adr".to_owned(), "Decisions".to_owned())
        ]
    );
    // Several kits: the caller says which.
    assert!(read_cf_studio_kit(TOML_TWO, None).is_err());
    let m = read_cf_studio_kit(TOML_TWO, Some("prd")).unwrap();
    assert_eq!(m.name, "Product requirements");
    assert_eq!(m.levels, ["project"]);
    assert_eq!(m.material[0].path, "artifacts/PRD/template.md");
    assert_eq!(m.kinds, ["PRD"]);
    assert!(m.model.is_none());
    assert!(read_cf_studio_kit(TOML_TWO, Some("nope")).is_err());
    assert!(read_cf_studio_kit("", None).is_err());
}
