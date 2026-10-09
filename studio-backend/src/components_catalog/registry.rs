//! The organization's registry of its components (ADR-0041, phase P1), and
//! the catalogue sources it keeps on the server.
//!
//! Three things live here:
//!
//! - **Sources.** The repositories the catalogue reads, one
//!   `gts.cf.studio.catalog.source.v1~` node each, per organization. They
//!   replace the browser's `cf.components.sources`; a `catalog.sync` whose
//!   body names no repositories reads these.
//! - **The walk** (`catalog.registry`). Every project of the organization
//!   (`organizations::port::ProjectsOf`) not excluded, each repository it
//!   resolves to exactly as `project_gears` does (the gear repository, else
//!   the `project.config` `sources[]`), read again only when the fingerprint
//!   of the files discovery reads moved since the stored one
//!   (`registry_read` nodes, so a restart does not read everything again).
//! - **The registry.** One `registry_entry` per component name, one
//!   `occurrence` per place it was found, joined by `found_in`.
//!
//! The rules -- what a walk writes, retires and marks orphaned, and that
//! discovery moves no state but candidate to declared -- are [`plan`], a pure function;
//! the rest is reading and writing around it.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;

use anyhow::anyhow;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::format_description::well_known::Rfc3339;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::candidates::{Candidate, kebab};
pub use super::candidates::{DETECTED, Evidence};
use super::gts::{self, GtsEdge, GtsNode};
use super::project_gears::LocalGear;
use super::repo_enrich::ProjectGearsRead;
use super::service::{CatalogService, RepoSource};
use crate::tasks::sdk::SyncReporter;

/// Code that looks like a gear, with evidence (P3). Discovery writes it.
pub const STATE_CANDIDATE: &str = "candidate";
/// The repository declares it. Discovery writes it, and moves a candidate here.
pub const STATE_DECLARED: &str = "declared";
/// Accepted as the organization's component (P2, a person).
pub const STATE_REGISTERED: &str = "registered";
/// Released for others to depend on (P2, a person).
pub const STATE_PUBLISHED: &str = "published";
/// A candidate the organization decided is not a gear (P2, a person).
pub const STATE_REJECTED: &str = "rejected";
/// Still present, no longer to be chosen (P2, a person).
pub const STATE_DEPRECATED: &str = "deprecated";
/// Folded into another entry: one component found under two names (P2, a
/// person). Its occurrences and later findings belong to the entry it was
/// merged into, which carries its name among its `aliases`.
pub const STATE_MERGED: &str = "merged";

/// Every lifecycle state, in the order the lifecycle runs.
pub const STATES: [&str; 7] = [
    STATE_CANDIDATE,
    STATE_DECLARED,
    STATE_REGISTERED,
    STATE_PUBLISHED,
    STATE_REJECTED,
    STATE_DEPRECATED,
    STATE_MERGED,
];

/// The states whose descriptive fields discovery still owns: nobody has
/// decided anything about such an entry, so what the repository says now is
/// the best answer. Past them a person owns the entry, and a walk only says
/// when it saw it last.
fn discovery_owns(state: &str) -> bool {
    matches!(state, STATE_CANDIDATE | STATE_DECLARED)
}

/// A registry entry, as stored.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct EntryRecord {
    pub organization_id: Uuid,
    pub name: String,
    /// `gear`, `plugin`, `frontx` or `kit`.
    pub kind: String,
    /// One of [`STATES`].
    pub state: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    /// Who answers for it: a person or a team. Set by a person's decision.
    #[serde(default, deserialize_with = "owner_of")]
    pub owner: Option<Owner>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// Other names the same component was found under, merged into this one.
    /// A walk puts what it finds under any of them onto this entry.
    #[serde(default)]
    pub aliases: Vec<String>,
    /// For a `merged` entry, the entry it was folded into.
    #[serde(default)]
    pub merged_into: Option<String>,
    /// For a `deprecated` entry, the entry to use instead, when one was named.
    #[serde(default)]
    pub replaced_by: Option<String>,
    /// For a `published` entry, the version published, when one was named.
    #[serde(default)]
    pub version: Option<String>,
    /// No occurrence is left. Kept, with its state: a registered component
    /// whose repository moved is still the organization's.
    #[serde(default)]
    pub orphaned: bool,
    /// RFC 3339: when a walk first found it.
    #[serde(default)]
    pub first_seen: Option<String>,
    /// RFC 3339: the last walk that read a repository declaring it. A
    /// repository skipped as unchanged does not move it.
    #[serde(default)]
    pub last_seen: Option<String>,
    /// The fingerprint of the repository files it was last read from.
    #[serde(default)]
    pub fingerprint: Option<String>,
    /// For a candidate: the sum of its evidence's weights, at its best
    /// occurrence (P3).
    #[serde(default)]
    pub score: Option<u32>,
    /// For a candidate: why it looks like a gear, at its best occurrence.
    #[serde(default)]
    pub evidence: Vec<Evidence>,
    /// For a candidate: the fingerprints of the code it was found in, one per
    /// occurrence. Frozen while it is `rejected`; a walk that finds it in code
    /// with any other fingerprint proposes it again.
    #[serde(default)]
    pub candidate_fingerprints: Vec<String>,
}

/// Who answers for an entry.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Owner {
    /// `person` or `team`.
    pub kind: String,
    /// The person's Studio id, or the team's key, when known.
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
}

/// An owner as stored: the object, or -- written before owners had a shape --
/// a bare name, read as a team of that name.
fn owner_of<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Owner>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Stored {
        Shaped(Owner),
        Named(String),
    }
    Ok(match Option::<Stored>::deserialize(d)? {
        Some(Stored::Shaped(o)) => Some(o),
        Some(Stored::Named(name)) if !name.trim().is_empty() => Some(Owner {
            kind: "team".to_owned(),
            id: None,
            name,
        }),
        _ => None,
    })
}

