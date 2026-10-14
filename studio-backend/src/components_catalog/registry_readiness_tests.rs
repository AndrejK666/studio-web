use super::*;

const MANIFEST: &str = r#"[package]
name = "app"

[dependencies]
serde = { workspace = true }
serde_json = "1"
async-trait = "0.1"
"#;

/// A repository: paths and texts, the manifest at `app/Cargo.toml`.
fn repo(files: &[(&str, &str)]) -> (Vec<String>, BTreeMap<String, String>) {
    let mut listing = vec!["app/Cargo.toml".to_owned()];
    let mut texts = BTreeMap::from([("app/Cargo.toml".to_owned(), MANIFEST.to_owned())]);
    for (p, t) in files {
        listing.push((*p).to_owned());
        texts.insert((*p).to_owned(), (*t).to_owned());
    }
    (listing, texts)
}

fn run(files: &[(&str, &str)], at: &str) -> Readiness {
    let (listing, texts) = repo(files);
    let unit = locate(&listing, at).expect("a unit");
    let sizes: Vec<(String, Option<i64>)> =
        listing.iter().map(|p| (p.clone(), Some(100))).collect();
    let outside = outside_sources(&listing, &unit).len();
    assess(
        &unit,
        &sizes,
        &texts,
        ReadScope {
            outside_read: outside,
            outside_total: outside,
        },
    )
}

fn check<'a>(r: &'a Readiness, key: &str) -> &'a Check {
    r.checks.iter().find(|c| c.key == key).expect(key)
}

/// A gear that could leave today: port and sdk, its own migrations, nothing
/// outside it touched, nothing touching its insides.
fn clean() -> Vec<(&'static str, &'static str)> {
    vec![
        (
            "app/src/billing/mod.rs",
            "//! Billing. Uses crate::other in a comment only.\npub mod port;\npub mod sdk;\nmod repo;\nmod migrations;\nuse serde::Serialize;\nuse crate::billing::sdk::Invoice;\n",
        ),
        ("app/src/billing/port.rs", "use super::sdk::Invoice;\n"),
        (
            "app/src/billing/sdk.rs",
            "use serde_json::Value;\npub struct Invoice;\n",
        ),
        ("app/src/billing/repo.rs", "use super::sdk::Invoice;\n"),
        (
            "app/src/billing/migrations.rs",
            "pub const M: &str = \"crate::nothing\";\n",
        ),
        (
            "app/src/main.rs",
            "mod billing;\nuse crate::billing::sdk::Invoice;\nuse crate::billing::Invoice as I;\n",
        ),
    ]
}

#[test]
fn a_module_with_a_boundary_its_own_tables_and_no_reach_either_way_is_ready() {
    let r = run(&clean(), "app/src/billing");
    assert_eq!(r.unit.kind, "module");
    assert_eq!(r.unit.module_path, ["billing"]);
    assert_eq!(r.unit.manifest.as_deref(), Some("app/Cargo.toml"));
    for c in &r.checks {
        assert!(c.ok, "{}: {}", c.key, c.summary);
    }
    assert!(r.ready);
    let names: Vec<_> = r.dependencies.iter().map(|d| d.name.as_str()).collect();
    assert_eq!(names, ["serde", "serde_json"]);
    assert!(r.dependencies.iter().all(|d| d.spec.is_some()));
}

#[test]
fn reaching_out_names_the_file_and_line_and_blocks() {
    let mut files = clean();
    files[3] = (
        "app/src/billing/repo.rs",
        "use crate::billing::sdk::Invoice;\nuse crate::{audit::log, billing::port};\nfn f() { super::super::config::get(); }\n",
    );
    let r = run(&files, "app/src/billing");
    let c = check(&r, CHECK_REACHES_OUT);
    assert!(!c.ok && c.blocks);
    let lines: Vec<_> = c.spots.iter().map(|s| (s.path.as_str(), s.line)).collect();
    assert_eq!(
        lines,
        [
            ("app/src/billing/repo.rs", Some(2)),
            ("app/src/billing/repo.rs", Some(3))
        ],
        "crate::audit in a group, and super:: past the module's top; billing::port is its own"
    );
    assert!(!r.ready);
}

#[test]
fn only_tests_reaching_out_is_advice() {
    let mut files = clean();
    files.push((
        "app/src/billing/repo_tests.rs",
        "use crate::test_pg::fresh_database;\n",
    ));
    let r = run(&files, "app/src/billing");
    let c = check(&r, CHECK_REACHES_OUT);
    assert!(!c.ok && !c.blocks, "{}", c.summary);
    assert!(r.ready);
}

