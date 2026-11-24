//! One Research environment per (Studio project, Research project) (#1053).
//!
//! The deploy dialog made a project's own Research environment from a name:
//! the Research project's, and the hardware's id start when one was picked.
//! A second hardware choice, a second Research project of the same name, or
//! a second sign-in each forked another environment for the same Research
//! project. Now the Research project's id is the key: a request to add a
//! Research environment for a Research project the project already has one
//! for changes that one (its hardware, its connection) instead, whatever
//! name it asks for; and [`plan`] merges the duplicates made before.
//!
//! A merge never takes away what a person can see happened: an environment
//! with a deployment, a build, a configuration secret or a namespace stays,
//! and only the ones with nothing are removed, into the one kept.

use std::collections::{BTreeMap, HashSet};

use uuid::Uuid;

use super::model::{BindingList, Environment, EnvironmentInput, EnvironmentKind};

/// The Research project `e` runs in, if it is a Research environment.
fn research_project(e: &Environment) -> Option<&str> {
    (e.kind == EnvironmentKind::Research)
        .then(|| e.research.as_ref().map(|r| r.project.trim()))
        .flatten()
        .filter(|p| !p.is_empty())
}

/// Which of several is kept when none has history: the plainest name (the
/// one without a hardware or id suffix), then the oldest, then the id.
fn plainest<'a>(group: impl Iterator<Item = &'a Environment>) -> Option<&'a Environment> {
    group.min_by(|a, b| {
        (a.name.len(), &a.updated_at, a.id).cmp(&(b.name.len(), &b.updated_at, b.id))
    })
}

/// The project's own Research environment `input` would add another of: the
/// one for the same Research project. `None` for a cluster environment, or a
/// Research project the project has none for yet.
pub fn reused<'a>(own: &'a [Environment], input: &EnvironmentInput) -> Option<&'a Environment> {
    if input.kind != EnvironmentKind::Research {
        return None;
    }
    let wanted = input.research.as_ref()?.project.trim();
    plainest(own.iter().filter(|e| research_project(e) == Some(wanted)))
}

/// One Research project's environments, merged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Merge {
    pub research_project: String,
    /// The environment that stays.
    pub keep: Uuid,
    /// The ones removed into it: nothing was deployed or built there.
    pub remove: Vec<Uuid>,
    /// Others for the same Research project that stay because they have
    /// history.
    pub kept_with_history: Vec<Uuid>,
}

/// What to merge among `own`, given the environments with history (a
/// deployment, a build, a secret, a namespace): per Research project with
/// more than one environment, the one kept and those removed. Nothing for a
/// Research project whose every other environment has history.
pub fn plan(own: &[Environment], with_history: &HashSet<Uuid>) -> Vec<Merge> {
    let mut groups: BTreeMap<&str, Vec<&Environment>> = BTreeMap::new();
    for e in own {
        if let Some(p) = research_project(e) {
            groups.entry(p).or_default().push(e);
        }
    }
    let mut out = Vec::new();
    for (project, group) in groups {
        if group.len() < 2 {
            continue;
        }
        let lived: Vec<&Environment> = group
            .iter()
            .copied()
            .filter(|e| with_history.contains(&e.id))
            .collect();
        let keep = if lived.is_empty() {
            plainest(group.iter().copied())
        } else {
            plainest(lived.iter().copied())
        };
        let Some(keep) = keep else { continue };
        let remove: Vec<Uuid> = group
            .iter()
            .filter(|e| e.id != keep.id && !with_history.contains(&e.id))
            .map(|e| e.id)
            .collect();
        if remove.is_empty() {
            continue;
        }
        out.push(Merge {
            research_project: project.to_owned(),
            keep: keep.id,
            remove,
            kept_with_history: lived
                .iter()
                .filter(|e| e.id != keep.id)
                .map(|e| e.id)
                .collect(),
        });
    }
    out
}