/// Where an entry was found, as stored. Carries what the repository said
/// there, so a project's own gears can be answered from the registry in the
/// shape `project_gears` answers them.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct OccurrenceRecord {
    pub organization_id: Uuid,
    /// The entry's name.
    pub entry: String,
    pub entry_id: String,
    #[serde(default)]
    pub project_id: Option<Uuid>,
    #[serde(default)]
    pub project_name: Option<String>,
    /// `owner/name`.
    pub repo: String,
    /// The reader's key (tenant, connection, repository, ref): the unit a
    /// walk reads and prunes by.
    pub repo_key: String,
    #[serde(default)]
    pub git_ref: Option<String>,
    pub path: String,
    #[serde(default)]
    pub commit: Option<String>,
    /// `gear.toml`, `gear.gdl`, `attribute`, `package` or `kit`; `detected`
    /// for a candidate nothing declares.
    pub declared_in: String,
    /// The file that declares it, relative to the repository root.
    pub declared_file: String,
    pub kind: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub runtime: Vec<String>,
    #[serde(default)]
    pub built: bool,
    /// The README's path and opening, as `project_gears` read it.
    #[serde(default)]
    pub doc_path: Option<String>,
    #[serde(default)]
    pub doc_text: Option<String>,
    pub fingerprint: String,
    pub seen_at: String,
    /// The tenant whose connection reads the repository, and the connection:
    /// where Declare it writes.
    #[serde(default)]
    pub tenant: Option<Uuid>,
    #[serde(default)]
    pub connection_id: Option<Uuid>,
    /// For a candidate (`declared_in: detected`): its score here.
    #[serde(default)]
    pub score: Option<u32>,
    /// For a candidate: what fired here.
    #[serde(default)]
    pub evidence: Vec<Evidence>,
    /// For a candidate: the fingerprint of the module's own files.
    #[serde(default)]
    pub module_fingerprint: Option<String>,
}

impl OccurrenceRecord {
    /// Found by a detector, not declared.
    pub fn detected(&self) -> bool {
        self.declared_in == DETECTED
    }

    /// The gear as `project_gears` found it here.
    pub fn local_gear(&self) -> LocalGear {
        LocalGear {
            name: self.entry.clone(),
            kind: self.kind.clone(),
            description: self.description.clone(),
            category: self.category.clone(),
            path: self.path.clone(),
            declared_in: self.declared_file.clone(),
            repo: self.repo.clone(),
            capabilities: self.capabilities.clone(),
            runtime: self.runtime.clone(),
            built: self.built,
            doc: match (&self.doc_path, &self.doc_text) {
                (Some(path), Some(text)) => Some((path.clone(), text.clone())),
                _ => None,
            },
        }
    }
}

/// One repository of one project a walk read, with the fingerprint it read
/// it under.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReadRecord {
    pub organization_id: Uuid,
    pub project_id: Uuid,
    pub repo: String,
    pub repo_key: String,
    pub git_ref: String,
    pub fingerprint: String,
    #[serde(default)]
    pub commit: Option<String>,
    pub read_at: String,
}

/// One entry with every place it was found: what the registry answers.
#[derive(Clone, Debug, PartialEq)]
pub struct RegistryEntry {
    pub entry: EntryRecord,
    pub occurrences: Vec<OccurrenceRecord>,
}

/// What a declaration is, from the file that makes it.
pub fn declared_in_of(file: &str) -> &'static str {
    let name = file.rsplit('/').next().unwrap_or(file);
    match name {
        "gear.toml" => "gear.toml",
        "gear.gdl" => "gear.gdl",
        "package.json" => "package",
        ".cf-studio-kit.toml" => "kit",
        _ => "attribute",
    }
}

/// One repository a walk read anew.
#[derive(Clone, Debug, Default)]
pub struct RepoRead {
    pub project_id: Uuid,
    pub project_name: String,
    pub repo: String,
    pub repo_key: String,
    pub git_ref: String,
    pub commit: Option<String>,
    pub fingerprint: String,
    pub gears: Vec<LocalGear>,
    /// What looks like a gear here (P3), the copy signal applied.
    pub candidates: Vec<Candidate>,
    /// The tenant whose connection reads it, and the connection.
    pub tenant: Option<Uuid>,
    pub connection_id: Option<Uuid>,
}

/// What a walk saw.
#[derive(Clone, Debug, Default)]
pub struct Walk {
    pub org: Uuid,
    /// RFC 3339.
    pub now: String,
    /// The repositories read anew (their fingerprint moved, or none was
    /// stored).
    pub reads: Vec<RepoRead>,
    /// Every `(project, repository)` the walk resolved: read anew, skipped as
    /// unchanged, or failed to read. What a walk did not read keeps its
    /// occurrences; what a project no longer names loses them.
    pub resolved: BTreeSet<(Uuid, String)>,
    /// The projects whose repositories resolved. A project whose repositories
    /// could not be listed at all is not among them, and nothing of it is
    /// pruned: "could not tell" is not "none".
    pub projects_resolved: BTreeSet<Uuid>,
    /// A full walk: the projects in scope. An occurrence in any other
    /// project (excluded, or gone from the organization) is retired. `None`
    /// for a walk over named projects, which leaves the others alone.
    pub in_scope: Option<BTreeSet<Uuid>>,
}

/// What a walk writes.
#[derive(Debug, Default)]
pub struct Plan {
    pub upsert: Vec<GtsNode>,
    pub edges: Vec<GtsEdge>,
    /// Instance ids to retire: occurrences and registry reads.
    pub retire: Vec<String>,
    pub created: usize,
    pub updated: usize,
    pub occurrences_written: usize,
    pub occurrences_removed: usize,
    pub orphaned: usize,
    /// Candidate findings written (P3).
    pub candidates_found: usize,
    /// Candidates found declared, now `declared`.
    pub declared_from_candidates: usize,
    /// Rejected candidates whose code changed, proposed again.
    pub reproposed: usize,
}

/// Whether a stored `(project, repository)` pair is gone, by what the walk
/// saw.
fn pair_gone(walk: &Walk, project: Option<Uuid>, repo_key: &str) -> bool {
    let Some(project) = project else {
        return false;
    };
    if let Some(scope) = &walk.in_scope
        && !scope.contains(&project)
    {
        return true;
    }
    walk.projects_resolved.contains(&project)
        && !walk.resolved.contains(&(project, repo_key.to_string()))
}

