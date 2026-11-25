//! The one path: the same stages, numbers and words whichever gear asks.

use serde_json::json;
use uuid::Uuid;

use super::DeliveryState as D;
use super::*;
use crate::organizations::status::{FindingFacts, ModelFacts, PathFacts, SpecQueues};

fn step(id: &'static str, state: D, reason: &str) -> DeliveryStep {
    DeliveryStep {
        id,
        state,
        reason: reason.to_owned(),
        action: None,
        build_id: None,
        environment_id: None,
        deployment_id: None,
    }
}

fn action(kind: &str, label: &str) -> Option<StageAction> {
    Some(StageAction::new(kind, label))
}

fn gears(n: u32) -> ProductFacts {
    ProductFacts {
        gears: n,
        resolves: Some(true),
        errors: 0,
        written: false,
    }
}

fn ids(stages: &[Stage]) -> Vec<&'static str> {
    stages.iter().map(|s| s.id).collect()
}

#[test]
fn every_stage_has_its_one_number() {
    let numbers: Vec<u32> = STAGES.iter().map(|id| number_of(id)).collect();
    assert_eq!(numbers, (1..=9).collect::<Vec<u32>>());
    assert_eq!(Stage::new("product", StageState::Todo, "").number, 5);
    assert_eq!(Stage::new("deploy", StageState::Todo, "").tab, "releases");
    assert_eq!(Stage::new("findings", StageState::Todo, "").tab, "issues");
    assert_eq!(number_of("kind"), 0);
}

#[test]
fn the_product_is_configured_then_saved() {
    let unknown = product_stage(None, None, None);
    assert_eq!(unknown.state, StageState::Unknown);

    let empty = product_stage(Some(&gears(0)), None, None);
    assert_eq!(empty.state, StageState::Todo);
    assert_eq!(
        empty.action.as_ref().map(|a| a.kind.as_str()),
        Some("open_product")
    );

    let picked = product_stage(Some(&gears(3)), None, None);
    assert_eq!(picked.state, StageState::Todo);
    assert_eq!(
        picked.cause,
        "3 gears, resolves, not saved to product.gdl yet."
    );
    assert_eq!(
        picked.action.as_ref().map(|a| a.kind.as_str()),
        Some("save_product")
    );

    let saved = product_stage(Some(&gears(3)), Some(4), None);
    assert_eq!(saved.state, StageState::Done);
    assert_eq!(saved.cause, "3 gears, resolves, saved as revision 4.");
    assert!(saved.action.is_none());

    let in_repository = product_stage(Some(&gears(0)), Some(0), None);
    assert_eq!(in_repository.state, StageState::Done);
}

#[test]
fn the_verdict_on_the_saved_revision_beats_an_older_preview() {
    let mut p = gears(2);
    p.resolves = Some(false);
    p.errors = 5;
    // The preview failed; the check kept for revision 7 resolves.
    let ok = CheckFacts {
        ok: true,
        errors: 0,
        revision: Some(7),
    };
    assert_eq!(
        product_stage(Some(&p), Some(7), Some(&ok)).state,
        StageState::Done
    );
    // A check of another revision says nothing of this one: the preview speaks.
    let stale = CheckFacts {
        revision: Some(6),
        ..ok
    };
    let failed = product_stage(Some(&p), Some(7), Some(&stale));
    assert_eq!(failed.state, StageState::Failed);
    assert_eq!(failed.cause, "2 gears, does not resolve (5 errors).");
    // Never checked, never previewed: saved, not checked yet.
    let mut fresh = gears(2);
    fresh.resolves = None;
    assert_eq!(
        product_stage(Some(&fresh), Some(1), None).cause,
        "2 gears, not checked yet, saved as revision 1."
    );
}

