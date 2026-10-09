//! The project's own gears, offered beside the catalogue's.
//!
//! A project that writes gears of its own -- Studio itself, whose backend
//! declares two dozen in `studio-backend/src` -- needs them among the
//! candidates: a capability one of them fills is not a gap. The components
//! catalogue reads them out of the project's repository
//! (`ComponentCatalog::project_gears`); this module puts them into the set the
//! rules match against, and labels every candidate that lives in the
//! repository so a person can tell "use this" from "you already have this".
//!
//! A gear in both places is ONE candidate, under the catalogue's name and with
//! the catalogue's facts (versions, what the engine says, a member's values),
//! because those are more than a repository read gives. It is labelled as in
//! this repository all the same, and when the catalogue has no profile for it
//! the repository's reading stands in, so it is not ranked as unscanned when
//! the code is right there.

use std::collections::BTreeMap;

use serde_json::{Map, Value};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::rest::CandidateDto;
use crate::components_catalog::port::{ComponentCatalog, Registry, project_gears_of};

/// The project's own gears, or none when they cannot be read: they add to the
/// catalogue's answer, which stands without them.
///
/// Taken from the organization's registry (ADR-0041) when it has found
/// anything in the project -- kept between reads, so a plan no longer reads
/// the repositories -- and otherwise read on demand, as before. Either way in
/// the same shape: `origin: project` and the `path` in the repository.
pub(super) async fn project_gears(
    catalog: &dyn ComponentCatalog,
    registry: Option<&dyn Registry>,
    ctx: &SecurityContext,
    project_id: Uuid,
) -> (Vec<Value>, Map<String, Value>) {
    if let Some(registry) = registry {
        match registry.project_entries(ctx, project_id).await {
            Ok(entries) => {
                let found = project_gears_of(&entries, project_id);
                if !found.0.is_empty() {
                    return found;
                }
            }
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), "spec-mapping: the registry unreadable; reading the project's repositories");
            }
        }
    }
    catalog
        .project_gears(ctx, &project_id.to_string())
        .await
        .unwrap_or_else(|e| {
            tracing::warn!(error = %format!("{e:#}"), "spec-mapping: the project's own gears unreadable");
            (Vec::new(), Map::new())
        })
}

/// Add the project's gears to the catalogue's, one entry per gear. Answers
/// the name every candidate in the repository goes by, with its path there.
pub(super) fn with_project_gears(
    components: &mut Vec<Value>,
    profiles: &mut Map<String, Value>,
    (gears, mut gear_profiles): (Vec<Value>, Map<String, Value>),
) -> BTreeMap<String, String> {
    let mut in_repo = BTreeMap::new();
    for gear in gears {
        let Some(name) = gear.get("name").and_then(Value::as_str).map(str::to_owned) else {
            continue;
        };
        let path = gear
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let profile = gear_profiles.remove(&name);
        let catalogued = components.iter().find_map(|c| {
            c.get("name")
                .and_then(Value::as_str)
                .filter(|n| n.eq_ignore_ascii_case(&name))
                .map(str::to_owned)
        });
        let key = match catalogued {
            Some(catalogued) => catalogued,
            None => {
                components.push(gear);
                name
            }
        };
        if let Some(profile) = profile
            && !profiles.contains_key(&key)
        {
            profiles.insert(key.clone(), profile);
        }
        in_repo.insert(key, path);
    }
    in_repo
}