/// Every alias (case-folded) to the id of the entry that carries it. A merged
/// entry's own aliases moved with it, so only live entries are asked.
pub fn aliases_of(entries: &[(String, EntryRecord)]) -> HashMap<String, String> {
    entries
        .iter()
        .filter(|(_, e)| e.state != STATE_MERGED)
        .flat_map(|(id, e)| {
            e.aliases
                .iter()
                .map(move |a| (a.trim().to_ascii_lowercase(), id.clone()))
        })
        .collect()
}

/// Every live entry by its name folded as candidate names are ([`kebab`]):
/// `spec_mapping` declared and `spec-mapping` detected are one component.
fn folded_of(entries: &[(String, EntryRecord)]) -> HashMap<String, String> {
    entries
        .iter()
        .filter(|(_, e)| e.state != STATE_MERGED)
        .map(|(id, e)| (kebab(&e.name), id.clone()))
        .collect()
}

/// What a read found at one place.
#[derive(Clone, Copy)]
enum Finding<'a> {
    /// The repository declares it.
    Declared(&'a LocalGear),
    /// A detector found it (P3).
    Detected(&'a Candidate),
}

impl Finding<'_> {
    fn name(&self) -> &str {
        match self {
            Finding::Declared(g) => &g.name,
            Finding::Detected(c) => &c.name,
        }
    }

    fn path(&self) -> &str {
        match self {
            Finding::Declared(g) => &g.path,
            Finding::Detected(c) => &c.path,
        }
    }
}

/// The candidate fields of an entry, from its best finding and every
/// fingerprint it is found under.
fn propose(entry: &mut EntryRecord, best: &Candidate, prints: &[String]) {
    entry.state = STATE_CANDIDATE.to_string();
    entry.score = Some(best.score);
    entry.evidence = best.evidence.clone();
    entry.candidate_fingerprints = prints.to_vec();
    if entry.description.is_none() {
        entry.description = best.description.clone();
    }
}