#[test]
fn the_kept_check_is_the_newest_of_any_profile() {
    let record = json!({"checks": {
        "dev": {"ok": false, "errors": 2, "revision": 3, "checked_at": "2026-11-20T10:00:00Z"},
        "prod": {"ok": true, "errors": 0, "revision": 4, "checked_at": "2026-11-21T10:00:00Z"},
        "old": {"note": "no verdict"}
    }});
    assert_eq!(
        check_facts(&record),
        Some(CheckFacts {
            ok: true,
            errors: 0,
            revision: Some(4)
        })
    );
    assert_eq!(check_facts(&json!({})), None);
}

#[test]
fn a_studio_build_record_comes_first_then_the_ci_run() {
    let mut record = step(
        "build",
        D::Failed,
        "Build b-7 failed: the gear api did not build.",
    );
    record.build_id = Some("b-7".into());
    record.action = action("open_gear", "Open the gear");
    let passed = BuildFacts::Last {
        status: "passed".into(),
        sha: "abc1234".into(),
    };
    let s = build_stage(Some(&record), Some(&passed));
    assert_eq!(s.state, StageState::Failed);
    assert_eq!(s.object.as_deref(), Some("b-7"));
    assert_eq!(
        s.action.as_ref().map(|a| a.kind.as_str()),
        Some("open_gear")
    );

    // No record in Studio: the CI run on the main branch says it.
    let nothing = step("build", D::Next, "Nothing is built yet.");
    let s = build_stage(Some(&nothing), Some(&passed));
    assert_eq!(s.state, StageState::Done);
    assert_eq!(
        s.cause,
        "The last CI build on the main branch passed at abc1234."
    );
    let failed = BuildFacts::Last {
        status: "failed".into(),
        sha: String::new(),
    };
    assert_eq!(
        build_stage(Some(&nothing), Some(&failed)).state,
        StageState::Failed
    );
    // Neither: the delivery path's own word.
    let s = build_stage(Some(&nothing), Some(&BuildFacts::Never));
    assert_eq!(
        (s.state, s.cause.as_str()),
        (StageState::Todo, "Nothing is built yet.")
    );
    assert_eq!(build_stage(None, None).state, StageState::Unknown);
}

#[test]
fn the_delivery_stages_say_what_releases_says() {
    let env = Uuid::from_u128(5);
    let deployed = Uuid::from_u128(6);
    let mut build = step("build", D::Done, "Build b-1 passed.");
    build.build_id = Some("b-1".into());
    let image = step("image", D::Done, "0.1.0 is published with 2 images.");
    let mut environment = step(
        "environment",
        D::Blocked,
        "1 thing is missing before a deploy to dev.",
    );
    environment.environment_id = Some(env);
    environment.action = action("provide_secret", "Provide it");
    let mut running = step("running", D::Later, "Waits for the steps before it.");
    running.deployment_id = None;
    running.environment_id = Some(deployed);
    let path = vec![
        step("product", D::Done, "The product is described (revision 2)."),
        build,
        image,
        environment,
        running,
    ];
    let stages = delivery_stages(&DeliveryFacts {
        product: Some(&gears(2)),
        revision: Some(2),
        check: None,
        ci: None,
        path: Some(&path),
    });
    assert_eq!(
        ids(&stages),
        ["product", "build", "images", "environment", "deploy"]
    );
    let numbers: Vec<u32> = stages.iter().map(|s| s.number).collect();
    assert_eq!(numbers, [5, 6, 7, 8, 9]);
    let env_stage = &stages[3];
    assert_eq!(env_stage.state, StageState::Blocked);
    assert!(env_stage.focus);
    assert_eq!(env_stage.object, Some(env.to_string()));
    assert_eq!(
        env_stage.action.as_ref().map(|a| a.kind.as_str()),
        Some("provide_secret")
    );
    assert_eq!(stages[4].state, StageState::Todo);
    assert_eq!(stages.iter().filter(|s| s.focus).count(), 1);
}

