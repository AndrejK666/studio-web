use super::*;

fn quality() -> Quality {
    serde_json::from_value(json!({
        "grades": [{ "min": 90, "g": "A" }, { "min": 75, "g": "B" }, { "min": 60, "g": "C" }, { "min": 40, "g": "D" }, { "min": 0, "g": "E" }],
        "capUntilProd": "B",
        "areas": [{ "id": "spec", "title": "Specification" }, { "id": "qa", "title": "Quality assurance" }],
        "criteria": [
            { "a": "spec", "label": "PRD is written", "field": "prd", "test": "b==done", "fix": "Finish the PRD" },
            { "a": "spec", "label": "Decisions are recorded", "field": "adr", "test": "n>=2", "fix": "Record ADRs" },
            { "a": "qa", "label": "E2E suite exists", "field": "e2e", "test": "b==yes", "fix": "Add a suite" },
            { "a": "qa", "label": "Coverage is published", "field": "coverage", "test": "filled", "fix": "Publish coverage" },
            { "a": "qa", "label": "Tests are proportionate", "field": "@testratio", "test": "==ok", "fix": "Add tests" },
            { "a": "qa", "label": "Path owner is named", "field": "owner", "test": "s==good", "fix": "Add CODEOWNERS" },
            { "a": "qa", "label": "Released", "field": "lastrelease", "test": "notnone", "fix": "Cut a release" },
            { "a": "qa", "label": "Every commit signed", "field": "dco", "test": "ratio==1", "fix": "Sign off" },
            { "a": "qa", "label": "Specs track the code", "field": "@specfresh", "test": "==fresh", "fix": "Update specs" },
            { "a": "qa", "label": "Advisories", "field": "advisories", "test": "s!=none", "fix": "Add SBOM" }
        ]
    }))
    .unwrap()
}

fn values(v: Value) -> Map<String, Value> {
    serde_json::from_value(v).unwrap()
}

fn passed(g: &Value) -> Vec<String> {
    g["parts"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|p| p["pass"] == true)
        .map(|p| p["label"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn each_test_reads_its_field_the_way_the_rule_says() {
    let v = values(json!({
        "prd": { "b": "done" },
        "adr": { "b": "7", "n": 7 },
        "e2e": { "b": "yes", "s": "good" },
        "owner": { "b": "@someone", "s": "good" },
        "lastrelease": { "b": "v0.2.8" },
        "dco": { "b": "24/34", "s": "bad" },
        "codeloc": { "n": 1000 }, "unitloc": { "n": 200 }, "e2eloc": { "n": 150 },
        "lifecycle": { "b": "in prod" }
    }));
    let g = grade(&quality(), &v);
    assert_eq!(
        passed(&g),
        vec![
            "PRD is written",
            "Decisions are recorded",
            "E2E suite exists",
            "Tests are proportionate",
            "Path owner is named",
            "Released",
        ]
    );
    // 6 of 10: C, and in production, so no cap applies.
    assert_eq!(g["b"], "C");
    assert_eq!(g["n"], 60);
    assert_eq!(g["s"], "watch");
    assert_eq!(g["capped"], false);
    assert_eq!(g["parts"][0]["area"], "Specification");
}

#[test]
fn unknown_fails_rather_than_passing_by_omission() {
    let g = grade(&quality(), &values(json!({})));
    assert!(passed(&g).is_empty());
    assert_eq!(g["b"], "E");
    assert_eq!(g["s"], "bad");
}

#[test]
fn a_gear_not_in_production_is_capped() {
    let everything = json!({
        "prd": { "b": "done" }, "adr": { "n": 9 }, "e2e": { "b": "yes" }, "coverage": { "b": "81%" },
        "owner": { "s": "good" }, "lastrelease": { "b": "v1.0.0" }, "dco": { "b": "10/10" },
        "codeloc": { "n": 100 }, "unitloc": { "n": 100 }, "advisories": { "b": "0 open", "s": "good" },
        "lifecycle": { "b": "in qa" }
    });
    let g = grade(&quality(), &values(everything.clone()));
    // 9 of 10 is an A, but not in production.
    assert_eq!(g["n"], 90);
    assert_eq!(g["b"], "B");
    assert_eq!(g["capped"], true);
    let mut shipped = everything;
    shipped["lifecycle"] = json!({ "b": "mature" });
    let g = grade(&quality(), &values(shipped));
    assert_eq!(g["b"], "A");
}

#[test]
fn thin_tests_and_partial_sign_off_fail() {
    let v = values(json!({
        "codeloc": { "n": 1000 }, "unitloc": { "n": 100 },
        "dco": { "b": "9/10" },
        "lastrelease": { "b": "none" }
    }));
    let g = grade(&quality(), &v);
    assert!(passed(&g).is_empty());
}

#[test]
fn the_committed_gear_schema_carries_the_playgrounds_criteria() {
    let schema = crate::components_catalog::field_schema::builtin_schemas()
        .into_iter()
        .find(|s| s.describes == crate::components_catalog::gts::GEAR_TYPE)
        .unwrap();
    let q = schema.quality.expect("the gear schema grades");
    assert_eq!(q.criteria.len(), 24);
    assert_eq!(q.areas.len(), 6);
    // Every criterion names an area that exists.
    assert!(
        q.criteria
            .iter()
            .all(|c| q.areas.iter().any(|a| a.id == c.a))
    );
}

#[test]
fn a_failed_check_is_told_apart_from_one_with_no_answer() {
    // The PRD is known and not done; coverage has no answer; the test ratio
    // can be worked out from the lines; spec freshness never can.
    let v = values(json!({
        "prd": { "b": "draft" },
        "coverage": null,
        "codeloc": { "n": 1000 },
        "unitloc": { "n": 100 },
    }));
    let g = grade(&quality(), &v);
    let part = |label: &str| {
        g["parts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["label"] == label)
            .unwrap()
            .clone()
    };

    assert_eq!(
        (
            part("PRD is written")["pass"].clone(),
            part("PRD is written")["known"].clone()
        ),
        (json!(false), json!(true))
    );
    assert_eq!(
        part("Coverage is published")["known"],
        json!(false),
        "a cleared answer is no answer"
    );
    assert_eq!(
        part("E2E suite exists")["known"],
        json!(false),
        "an absent field is no answer"
    );
    assert_eq!(
        part("Tests are proportionate")["known"],
        json!(true),
        "derived from the lines it has"
    );
    assert_eq!(
        part("Specs track the code")["known"],
        json!(false),
        "nothing can answer it yet"
    );
}