/// What a walk changes in the registry. Pure: the stored entries,
/// occurrences and reads (each with its instance id) and what the walk saw,
/// to the nodes to write and the ids to retire.
///
/// - A component a repository declares, found anew, is `declared`; one only
///   a detector found (P3) is a `candidate`, with its score and evidence.
/// - Discovery owns `candidate` and `declared`, so a candidate later found
///   declared becomes `declared`. Every other state is a person's and stays:
///   a `rejected` entry is not resurrected by a declaration.
/// - A `rejected` candidate is proposed again (back to `candidate`) only when
///   a detector finds it in code whose fingerprint is not among the ones it
///   was rejected under.
/// - Discovery refreshes what an entry says (kind, description, category,
///   capabilities) only while nobody owns it ([`discovery_owns`]).
/// - The occurrences of a repository read anew are what that read found;
///   the ones it no longer has are retired. So are the occurrences of a
///   repository a project no longer names, and of a project out of scope.
/// - An entry with no occurrence left is `orphaned` and kept.
/// - A component found under a name merged into another entry (one of its
///   `aliases`) is that entry's: its occurrence is written under it. A name
///   spelled differently (`spec_mapping`, `spec-mapping`) is the same entry.
pub fn plan(
    walk: &Walk,
    entries: &[(String, EntryRecord)],
    occurrences: &[(String, OccurrenceRecord)],
    reads: &[(String, ReadRecord)],
) -> Plan {
    let org = walk.org.to_string();
    let mut out = Plan::default();
    let read_now: BTreeSet<(Uuid, &str)> = walk
        .reads
        .iter()
        .map(|r| (r.project_id, r.repo_key.as_str()))
        .collect();

    // The entries by id, and the name each goes by.
    let mut by_id: BTreeMap<String, EntryRecord> = entries.iter().cloned().collect();
    let originals: BTreeMap<String, EntryRecord> = by_id.clone();
    // A name merged into another entry is that entry's: what a read finds
    // under it lands there, never on the merged entry.
    let alias_of = aliases_of(entries);
    let mut folded = folded_of(entries);

    // What the reads found, keyed by occurrence id; the first finding of a
    // component at one place in one read wins, as in `project_gears`.
    let mut produced: BTreeMap<String, OccurrenceRecord> = BTreeMap::new();
    let mut declared_by_entry: BTreeMap<String, (&RepoRead, &LocalGear)> = BTreeMap::new();
    let mut detected_by_entry: BTreeMap<String, Vec<&Candidate>> = BTreeMap::new();
    let mut first_read: BTreeMap<String, &RepoRead> = BTreeMap::new();
    // The name an entry goes by: the stored one, else the first spelling
    // found. `Studio-Tasks` in one project and `studio-tasks` in another are
    // one entry under one name.
    let mut names: BTreeMap<String, String> = BTreeMap::new();
    for read in &walk.reads {
        let project = read.project_id.to_string();
        let findings = read
            .gears
            .iter()
            .map(Finding::Declared)
            .chain(read.candidates.iter().map(Finding::Detected));
        for finding in findings {
            let found_name = finding.name();
            let entry_id = alias_of
                .get(&found_name.trim().to_ascii_lowercase())
                .cloned()
                .or_else(|| {
                    let exact = gts::registry_entry_instance_id(&org, found_name);
                    originals.contains_key(&exact).then_some(exact)
                })
                .or_else(|| folded.get(&kebab(found_name)).cloned())
                .unwrap_or_else(|| gts::registry_entry_instance_id(&org, found_name));
            folded
                .entry(kebab(found_name))
                .or_insert_with(|| entry_id.clone());
            let name = names
                .entry(entry_id.clone())
                .or_insert_with(|| {
                    originals
                        .get(&entry_id)
                        .map(|e| e.name.clone())
                        .unwrap_or_else(|| found_name.to_string())
                })
                .clone();
            let id = gts::occurrence_instance_id(&entry_id, &project, &read.repo, finding.path());
            if produced.contains_key(&id) {
                continue;
            }
            first_read.entry(entry_id.clone()).or_insert(read);
            let base = OccurrenceRecord {
                organization_id: walk.org,
                entry: name,
                entry_id: entry_id.clone(),
                project_id: Some(read.project_id),
                project_name: Some(read.project_name.clone()),
                repo: read.repo.clone(),
                repo_key: read.repo_key.clone(),
                git_ref: Some(read.git_ref.clone()).filter(|r| !r.is_empty()),
                path: finding.path().to_string(),
                commit: read.commit.clone(),
                fingerprint: read.fingerprint.clone(),
                seen_at: walk.now.clone(),
                tenant: read.tenant,
                connection_id: read.connection_id,
                ..OccurrenceRecord::default()
            };
            let occ = match finding {
                Finding::Declared(gear) => {
                    declared_by_entry
                        .entry(entry_id.clone())
                        .or_insert((read, gear));
                    OccurrenceRecord {
                        declared_in: declared_in_of(&gear.declared_in).to_string(),
                        declared_file: gear.declared_in.clone(),
                        kind: gear.kind.clone(),
                        description: gear.description.clone(),
                        category: gear.category.clone(),
                        capabilities: gear.capabilities.clone(),
                        runtime: gear.runtime.clone(),
                        built: gear.built,
                        doc_path: gear.doc.as_ref().map(|(p, _)| p.clone()),
                        doc_text: gear.doc.as_ref().map(|(_, t)| t.clone()),
                        ..base
                    }
                }
                Finding::Detected(candidate) => {
                    detected_by_entry
                        .entry(entry_id.clone())
                        .or_default()
                        .push(candidate);
                    out.candidates_found += 1;
                    OccurrenceRecord {
                        declared_in: DETECTED.to_string(),
                        declared_file: candidate.main_file.clone(),
                        kind: "gear".to_string(),
                        description: candidate.description.clone(),
                        built: true,
                        score: Some(candidate.score),
                        evidence: candidate.evidence.clone(),
                        module_fingerprint: Some(candidate.fingerprint.clone()),
                        ..base
                    }
                }
            };
            produced.insert(id, occ);
        }
    }

    // The stored occurrences that stay, and the ones that go.
    let mut remaining: BTreeMap<String, usize> = BTreeMap::new();
    // The fingerprints of the code each entry is still detected in.
    let mut prints: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for (id, occ) in occurrences {
        if produced.contains_key(id) {
            continue;
        }
        let reread = occ
            .project_id
            .is_some_and(|p| read_now.contains(&(p, occ.repo_key.as_str())));
        if reread || pair_gone(walk, occ.project_id, &occ.repo_key) {
            out.retire.push(id.clone());
            out.occurrences_removed += 1;
        } else {
            *remaining.entry(occ.entry_id.clone()).or_default() += 1;
            if let Some(print) = occ.module_fingerprint.as_ref().filter(|_| occ.detected()) {
                prints
                    .entry(occ.entry_id.clone())
                    .or_default()
                    .insert(print.clone());
            }
        }
    }
    for occ in produced.values() {
        *remaining.entry(occ.entry_id.clone()).or_default() += 1;
        if let Some(print) = &occ.module_fingerprint {
            prints
                .entry(occ.entry_id.clone())
                .or_default()
                .insert(print.clone());
        }
    }

    // The entries the reads found: new ones declared or proposed, known ones
    // seen again.
    for (entry_id, read) in &first_read {
        let declared = declared_by_entry.get(entry_id);
        let detected: &[&Candidate] = detected_by_entry
            .get(entry_id)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let best = detected
            .iter()
            .copied()
            .max_by(|a, b| a.score.cmp(&b.score).then_with(|| b.path.cmp(&a.path)));
        let entry_prints: Vec<String> = prints
            .get(entry_id)
            .map(|p| p.iter().cloned().collect())
            .unwrap_or_default();
        let read_print = declared.map_or(&read.fingerprint, |(r, _)| &r.fingerprint);
        match by_id.get_mut(entry_id) {
            Some(entry) => {
                entry.last_seen = Some(walk.now.clone());
                entry.fingerprint = Some(read_print.clone());
                if let Some((_, gear)) = declared {
                    // Discovery owns both, so a candidate found declared is
                    // declared now: the Declare it pull request merged.
                    if entry.state == STATE_CANDIDATE {
                        entry.state = STATE_DECLARED.to_string();
                        out.declared_from_candidates += 1;
                    }
                    if discovery_owns(&entry.state) {
                        entry.kind = gear.kind.clone();
                        entry.description = gear.description.clone().or(entry.description.take());
                        entry.category = gear.category.clone().or(entry.category.take());
                        if !gear.capabilities.is_empty() {
                            entry.capabilities = gear.capabilities.clone();
                        }
                        entry.score = None;
                        entry.evidence.clear();
                        entry.candidate_fingerprints.clear();
                    }
                } else if let Some(best) = best {
                    if entry.state == STATE_CANDIDATE {
                        propose(entry, best, &entry_prints);
                    } else if entry.state == STATE_REJECTED
                        && !entry.candidate_fingerprints.is_empty()
                        && detected
                            .iter()
                            .any(|c| !entry.candidate_fingerprints.contains(&c.fingerprint))
                    {
                        // The code it was rejected in changed: ask again.
                        propose(entry, best, &entry_prints);
                        out.reproposed += 1;
                    }
                }
            }
            None => {
                let name = names
                    .get(entry_id)
                    .cloned()
                    .unwrap_or_else(|| entry_id.clone());
                let mut entry = EntryRecord {
                    organization_id: walk.org,
                    name,
                    first_seen: Some(walk.now.clone()),
                    last_seen: Some(walk.now.clone()),
                    fingerprint: Some(read_print.clone()),
                    ..EntryRecord::default()
                };
                if let Some((_, gear)) = declared {
                    entry.kind = gear.kind.clone();
                    entry.state = STATE_DECLARED.to_string();
                    entry.description = gear.description.clone();
                    entry.category = gear.category.clone();
                    entry.capabilities = gear.capabilities.clone();
                } else if let Some(best) = best {
                    entry.kind = "gear".to_string();
                    propose(&mut entry, best, &entry_prints);
                } else {
                    continue;
                }
                by_id.insert(entry_id.clone(), entry);
                out.created += 1;
            }
        }
    }

    // Orphaned is a count, settled for every entry.
    for (id, entry) in &mut by_id {
        entry.orphaned = remaining.get(id).copied().unwrap_or(0) == 0;
    }
    for (id, entry) in &by_id {
        if entry.orphaned {
            out.orphaned += 1;
        }
        let changed = originals.get(id) != Some(entry);
        if !changed {
            continue;
        }
        if originals.contains_key(id) {
            out.updated += 1;
        }
        if let Ok(value) = serde_json::to_value(entry) {
            out.upsert
                .push(gts::registry_entry_node(&org, &entry.name, value));
        }
    }

    // The occurrences found, each joined to its entry.
    for (id, occ) in produced {
        out.edges.push(gts::found_in_edge(&occ.entry_id, &id));
        if let Ok(value) = serde_json::to_value(&occ) {
            out.upsert.push(gts::occurrence_node(id, value));
            out.occurrences_written += 1;
        }
    }

    // The fingerprints read, and the reads of what is gone.
    for read in &walk.reads {
        let record = ReadRecord {
            organization_id: walk.org,
            project_id: read.project_id,
            repo: read.repo.clone(),
            repo_key: read.repo_key.clone(),
            git_ref: read.git_ref.clone(),
            fingerprint: read.fingerprint.clone(),
            commit: read.commit.clone(),
            read_at: walk.now.clone(),
        };
        if let Ok(value) = serde_json::to_value(&record) {
            out.upsert.push(gts::registry_read_node(
                gts::registry_read_instance_id(&org, &read.project_id.to_string(), &read.repo_key),
                value,
            ));
        }
    }
    for (id, read) in reads {
        if pair_gone(walk, Some(read.project_id), &read.repo_key) {
            out.retire.push(id.clone());
        }
    }
    out
}