#[test]
fn without_the_delivery_path_the_stages_after_the_build_are_not_known() {
    let passed = BuildFacts::Last {
        status: "passed".into(),
        sha: "abc1234".into(),
    };
    let stages = delivery_stages(&DeliveryFacts {
        product: Some(&gears(1)),
        revision: Some(1),
        check: None,
        ci: Some(&passed),
        path: None,
    });
    let states: Vec<StageState> = stages.iter().map(|s| s.state).collect();
    assert_eq!(
        states,
        [
            StageState::Done,
            StageState::Done,
            StageState::Unknown,
            StageState::Unknown,
            StageState::Unknown
        ]
    );
    // Nothing known to do: no focus rather than a made-up one.
    assert!(stages.iter().all(|s| !s.focus));
}

fn status_facts() -> PathFacts {
    PathFacts {
        repositories: Some(1),
        synced: Some(1),
        specs: Some(SpecQueues {
            bound: 10,
            needs_review: 0,
            not_scanned: 0,
        }),
        model: Some(ModelFacts {
            documents: 10,
            extracted: 10,
            facts: 40,
            running: false,
        }),
        findings: Some(FindingFacts { open: 2, high: 1 }),
        kind: None,
        product: Some(gears(2)),
        build: Some(BuildFacts::Never),
    }
}

#[test]
fn the_whole_path_is_the_status_then_the_delivery_with_one_focus() {
    let facts = status_facts();
    let steps = status::project_path_for(&facts, &Kits::All);
    let up = upstream(&steps, &facts);
    assert_eq!(ids(&up), ["sources", "documents", "model", "findings"]);
    // A high finding blocks.
    assert_eq!(up[3].state, StageState::Blocked);
    let down = delivery_stages(&DeliveryFacts {
        product: facts.product.as_ref(),
        revision: None,
        check: None,
        ci: facts.build.as_ref(),
        path: None,
    });
    let all = join(up, down, &Kits::All);
    assert_eq!(all.len(), 9);
    let focus: Vec<&str> = all.iter().filter(|s| s.focus).map(|s| s.id).collect();
    assert_eq!(focus, ["findings"]);
    // The product waits to be saved: to do, not current, as the focus is earlier.
    let product = all.iter().find(|s| s.id == "product").expect("product");
    assert_eq!(product.state, StageState::Todo);
}

#[test]
fn a_kit_that_does_not_apply_leaves_its_stages_out_and_the_numbers_stay() {
    let mut facts = status_facts();
    facts.findings = Some(FindingFacts { open: 0, high: 0 });
    let kits = Kits::Only(vec![
        status::PRODUCT_KIT.to_owned(),
        status::DELIVERY_KIT.to_owned(),
    ]);
    let steps = status::project_path_for(&facts, &kits);
    let up = upstream(&steps, &facts);
    let down = delivery_stages(&DeliveryFacts {
        product: facts.product.as_ref(),
        revision: None,
        check: None,
        ci: facts.build.as_ref(),
        path: None,
    });
    let all = join(up, down, &kits);
    assert_eq!(
        ids(&all),
        [
            "sources",
            "product",
            "build",
            "images",
            "environment",
            "deploy"
        ]
    );
    assert_eq!(all[1].number, 5);
    // Sources is done; the product, to be saved, is what to do now.
    assert_eq!(all[1].state, StageState::Current);
    assert!(all[1].focus);
}

#[test]
fn the_wire_carries_every_stage_as_it_is() {
    let mut s = Stage::new("deploy", StageState::Running, "Deploying to dev.");
    s.focus = true;
    s.object = Some("d-1".into());
    let v = serde_json::to_value(ProjectStageDto::from(&s)).expect("json");
    assert_eq!(v["id"], "deploy");
    assert_eq!(v["number"], 9);
    assert_eq!(v["title"], "Deploy");
    assert_eq!(v["state"], "running");
    assert_eq!(v["cause"], "Deploying to dev.");
    assert_eq!(v["tab"], "releases");
    assert_eq!(v["object"], "d-1");
    assert_eq!(v["kit"], "delivery");
    assert_eq!(v["focus"], true);
}