#[test]
fn a_path_file_is_as_deep_as_the_module_that_declares_it() {
    let mut files = clean();
    files[3] = (
        "app/src/billing/repo.rs",
        "#[cfg(test)]\n#[path = \"repo_tests.rs\"]\nmod tests;\n",
    );
    files.push((
        "app/src/billing/repo_tests.rs",
        "use super::super::sdk::Invoice;\n",
    ));
    let r = run(&files, "app/src/billing");
    assert!(
        check(&r, CHECK_REACHES_OUT).ok,
        "billing::repo::tests -> super::super is billing"
    );
}

#[test]
fn code_outside_using_a_private_module_blocks_and_sdk_or_exports_do_not() {
    let mut files = clean();
    files.push((
        "app/src/reports.rs",
        "use crate::billing::repo::Rows;\nuse crate::billing::{sdk::Invoice, Invoice};\n",
    ));
    let r = run(&files, "app/src/billing");
    let c = check(&r, CHECK_REACHED_INTO);
    assert!(!c.ok && c.blocks);
    assert_eq!(c.spots.len(), 1);
    assert_eq!(c.spots[0].path, "app/src/reports.rs");
    assert_eq!(c.spots[0].line, Some(1));
}

#[test]
fn a_partial_read_says_so() {
    let (listing, texts) = repo(&clean());
    let unit = locate(&listing, "app/src/billing").unwrap();
    let r = assess(
        &unit,
        &[],
        &texts,
        ReadScope {
            outside_read: 1,
            outside_total: 40,
        },
    );
    assert!(
        check(&r, CHECK_REACHED_INTO)
            .summary
            .contains("read 1 of the crate's 40")
    );
}

#[test]
fn no_port_or_sdk_and_tables_without_migrations_block() {
    let files = [
        ("app/src/shop/mod.rs", "mod repo;\nmod rest;\n"),
        ("app/src/shop/repo.rs", ""),
        ("app/src/shop/rest.rs", ""),
    ];
    let r = run(&files, "app/src/shop");
    let b = check(&r, CHECK_BOUNDARY);
    assert!(
        !b.ok && b.summary.contains("no sdk and no port"),
        "{}",
        b.summary
    );
    let p = check(&r, CHECK_PERSISTENCE);
    assert!(!p.ok && p.blocks);
    assert_eq!(p.spots[0].path, "app/src/shop/repo.rs");
}

#[test]
fn a_name_not_in_the_manifest_is_advice_and_own_submodules_are_not_crates() {
    let mut files = clean();
    files[2] = (
        "app/src/billing/sdk.rs",
        "use chrono::Utc;\nuse repo::Rows;\npub struct Invoice;\n",
    );
    let r = run(&files, "app/src/billing");
    let c = check(&r, CHECK_DEPENDENCIES);
    assert!(!c.ok && !c.blocks);
    assert_eq!(c.spots.len(), 1, "chrono only: repo is the module's own");
    assert!(
        r.dependencies
            .iter()
            .any(|d| d.name == "chrono" && d.spec.is_none())
    );
}

#[test]
fn an_attribute_on_a_file_makes_the_file_and_its_directory_the_unit() {
    let files = [
        ("app/src/connectors/mod.rs", "mod plugin;\n"),
        (
            "app/src/connectors/plugin.rs",
            "mod github;\nuse crate::connectors::driver::D;\n",
        ),
        ("app/src/connectors/plugin/github.rs", ""),
        ("app/src/connectors/driver.rs", ""),
    ];
    let (listing, _) = repo(&files);
    let unit = locate(&listing, "app/src/connectors/plugin.rs").unwrap();
    assert_eq!(unit.path, "app/src/connectors/plugin");
    assert_eq!(unit.module_path, ["connectors", "plugin"]);
    assert_eq!(
        unit.files,
        [
            "app/src/connectors/plugin.rs",
            "app/src/connectors/plugin/github.rs"
        ]
    );
    let r = run(&files, "app/src/connectors/plugin.rs");
    assert_eq!(
        check(&r, CHECK_REACHES_OUT).spots.len(),
        1,
        "its parent's driver stays behind"
    );
}