/// The registry narrowed as `GET /registry` asks: by state, by a project the
/// entry was found in, and by text in its name or description. Sorted by
/// name.
pub fn filter_entries(
    mut entries: Vec<RegistryEntry>,
    state: Option<&str>,
    project_id: Option<Uuid>,
    q: Option<&str>,
) -> Vec<RegistryEntry> {
    let q = q
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase);
    entries.retain(|e| {
        state.is_none_or(|s| e.entry.state.eq_ignore_ascii_case(s))
            && project_id.is_none_or(|p| e.occurrences.iter().any(|o| o.project_id == Some(p)))
            && q.as_deref().is_none_or(|q| {
                e.entry.name.to_lowercase().contains(q)
                    || e.entry
                        .description
                        .as_deref()
                        .is_some_and(|d| d.to_lowercase().contains(q))
            })
    });
    entries.sort_by(|a, b| {
        a.entry
            .name
            .to_lowercase()
            .cmp(&b.entry.name.to_lowercase())
    });
    entries
}

/// Entries with their occurrences, joined by entry id. An occurrence whose
/// entry is gone is dropped; occurrences are ordered by project, repository
/// and path.
pub fn join(
    entries: Vec<(String, EntryRecord)>,
    occurrences: Vec<OccurrenceRecord>,
) -> Vec<RegistryEntry> {
    let mut by_entry: HashMap<String, Vec<OccurrenceRecord>> = HashMap::new();
    for occ in occurrences {
        by_entry.entry(occ.entry_id.clone()).or_default().push(occ);
    }
    entries
        .into_iter()
        .map(|(id, entry)| {
            let mut occurrences = by_entry.remove(&id).unwrap_or_default();
            occurrences.sort_by(|a, b| {
                (&a.project_name, &a.repo, &a.path).cmp(&(&b.project_name, &b.repo, &b.path))
            });
            RegistryEntry { entry, occurrences }
        })
        .collect()
}

/// The sources as a request names them: blank repositories dropped, a
/// repository named twice (same ref and mode) kept once, the mode defaulted.
pub fn normalize_sources(sources: Vec<RepoSource>) -> Vec<RepoSource> {
    let mut seen = BTreeSet::new();
    sources
        .into_iter()
        .filter_map(|mut s| {
            s.repo = s.repo.trim().trim_start_matches('/').to_string();
            s.git_ref = s.git_ref.trim().to_string();
            s.mode = match s.mode.trim() {
                "" => "gears".to_string(),
                m => m.to_ascii_lowercase(),
            };
            if s.repo.is_empty() {
                return None;
            }
            seen.insert((
                s.repo.to_ascii_lowercase(),
                s.git_ref.clone(),
                s.mode.clone(),
            ))
            .then_some(s)
        })
        .collect()
}

/// A stored source, read back.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct SourceRecord {
    organization_id: Uuid,
    tenant: Uuid,
    #[serde(default)]
    connection_id: Option<Uuid>,
    repo: String,
    #[serde(default)]
    git_ref: String,
    #[serde(default)]
    mode: String,
    #[serde(default)]
    position: usize,
}

/// The organization's registry settings, as stored.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct SettingsRecord {
    #[serde(default)]
    organization_id: Option<Uuid>,
    #[serde(default)]
    excluded_project_ids: Vec<Uuid>,
    /// What the last walk saw of each project it read, so a person can tell
    /// a project with no components from one the walk could not read.
    #[serde(default)]
    last_walk: Vec<ProjectWalk>,
    /// The crates.io keyword the catalogue syncs with. Kept for the
    /// platform's catalogue (ADR-0042), whose sync a schedule starts and so
    /// cannot be handed the keyword by a page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    crates_io_keyword: Option<String>,
}

/// What the last walk saw of one project.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ProjectWalk {
    pub project_id: Uuid,
    pub project_name: String,
    /// RFC 3339.
    pub at: String,
    /// Set when the project's repositories could not be listed at all.
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub repos: Vec<RepoWalk>,
}

/// What the last walk did with one repository of a project.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RepoWalk {
    pub repo: String,
    /// `read` (read anew), `unchanged` (its fingerprint matched) or `failed`.
    pub status: String,
    /// Components found in it: read anew, or still recorded for it.
    #[serde(default)]
    pub components: usize,
    #[serde(default)]
    pub error: Option<String>,
    /// What a person can do about `error`, when the walk knows.
    #[serde(default)]
    pub hint: Option<String>,
}

/// `base` acting in `tenant`: the same subject, kind, scopes and bearer, with
/// the tenant a project's credentials are readable from.
pub fn in_tenant(base: &SecurityContext, tenant: Uuid) -> anyhow::Result<SecurityContext> {
    let mut b = SecurityContext::builder()
        .subject_id(base.subject_id())
        .subject_tenant_id(tenant)
        .token_scopes(base.token_scopes().to_vec());
    if let Some(kind) = base.subject_type() {
        b = b.subject_type(kind);
    }
    if let Some(token) = base.bearer_token() {
        b = b.bearer_token(token.clone());
    }
    b.build()
        .map_err(|e| anyhow!("cannot act in tenant {tenant}: {e}"))
}