/// Label the candidates that live in the project's repository.
pub(super) fn mark_in_repo<'a>(
    candidates: impl IntoIterator<Item = &'a mut CandidateDto>,
    in_repo: &BTreeMap<String, String>,
) {
    for candidate in candidates {
        if let Some(path) = in_repo.get(&candidate.name) {
            candidate.origin = "project".to_owned();
            candidate.path = (!path.is_empty()).then(|| path.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec_mapping::plan::{self, BuildState, Vocabulary};
    use serde_json::json;

    fn local(name: &str, path: &str, description: &str) -> (Value, Value) {
        (
            json!({ "name": name, "kind": "gear", "description": description,
                    "origin": "project", "path": path }),
            json!({ "gear_name": name, "auto": { "gear_status": "built" } }),
        )
    }

    fn gears(items: &[(Value, Value)]) -> (Vec<Value>, Map<String, Value>) {
        (
            items.iter().map(|(n, _)| n.clone()).collect(),
            items
                .iter()
                .map(|(n, p)| (n["name"].as_str().unwrap().to_owned(), p.clone()))
                .collect(),
        )
    }

    #[test]
    fn a_gear_only_the_repository_has_becomes_a_candidate() {
        let mut components = vec![json!({ "name": "cf-gears-ledger", "kind": "gear",
                                           "description": "double-entry ledger" })];
        let mut profiles = Map::new();
        let in_repo = with_project_gears(
            &mut components,
            &mut profiles,
            gears(&[local(
                "studio-spec-mapping",
                "studio-backend/src/spec_mapping",
                "from a project's specification to the gears that build it",
            )]),
        );
        assert_eq!(components.len(), 2);
        assert_eq!(
            in_repo["studio-spec-mapping"],
            "studio-backend/src/spec_mapping"
        );

        let rows = plan::plan(
            &["specification".to_owned()],
            &components,
            &profiles,
            &Vocabulary::default(),
        );
        let candidate = &rows[0].candidates[0];
        assert_eq!(candidate.name, "studio-spec-mapping");
        assert_eq!(candidate.built, BuildState::Built);
        assert!(!rows[0].gap);
    }

    #[test]
    fn a_gear_the_catalogue_also_has_is_one_candidate_under_its_catalogue_name() {
        let mut components = vec![json!({ "name": "cf-gears-ledger", "kind": "gear",
                                           "description": "ledger", "newest_version": "1.2.0" })];
        let mut profiles = Map::new();
        let in_repo = with_project_gears(
            &mut components,
            &mut profiles,
            gears(&[local("CF-Gears-Ledger", "gears/ledger", "a ledger")]),
        );
        assert_eq!(components.len(), 1, "no second entry for the same gear");
        assert_eq!(components[0]["newest_version"], "1.2.0");
        assert_eq!(in_repo["cf-gears-ledger"], "gears/ledger");
        // No catalogue profile: the repository's reading stands in.
        assert_eq!(profiles["cf-gears-ledger"]["auto"]["gear_status"], "built");
    }

    #[test]
    fn the_catalogues_profile_is_kept_over_the_repositorys() {
        let mut components = vec![json!({ "name": "cf-gears-ledger", "kind": "gear" })];
        let mut profiles = Map::new();
        profiles.insert(
            "cf-gears-ledger".into(),
            json!({ "auto": { "gear_status": "docs-only", "gdl_runs": { "s": "good" } } }),
        );
        with_project_gears(
            &mut components,
            &mut profiles,
            gears(&[local("cf-gears-ledger", "gears/ledger", "")]),
        );
        assert_eq!(
            profiles["cf-gears-ledger"]["auto"]["gear_status"],
            "docs-only"
        );
    }

    #[test]
    fn only_candidates_in_the_repository_are_labelled() {
        let candidate = |name: &str| CandidateDto {
            name: name.into(),
            kind: "gear".into(),
            step: "evidence".into(),
            contracts: Vec::new(),
            passage: None,
            cites: None,
            version: None,
            decision: None,
            declared: false,
            score: 1,
            why: Vec::new(),
            built: "built".into(),
            composable: "undescribed".into(),
            composable_why: None,
            origin: "catalogue".into(),
            path: None,
        };
        let mut candidates = [candidate("mine"), candidate("theirs")];
        let in_repo = BTreeMap::from([("mine".to_owned(), "src/mine".to_owned())]);
        mark_in_repo(candidates.iter_mut(), &in_repo);
        assert_eq!(candidates[0].origin, "project");
        assert_eq!(candidates[0].path.as_deref(), Some("src/mine"));
        assert_eq!(candidates[1].origin, "catalogue");
        assert_eq!(candidates[1].path, None);
    }
}