/// Apply `merges` to a project's bindings row: the removed environments go,
/// and a binding of one moves to the one kept when that has none (one
/// binding per environment, ADR-0057); otherwise it goes with it. Whether
/// anything changed.
pub fn apply(row: &mut BindingList, merges: &[Merge]) -> bool {
    let mut changed = false;
    for m in merges {
        let gone: HashSet<Uuid> = m.remove.iter().copied().collect();
        let before = row.environments.len();
        row.environments.retain(|e| !gone.contains(&e.id));
        changed |= row.environments.len() != before;
        let mut kept_bound = row.items.iter().any(|b| b.environment_id == m.keep);
        let before = row.items.clone();
        row.items.retain_mut(|b| {
            if !gone.contains(&b.environment_id) {
                return true;
            }
            if kept_bound {
                return false;
            }
            b.environment_id = m.keep;
            kept_bound = true;
            true
        });
        changed |= row.items != before;
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::super::model::{Binding, ResearchTarget};
    use super::*;

    fn env(id: u128, name: &str, project: &str, hardware: Option<&str>, at: &str) -> Environment {
        let mut e: Environment = serde_json::from_value(serde_json::json!({
            "id": Uuid::from_u128(id),
            "name": name,
            "kind": "research",
            "connection_id": Uuid::from_u128(900),
            "updated_by": "u",
            "updated_at": at,
        }))
        .unwrap();
        e.research = Some(ResearchTarget {
            project: project.into(),
            hardware: hardware.map(str::to_owned),
        });
        e
    }

    fn input(project: &str) -> EnvironmentInput {
        EnvironmentInput {
            name: "research-whatever-71c6fd".into(),
            description: String::new(),
            kind: EnvironmentKind::Research,
            connection_id: Uuid::from_u128(901),
            research: Some(ResearchTarget {
                project: project.into(),
                hardware: Some("71c6fd".into()),
            }),
            registry: String::new(),
            registry_connection_id: None,
            namespace_pattern: None,
            database: Default::default(),
            database_image: None,
            protected: false,
            promote_from: None,
            projects: None,
            previews: None,
            strictness: None,
            boundaries: Default::default(),
        }
    }

    /// The stand's Studioweb project on 2026-11-23, as far as names go.
    fn stand() -> Vec<Environment> {
        vec![
            env(
                1,
                "research-example-project",
                "f899d4",
                None,
                "2026-11-19T13:11",
            ),
            env(
                2,
                "research-example-project-71c6fd",
                "8fae83",
                Some("71c6fd"),
                "2026-11-18T10:20",
            ),
            env(
                3,
                "research-example-project-f899d4-71c6fd",
                "f899d4",
                Some("71c6fd"),
                "2026-11-19T16:36",
            ),
            env(
                4,
                "research-graph-gear-v3",
                "d1e37b",
                None,
                "2026-11-23T09:36:39",
            ),
            env(
                5,
                "research-graph-gear-v3-71c6fd",
                "d1e37b",
                Some("71c6fd"),
                "2026-11-23T09:36:09",
            ),
            env(6, "research-test", "c5292c", None, "2026-11-23T09:23"),
            env(
                7,
                "research-test-71c6fd",
                "c5292c",
                Some("71c6fd"),
                "2026-11-19T13:12",
            ),
        ]
    }

    #[test]
    fn an_add_for_a_research_project_the_project_has_reuses_it_whatever_its_name() {
        let own = stand();
        assert_eq!(
            reused(&own, &input("d1e37b")).map(|e| e.id),
            Some(Uuid::from_u128(4))
        );
        assert_eq!(
            reused(&own, &input(" f899d4 ")).map(|e| e.id),
            Some(Uuid::from_u128(1))
        );
        assert_eq!(
            reused(&own, &input("8fae83")).map(|e| e.id),
            Some(Uuid::from_u128(2))
        );
        assert!(reused(&own, &input("new")).is_none());
        let mut cluster = input("d1e37b");
        cluster.kind = EnvironmentKind::Kubernetes;
        assert!(
            reused(&own, &cluster).is_none(),
            "only a Research environment"
        );
    }

    #[test]
    fn duplicates_with_nothing_merge_into_the_plainest_name() {
        let merges = plan(&stand(), &HashSet::new());
        let by: Vec<(&str, u128, Vec<u128>)> = merges
            .iter()
            .map(|m| {
                (
                    m.research_project.as_str(),
                    m.keep.as_u128(),
                    m.remove.iter().map(|u| u.as_u128()).collect(),
                )
            })
            .collect();
        assert_eq!(
            by,
            [
                ("c5292c", 6, vec![7]),
                ("d1e37b", 4, vec![5]),
                ("f899d4", 1, vec![3]),
            ],
            "8fae83 is another Research project, alone"
        );
    }

    #[test]
    fn the_one_with_history_is_kept_and_none_with_history_is_removed() {
        let lived: HashSet<Uuid> = [Uuid::from_u128(5)].into();
        let merges = plan(&stand(), &lived);
        let gear = merges
            .iter()
            .find(|m| m.research_project == "d1e37b")
            .unwrap();
        assert_eq!(gear.keep, Uuid::from_u128(5), "the one deployed to");
        assert_eq!(gear.remove, [Uuid::from_u128(4)]);

        let both: HashSet<Uuid> = [Uuid::from_u128(4), Uuid::from_u128(5)].into();
        assert!(
            plan(&stand(), &both)
                .iter()
                .all(|m| m.research_project != "d1e37b"),
            "two with history: both stay, nothing to merge"
        );
    }

    #[test]
    fn merging_is_idempotent_and_moves_a_binding_to_the_one_kept() {
        let mut row = BindingList {
            environments: stand(),
            items: vec![Binding {
                profile: "research".into(),
                environment_id: Uuid::from_u128(5),
                values: None,
            }],
            ..BindingList::default()
        };
        let merges = plan(&row.environments, &HashSet::new());
        assert!(apply(&mut row, &merges));
        assert_eq!(row.environments.len(), 4);
        assert_eq!(row.items[0].environment_id, Uuid::from_u128(4));
        let again = plan(&row.environments, &HashSet::new());
        assert!(again.is_empty());
        assert!(!apply(&mut row, &again), "a second sweep changes nothing");
    }
}