/// What a person can do about a repository the walk could not read.
///
/// The walk runs as the service, on a schedule nobody is signed in to, so a
/// repository connected with someone's personal token is not readable to it --
/// by design: an organization-wide job must not borrow one person's
/// credential. The fix is to share the connection, not to impersonate.
pub fn read_failure_hint(error: &str) -> Option<String> {
    let e = error.to_ascii_lowercase();
    if e.contains("personal") || e.contains("not readable") {
        return Some(
            "The repository is connected with a personal token, which the registry's background read cannot use. Share the connection with the workspace or the organization, or connect the repository with a shared token."
                .to_owned(),
        );
    }
    if e.contains("401") || e.contains("403") || e.contains("bad credentials") {
        return Some(
            "The connection's token was refused by the provider: renew it on the Connections page."
                .to_owned(),
        );
    }
    if e.contains("404") || e.contains("not found") {
        return Some("The repository or branch was not found with this connection: check the project's Sources.".to_owned());
    }
    None
}

/// The last walk's statuses after `walked`: a full walk replaces them, a walk
/// over named projects replaces only theirs.
pub fn merge_walks(
    previous: Vec<ProjectWalk>,
    walked: Vec<ProjectWalk>,
    full: bool,
) -> Vec<ProjectWalk> {
    if full {
        return walked;
    }
    let mut out: Vec<ProjectWalk> = previous
        .into_iter()
        .filter(|p| !walked.iter().any(|w| w.project_id == p.project_id))
        .collect();
    out.extend(walked);
    out.sort_by(|a, b| a.project_name.cmp(&b.project_name));
    out
}

/// What a registry walk counted. The run's result.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RegistryCounts {
    #[serde(default)]
    pub projects: usize,
    #[serde(default)]
    pub projects_excluded: usize,
    #[serde(default)]
    pub repos_read: usize,
    #[serde(default)]
    pub repos_unchanged: usize,
    #[serde(default)]
    pub repos_failed: usize,
    #[serde(default)]
    pub entries_created: usize,
    #[serde(default)]
    pub entries_updated: usize,
    #[serde(default)]
    pub occurrences_written: usize,
    #[serde(default)]
    pub occurrences_removed: usize,
    #[serde(default)]
    pub orphaned: usize,
    /// Candidate findings (P3).
    #[serde(default)]
    pub candidates: usize,
    /// Rejected candidates proposed again because their code changed.
    #[serde(default)]
    pub reproposed: usize,
}

pub(super) fn now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_default()
}

/// Typed records of one node type, each with its instance id. A payload that
/// does not read as `T` is skipped and logged.
pub(super) fn records<T: serde::de::DeserializeOwned>(nodes: Vec<GtsNode>) -> Vec<(String, T)> {
    nodes
        .into_iter()
        .filter_map(|n| match serde_json::from_value::<T>(n.value) {
            Ok(r) => Some((n.instance_id, r)),
            Err(e) => {
                tracing::warn!(instance_id = %n.instance_id, error = %e, "components-catalog: a registry node does not read; skipped");
                None
            }
        })
        .collect()
}

impl CatalogService {
    /// The organization's catalogue sources, in the order they were saved.
    pub async fn list_sources(&self, ctx: &SecurityContext) -> anyhow::Result<Vec<RepoSource>> {
        let org = ctx.subject_tenant_id();
        let mut stored: Vec<SourceRecord> =
            records::<SourceRecord>(self.sink.list(ctx, Some(gts::SOURCE_TYPE)).await?)
                .into_iter()
                .map(|(_, r)| r)
                .filter(|r| r.organization_id == org)
                .collect();
        stored.sort_by_key(|r| r.position);
        Ok(stored
            .into_iter()
            .map(|r| RepoSource {
                tenant: r.tenant,
                connection_id: r.connection_id,
                repo: r.repo,
                git_ref: r.git_ref,
                mode: r.mode,
            })
            .collect())
    }

    /// Replace the organization's catalogue sources with `sources`.
    pub async fn replace_sources(
        &self,
        ctx: &SecurityContext,
        sources: Vec<RepoSource>,
    ) -> anyhow::Result<Vec<RepoSource>> {
        self.sink.register_types(ctx).await?;
        let org = ctx.subject_tenant_id();
        let org_s = org.to_string();
        let sources = normalize_sources(sources);
        let mut nodes = Vec::with_capacity(sources.len());
        for (position, s) in sources.iter().enumerate() {
            let id = gts::source_instance_id(&org_s, &s.repo, &s.git_ref, &s.mode);
            let value = serde_json::to_value(SourceRecord {
                organization_id: org,
                tenant: s.tenant,
                connection_id: s.connection_id,
                repo: s.repo.clone(),
                git_ref: s.git_ref.clone(),
                mode: s.mode.clone(),
                position,
            })?;
            nodes.push(gts::source_node(id, value));
        }
        let keep: BTreeSet<String> = nodes.iter().map(|n| n.instance_id.clone()).collect();
        self.sink.upsert(ctx, &nodes, &[]).await?;
        for node in self.sink.list(ctx, Some(gts::SOURCE_TYPE)).await? {
            if !keep.contains(&node.instance_id) {
                self.sink.delete(ctx, &node.instance_id).await?;
            }
        }
        Ok(sources)
    }

    async fn settings(&self, ctx: &SecurityContext) -> anyhow::Result<SettingsRecord> {
        let id = gts::registry_settings_instance_id(&ctx.subject_tenant_id().to_string());
        Ok(records::<SettingsRecord>(
            self.sink
                .list(ctx, Some(gts::REGISTRY_SETTINGS_TYPE))
                .await?,
        )
        .into_iter()
        .find(|(i, _)| *i == id)
        .map(|(_, s)| s)
        .unwrap_or_default())
    }

    /// The projects the walk skips.
    pub async fn excluded_projects(&self, ctx: &SecurityContext) -> anyhow::Result<Vec<Uuid>> {
        Ok(self.settings(ctx).await?.excluded_project_ids)
    }