#[test]
fn a_crate_is_checked_by_its_manifest() {
    let files = [
        (
            "gears/pay/Cargo.toml",
            "[package]\nname = \"pay\"\n[dependencies]\nshared = { path = \"../../shared\" }\nlocal = { path = \"inner\" }\n",
        ),
        ("gears/pay/src/lib.rs", "pub mod sdk;\npub mod port;\n"),
        ("gears/pay/src/sdk.rs", ""),
        ("gears/pay/src/port.rs", ""),
        ("gears/pay/inner/Cargo.toml", ""),
    ];
    let r = run(&files, "gears/pay/src");
    assert_eq!(r.unit.kind, "crate");
    assert_eq!(r.unit.path, "gears/pay");
    let c = check(&r, CHECK_REACHES_OUT);
    assert!(!c.ok && c.blocks);
    assert_eq!(c.spots.len(), 1, "only the path that leaves the crate");
    assert_eq!(c.spots[0].line, Some(4));
    assert!(check(&r, CHECK_REACHED_INTO).ok);
    assert!(check(&r, CHECK_BOUNDARY).ok);
}

#[test]
fn a_unit_too_large_for_one_pull_request_blocks() {
    let (listing, texts) = repo(&clean());
    let unit = locate(&listing, "app/src/billing").unwrap();
    let sizes: Vec<(String, Option<i64>)> = unit
        .files
        .iter()
        .map(|p| (p.clone(), Some(1024 * 1024)))
        .collect();
    let r = assess(&unit, &sizes, &texts, ReadScope::default());
    assert!(!check(&r, CHECK_SIZE).ok);
    assert!(!r.ready);
}

#[test]
fn another_gear_through_its_sdk_or_port_is_a_gear_dependency_not_code_left_behind() {
    let mut files = clean();
    files[3] = (
        "app/src/billing/repo.rs",
        "use crate::llm::port::Complete;\nuse crate::tasks::sdk::{Task, register};\nuse crate::org_scope::OrgAccess;\nuse crate::user::Person;\n",
    );
    files.push(("app/src/user/mod.rs", "pub struct Person;\n"));
    files.push(("app/src/user/port.rs", ""));
    let r = run(&files, "app/src/billing");
    let out = check(&r, CHECK_REACHES_OUT);
    assert_eq!(out.spots.len(), 1, "only org_scope stays behind");
    assert_eq!(out.spots[0].line, Some(3));
    let g = check(&r, CHECK_GEARS);
    assert!(!g.ok && !g.blocks);
    assert_eq!(
        r.gears,
        ["llm", "tasks", "user"],
        "user has a port: its mod.rs exports are its API"
    );
}

#[test]
fn literals_and_comments_hide_nothing_and_keep_the_line_numbers() {
    let text = "let q = '\"';\nlet s = r#\"crate::fake \"quoted\" \"#;\n/* crate::also\n fake */ let c = '\\'';\nuse crate::real::X;\n";
    let code = code_only(text);
    assert_eq!(code.len(), text.len());
    assert_eq!(code.lines().count(), text.lines().count());
    let paths = crate_paths(&code);
    assert_eq!(paths, [(4, vec!["real".to_owned(), "X".to_owned()])]);
}

#[test]
fn super_inside_an_inline_module_climbs_out_of_it_first() {
    let mut files = clean();
    files[3] = (
        "app/src/billing/repo.rs",
        "pub fn f() {}\n#[cfg(test)]\nmod tests {\n    use super::super::sdk::Invoice;\n    use super::super::super::config;\n}\n",
    );
    let r = run(&files, "app/src/billing");
    let c = check(&r, CHECK_REACHES_OUT);
    assert_eq!(c.spots.len(), 1, "{:?}", c.spots);
    assert_eq!(c.spots[0].line, Some(5));
}

#[test]
fn a_crate_named_only_by_path_is_a_dependency_and_a_local_module_is_not() {
    let mut files = clean();
    files[2] = (
        "app/src/billing/sdk.rs",
        "#[async_trait::async_trait]\npub trait T {}\nfn f() { serde_json::json!({}); helpers::x(); }\npub struct Invoice;\n",
    );
    let r = run(&files, "app/src/billing");
    let names: Vec<_> = r.dependencies.iter().map(|d| d.name.as_str()).collect();
    assert_eq!(
        names,
        ["async_trait", "serde", "serde_json"],
        "helpers is not in the manifest"
    );
    assert!(check(&r, CHECK_DEPENDENCIES).ok);
}

#[test]
fn manifest_dependencies_read_every_spelling() {
    let deps = manifest_dependencies(
        "[dependencies]\nserde = \"1\"\ntokio.workspace = true\n[dependencies.async-trait]\nversion = \"0.1\"\n[dev-dependencies]\nrstest = \"0.18\"\n[package]\nname = \"x\"\n",
    );
    let names: Vec<_> = deps.keys().map(String::as_str).collect();
    assert_eq!(names, ["async_trait", "rstest", "serde", "tokio"]);
    assert_eq!(deps["tokio"], "{ workspace = true }");
}
