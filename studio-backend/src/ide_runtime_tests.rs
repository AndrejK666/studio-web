use std::collections::BTreeSet;

use super::*;

fn protocol() -> serde_json::Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("ide-bridge")
        .join("protocol.json");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "{} is the bridge's one source of names: {e}",
            path.display()
        )
    });
    serde_json::from_str(&text).expect("protocol.json is JSON")
}

fn control_of(protocol: &serde_json::Value, version: &str) -> IdeControl {
    let c = &protocol["control"][version];
    let s = |k: &str| -> &'static str {
        Box::leak(c[k].as_str().expect(k).to_owned().into_boxed_str())
    };
    IdeControl {
        path: s("path"),
        header: s("header"),
        token_env: s("tokenEnv"),
    }
}

#[test]
fn the_control_endpoints_are_the_protocols() {
    let protocol = protocol();
    assert_eq!(CONTROL_V2, control_of(&protocol, "v2"));
    assert_eq!(crate::ide_theia::CONTROL_V1, control_of(&protocol, "v1"));
}

#[test]
fn the_capabilities_are_the_protocols() {
    let protocol = protocol();
    let listed: Vec<&str> = protocol["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    let ours: Vec<&str> = Capability::ALL.into_iter().map(Capability::name).collect();
    assert_eq!(ours, listed);
}

#[test]
fn every_method_needs_the_capability_the_protocol_names() {
    let protocol = protocol();
    let methods = protocol["control"]["methods"].as_object().unwrap();
    assert!(!methods.is_empty());
    for (method, capability) in methods {
        assert_eq!(
            method_capability(method).map(Capability::name),
            capability.as_str(),
            "{method}"
        );
    }
}

#[test]
fn ids_are_unique_and_exactly_one_runtime_is_the_default() {
    let ids: Vec<&str> = all().map(|r| r.id).collect();
    let unique: BTreeSet<&str> = ids.iter().copied().collect();
    assert_eq!(ids.len(), unique.len(), "{ids:?}");
    let defaults: Vec<&str> = all().filter(|r| r.default).map(|r| r.id).collect();
    assert_eq!(defaults.len(), 1, "{defaults:?}");
}

#[test]
fn every_runtime_speaks_a_protocol_version_and_names_its_token_for_adoption() {
    let protocol = protocol();
    let known = [control_of(&protocol, "v1"), control_of(&protocol, "v2")];
    // `fake-*` runtimes are the tests' own (studio_session's launch tests).
    for runtime in all().filter(|r| !r.id.starts_with("fake-")) {
        assert!(known.contains(&runtime.control), "{}", runtime.id);
        assert!(
            runtime
                .adopt_token_envs
                .contains(&runtime.control.token_env),
            "{}: adoption must read the token it launched with",
            runtime.id
        );
        for pair in runtime.launch_env {
            assert!(
                pair.contains('='),
                "{}: `{pair}` is not KEY=VALUE",
                runtime.id
            );
        }
    }
}

#[test]
fn theia_is_todays_ide_and_the_default() {
    let theia = default_runtime().unwrap();
    assert_eq!(theia.id, "theia");
    assert_eq!(theia.container_port, 3003);
    assert_eq!(theia.container_name, "theia");
    assert_eq!(theia.control.header, "X-CFS-Theia-Token");
    assert_eq!(theia.control.token_env, "STUDIO_THEIA_S2S_TOKEN");
    assert!(theia.launch_env.is_empty());
    assert_eq!(theia.capability_names().len(), Capability::ALL.len());
}

#[test]
fn vscode_is_the_minimal_flavour_on_v2() {
    let vscode = by_id("vscode").unwrap();
    assert_eq!(vscode.control, CONTROL_V2);
    for missing in [
        Capability::Operations,
        Capability::InstallKit,
        Capability::SharedSession,
        Capability::IdleReport,
        Capability::Desktop,
        Capability::FrameChannel,
    ] {
        assert!(!vscode.can(missing), "{}", missing.name());
    }
    assert_eq!(
        vscode.capability_names(),
        ["open_file", "open_document", "notify", "repositories"]
    );
}

#[test]
fn a_call_the_runtime_cannot_answer_is_a_sentence() {
    let vscode = by_id("vscode").unwrap();
    assert_eq!(
        vscode.cannot(Capability::InstallKit),
        "this IDE (VS Code) cannot install a kit"
    );
}

#[test]
fn a_session_without_a_label_is_the_default_runtimes() {
    assert_eq!(of_label(None).unwrap().id, "theia");
    assert_eq!(of_label(Some("  ")).unwrap().id, "theia");
    assert_eq!(of_label(Some("vscode")).unwrap().id, "vscode");
    assert!(of_label(Some("emacs")).is_none());
}

#[test]
fn a_deployment_names_its_ide_or_takes_the_default() {
    assert_eq!(resolve(None).unwrap().id, "theia");
    assert_eq!(resolve(Some("")).unwrap().id, "theia");
    assert_eq!(resolve(Some("vscode")).unwrap().id, "vscode");
    let err = resolve(Some("emacs")).unwrap_err().to_string();
    assert!(err.contains("no IDE called `emacs`"), "{err}");
    assert!(err.contains("theia") && err.contains("vscode"), "{err}");
}