    /// What the last walk saw of each project it read.
    pub async fn last_walk(&self, ctx: &SecurityContext) -> anyhow::Result<Vec<ProjectWalk>> {
        Ok(self.settings(ctx).await?.last_walk)
    }

    /// Replace the projects the walk skips. Deduplicated, in the order given.
    pub async fn set_excluded_projects(
        &self,
        ctx: &SecurityContext,
        project_ids: Vec<Uuid>,
    ) -> anyhow::Result<Vec<Uuid>> {
        self.sink.register_types(ctx).await?;
        let org = ctx.subject_tenant_id();
        let mut seen = BTreeSet::new();
        let ids: Vec<Uuid> = project_ids
            .into_iter()
            .filter(|p| seen.insert(*p))
            .collect();
        let mut settings = self.settings(ctx).await?;
        settings.organization_id = Some(org);
        settings.excluded_project_ids = ids.clone();
        let value = serde_json::to_value(settings)?;
        self.sink
            .upsert(
                ctx,
                &[gts::registry_settings_node(&org.to_string(), value)],
                &[],
            )
            .await?;
        Ok(ids)
    }

    /// The crates.io keyword this tenant's catalogue syncs with, when one was
    /// saved.
    pub async fn stored_keyword(&self, ctx: &SecurityContext) -> anyhow::Result<Option<String>> {
        Ok(self.settings(ctx).await?.crates_io_keyword)
    }

    /// Save the crates.io keyword this tenant's catalogue syncs with; empty
    /// or `None` means no crates.io source.
    pub async fn set_stored_keyword(
        &self,
        ctx: &SecurityContext,
        keyword: Option<String>,
    ) -> anyhow::Result<Option<String>> {
        self.sink.register_types(ctx).await?;
        let org = ctx.subject_tenant_id();
        let keyword = keyword
            .map(|k| k.trim().to_owned())
            .filter(|k| !k.is_empty());
        let mut settings = self.settings(ctx).await?;
        settings.organization_id = Some(org);
        settings.crates_io_keyword.clone_from(&keyword);
        self.sink
            .upsert(
                ctx,
                &[gts::registry_settings_node(
                    &org.to_string(),
                    serde_json::to_value(settings)?,
                )],
                &[],
            )
            .await?;
        Ok(keyword)
    }

    /// Every entry of the organization's registry, with its occurrences.
    pub async fn registry_entries(
        &self,
        ctx: &SecurityContext,
    ) -> anyhow::Result<Vec<RegistryEntry>> {
        let org = ctx.subject_tenant_id();
        let entries: Vec<(String, EntryRecord)> =
            records::<EntryRecord>(self.sink.list(ctx, Some(gts::REGISTRY_ENTRY_TYPE)).await?)
                .into_iter()
                .filter(|(_, e)| e.organization_id == org)
                .collect();
        if entries.is_empty() {
            return Ok(Vec::new());
        }
        let occurrences: Vec<OccurrenceRecord> =
            records::<OccurrenceRecord>(self.sink.list(ctx, Some(gts::OCCURRENCE_TYPE)).await?)
                .into_iter()
                .map(|(_, o)| o)
                .filter(|o| o.organization_id == org)
                .collect();
        Ok(join(entries, occurrences))
    }

    /// One entry, by name (case-blind).
    pub async fn registry_entry(
        &self,
        ctx: &SecurityContext,
        name: &str,
    ) -> anyhow::Result<Option<RegistryEntry>> {
        let wanted = name.trim();
        Ok(self
            .registry_entries(ctx)
            .await?
            .into_iter()
            .find(|e| e.entry.name.eq_ignore_ascii_case(wanted)))
    }

    /// An organization's projects, from the organizations gear.
    fn projects_of(&self) -> anyhow::Result<Arc<dyn crate::organizations::port::ProjectsOf>> {
        self.hub
            .get()
            .and_then(|hub| hub.get::<dyn crate::organizations::port::ProjectsOf>().ok())
            .ok_or_else(|| {
                anyhow!("the registry cannot list the organization's projects: studio-organizations is not part of this deployment")
            })
    }

