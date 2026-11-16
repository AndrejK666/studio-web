use super::{KIND_GEARS, KIND_MATERIAL, KIND_MODEL, KIND_RUNTIME, KitKind, kind_of};
use crate::kit_registry::contents::{KitDetail, describe};
use crate::kit_registry::manifest::{contents_of, read_kit_json};
use crate::kit_registry::service::{
    KitDescriptor, SHELF_ORGANIZATION, builtin_catalogue, official_catalogue,
};

fn kind(detail: &KitDetail) -> (&'static str, Vec<&'static str>) {
    let KitKind { kind, brings } = kind_of(detail);
    (kind, brings)
}

#[test]
fn every_built_in_kit_is_built_on_the_gears() {
    // A built-in kit's screens ship in Studio's portal and its data is the
    // gears': `gears`, plus `model` where its kit.json brings types or fields.
    let mut seen = Vec::new();
    for kit in builtin_catalogue() {
        let slug = kit.slug.clone();
        let detail = describe(kit);
        let (k, brings) = kind(&detail);
        assert_eq!(k, KIND_GEARS, "{slug}");
        assert_eq!(brings[0], KIND_GEARS, "{slug}");
        assert!(!brings.contains(&KIND_RUNTIME), "{slug}");
        assert!(!brings.contains(&KIND_MATERIAL), "{slug}");
        let c = &detail.contents;
        let has_model = !c.types.is_empty()
            || !c.model.fields.is_empty()
            || !c.model.relations.is_empty()
            || !c.model.tabs.is_empty();
        assert_eq!(brings.contains(&KIND_MODEL), has_model, "{slug}");
        seen.push((slug, brings));
    }
    // The ones with types of their own say so.
    let brings = |slug: &str| {
        seen.iter()
            .find(|(s, _)| s == slug)
            .map(|(_, b)| b.clone())
            .unwrap()
    };
    assert_eq!(brings("project-lifecycle"), [KIND_GEARS, KIND_MODEL]);
    assert_eq!(brings("constructor-research"), [KIND_GEARS]);
    assert_eq!(brings("studio-api-docs"), [KIND_GEARS]);
}

#[test]
fn the_official_kits_are_working_material() {
    for kit in official_catalogue() {
        let slug = kit.slug.clone();
        let (k, brings) = kind(&describe(kit));
        assert_eq!(k, KIND_MATERIAL, "{slug}");
        assert_eq!(brings, [KIND_MATERIAL], "{slug}");
    }
}

#[test]
fn an_official_kit_nothing_describes_is_still_material() {
    let mut kit = official_catalogue().remove(0);
    kit.default_version = "0123456789012345678901234567890123456789".to_owned();
    let detail = describe(kit);
    assert_eq!(detail.manifest, None);
    assert_eq!(kind(&detail), (KIND_MATERIAL, vec![KIND_MATERIAL]));
}

fn shelf_kit(json: &str) -> KitDetail {
    let m = read_kit_json(json).expect("reads");
    KitDetail {
        kit: KitDescriptor {
            slug: m.slug.clone(),
            name: m.name.clone(),
            description: String::new(),
            publisher: String::new(),
            visibility: "public".to_owned(),
            source: "github".to_owned(),
            repository_url: String::new(),
            default_version: "abc".to_owned(),
            manifest_path: "kit.json".to_owned(),
            shelf: SHELF_ORGANIZATION.to_owned(),
            levels: m.levels.clone(),
            icon: None,
        },
        contents: contents_of(&m),
        manifest: Some("kit.json"),
    }
}

#[test]
fn a_kit_with_its_own_code_is_runtime_and_lists_the_rest() {
    let detail = shelf_kit(
        r#"{"slug": "hello", "name": "Hello", "levels": ["project"],
            "mfe": ["mfe/hello"],
            "screens": [{"kind": "tab", "level": "project", "label": "Hello", "route": "/hello"}],
            "material": [{"path": "README.md"}]}"#,
    );
    assert_eq!(
        kind(&detail),
        (KIND_RUNTIME, vec![KIND_RUNTIME, KIND_MATERIAL])
    );
    let wasm = shelf_kit(
        r#"{"slug": "calc", "name": "Calc", "levels": ["organization"],
            "functions": [{"name": "add", "runtime": "wasm"}]}"#,
    );
    assert_eq!(kind(&wasm).0, KIND_RUNTIME);
    let agent = shelf_kit(
        r#"{"slug": "helper", "name": "Helper", "levels": ["organization"],
            "functions": [{"name": "summarize", "runtime": "agent"}]}"#,
    );
    assert_eq!(kind(&agent).0, KIND_RUNTIME);
    let service = shelf_kit(
        r#"{"slug": "heavy", "name": "Heavy", "levels": ["organization"],
            "services": [{"name": "indexer"}]}"#,
    );
    assert_eq!(kind(&service).0, KIND_RUNTIME);
}

#[test]
fn a_kit_of_types_only_is_a_model_kit() {
    let detail = shelf_kit(
        r#"{"slug": "risks", "name": "Risks", "levels": ["organization"],
            "model": {"types": [{"name": "risk", "fields": [{"name": "score", "type": "integer"}]}]}}"#,
    );
    assert_eq!(kind(&detail), (KIND_MODEL, vec![KIND_MODEL]));
}

#[test]
fn a_kit_whose_screens_are_studio_s_is_built_on_the_gears() {
    // A tab without a bundle of its own is drawn by Studio's generic screens.
    let detail = shelf_kit(
        r#"{"slug": "board", "name": "Board", "levels": ["project"],
            "screens": [{"kind": "tab", "level": "project", "label": "Board"}],
            "model": {"types": [{"name": "card"}]}}"#,
    );
    assert_eq!(kind(&detail), (KIND_GEARS, vec![KIND_GEARS, KIND_MODEL]));
}