    /// The registry walk: every project of the context's organization not
    /// excluded -- or, with `only`, those of them named -- read for the
    /// components its repositories declare, and the registry brought in line
    /// with what was read (see [`plan`]).
    pub async fn run_registry(
        &self,
        ctx: &SecurityContext,
        only: &[Uuid],
        progress: &SyncReporter,
    ) -> anyhow::Result<RegistryCounts> {
        self.sink.register_types(ctx).await?;
        let org = ctx.subject_tenant_id();
        let mut counts = RegistryCounts::default();
        progress.set("registry: listing the organization's projects…");
        let projects = self.projects_of()?.projects_of(ctx, org).await?;
        let excluded: BTreeSet<Uuid> = self.excluded_projects(ctx).await?.into_iter().collect();
        let in_scope: Vec<_> = projects
            .into_iter()
            .filter(|p| {
                if excluded.contains(&p.id) {
                    counts.projects_excluded += 1;
                    return false;
                }
                only.is_empty() || only.contains(&p.id)
            })
            .collect();
        counts.projects = in_scope.len();

        let entries =
            records::<EntryRecord>(self.sink.list(ctx, Some(gts::REGISTRY_ENTRY_TYPE)).await?);
        let occurrences =
            records::<OccurrenceRecord>(self.sink.list(ctx, Some(gts::OCCURRENCE_TYPE)).await?);
        let reads =
            records::<ReadRecord>(self.sink.list(ctx, Some(gts::REGISTRY_READ_TYPE)).await?);
        let stored: HashMap<(Uuid, String), String> = reads
            .iter()
            .filter(|(_, r)| r.organization_id == org)
            .map(|(_, r)| ((r.project_id, r.repo_key.clone()), r.fingerprint.clone()))
            .collect();

        let mut walk = Walk {
            org,
            now: now(),
            in_scope: only
                .is_empty()
                .then(|| in_scope.iter().map(|p| p.id).collect()),
            ..Walk::default()
        };
        let total = in_scope.len();
        let mut statuses: Vec<ProjectWalk> = Vec::with_capacity(total);
        // Components still recorded per (project, repository): what an
        // unchanged repository holds.
        let mut held: HashMap<(Uuid, String), usize> = HashMap::new();
        for (_, o) in occurrences.iter().filter(|(_, o)| o.organization_id == org) {
            if let Some(p) = o.project_id {
                *held.entry((p, o.repo_key.clone())).or_default() += 1;
            }
        }
        for (i, project) in in_scope.iter().enumerate() {
            let mut status = ProjectWalk {
                project_id: project.id,
                project_name: project.name.clone(),
                at: walk.now.clone(),
                ..ProjectWalk::default()
            };
            progress.set_with(
                format!("registry: {} ({}/{total})", project.name, i + 1),
                serde_json::to_value(&counts).unwrap_or(Value::Null),
            );
            // A project's repositories are read in the project's own tenant:
            // its connection and token belong to it or to the workspace above
            // it, and a token is readable down the tree, never up. Read from
            // the organization's tenant, every workspace connection answers
            // "not readable". The registry's own nodes stay the organization's.
            let pctx = match in_tenant(ctx, project.id) {
                Ok(pctx) => pctx,
                Err(e) => {
                    status.error = Some(format!("{e:#}"));
                    statuses.push(status);
                    continue;
                }
            };
            let repos = match self.project_repos(&pctx, &project.id.to_string()).await {
                Ok(repos) => repos,
                Err(e) => {
                    tracing::warn!(project_id = %project.id, error = %format!("{e:#}"), "components-catalog: registry: a project's repositories could not be resolved");
                    status.error = Some(format!("{e:#}"));
                    statuses.push(status);
                    continue;
                }
            };
            let readers = match self.enrichers(repos) {
                Ok(readers) => readers,
                Err(e) => {
                    tracing::warn!(project_id = %project.id, error = %format!("{e:#}"), "components-catalog: registry: a project's repositories cannot be read");
                    let error = format!("{e:#}");
                    status.repos.push(RepoWalk {
                        repo: String::new(),
                        status: "failed".to_owned(),
                        hint: read_failure_hint(&error),
                        error: Some(error),
                        ..RepoWalk::default()
                    });
                    statuses.push(status);
                    continue;
                }
            };
            walk.projects_resolved.insert(project.id);
            for (target, reader) in readers {
                let key = reader.repo_key();
                walk.resolved.insert((project.id, key.clone()));
                let known = stored.get(&(project.id, key.clone())).map(String::as_str);
                match reader
                    .project_gears_unless(&pctx, &self.project_gears, known, true)
                    .await
                {
                    Ok(ProjectGearsRead::Unchanged) => {
                        counts.repos_unchanged += 1;
                        status.repos.push(RepoWalk {
                            repo: target.repo.clone(),
                            status: "unchanged".to_owned(),
                            components: held.get(&(project.id, key.clone())).copied().unwrap_or(0),
                            ..RepoWalk::default()
                        });
                    }
                    Ok(ProjectGearsRead::Read {
                        fingerprint,
                        gears,
                        candidates,
                    }) => {
                        counts.repos_read += 1;
                        status.repos.push(RepoWalk {
                            repo: target.repo.clone(),
                            status: "read".to_owned(),
                            components: gears.len(),
                            ..RepoWalk::default()
                        });
                        walk.reads.push(RepoRead {
                            project_id: project.id,
                            project_name: project.name.clone(),
                            repo: target.repo.clone(),
                            repo_key: key,
                            git_ref: reader.git_ref().to_string(),
                            commit: reader.head_commit(&pctx).await,
                            fingerprint,
                            gears: gears.as_ref().clone(),
                            candidates: candidates.as_ref().clone(),
                            tenant: Some(target.tenant),
                            connection_id: target.connection_id,
                        });
                    }
                    Err(e) => {
                        counts.repos_failed += 1;
                        tracing::warn!(project_id = %project.id, repo = %target.repo, error = %format!("{e:#}"), "components-catalog: registry: a repository could not be read; its occurrences are kept");
                        let error = format!("{e:#}");
                        status.repos.push(RepoWalk {
                            repo: target.repo.clone(),
                            status: "failed".to_owned(),
                            components: held.get(&(project.id, key.clone())).copied().unwrap_or(0),
                            hint: read_failure_hint(&error),
                            error: Some(error),
                        });
                    }
                }
            }
            statuses.push(status);
        }

        let entries: Vec<_> = entries
            .into_iter()
            .filter(|(_, e)| e.organization_id == org)
            .collect();
        let occurrences: Vec<_> = occurrences
            .into_iter()
            .filter(|(_, o)| o.organization_id == org)
            .collect();
        let reads: Vec<_> = reads
            .into_iter()
            .filter(|(_, r)| r.organization_id == org)
            .collect();
        // The one signal across projects, then the threshold.
        super::candidates::apply_copies(&mut walk.reads, &occurrences);
        let plan = plan(&walk, &entries, &occurrences, &reads);
        self.sink.upsert(ctx, &plan.upsert, &plan.edges).await?;
        for id in &plan.retire {
            if let Err(e) = self.sink.delete(ctx, id).await {
                tracing::warn!(instance_id = %id, error = %format!("{e:#}"), "components-catalog: registry: a gone node could not be retired");
            }
        }
        // What each project's read came to, for the page's project list.
        let mut settings = self.settings(ctx).await?;
        settings.organization_id = Some(org);
        settings.last_walk = merge_walks(
            std::mem::take(&mut settings.last_walk),
            statuses,
            only.is_empty(),
        );
        self.sink
            .upsert(
                ctx,
                &[gts::registry_settings_node(
                    &org.to_string(),
                    serde_json::to_value(&settings)?,
                )],
                &[],
            )
            .await?;
        counts.entries_created = plan.created;
        counts.entries_updated = plan.updated;
        counts.occurrences_written = plan.occurrences_written;
        counts.occurrences_removed = plan.occurrences_removed;
        counts.orphaned = plan.orphaned;
        counts.candidates = plan.candidates_found;
        counts.reproposed = plan.reproposed;
        tracing::info!(organization_id = %org, ?counts, "components-catalog: registry walked");
        progress.set_with(
            "registry: done",
            serde_json::to_value(&counts).unwrap_or(Value::Null),
        );
        Ok(counts)
    }
}

#[cfg(test)]
#[path = "registry_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "registry_candidates_tests.rs"]
mod candidate_tests;
