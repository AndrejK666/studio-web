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
//! discovery never moves an entry's state -- are [`plan`], a pure function;
//! the rest is reading and writing around it.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;

use anyhow::anyhow;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::format_description::well_known::Rfc3339;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::gts::{self, GtsEdge, GtsNode};
use super::project_gears::LocalGear;
use super::repo_enrich::ProjectGearsRead;
use super::service::{CatalogService, RepoSource};
use crate::tasks::sdk::SyncReporter;

/// Code that looks like a gear, with evidence (P3).
pub const STATE_CANDIDATE: &str = "candidate";
/// The repository declares it. The only state discovery writes.
pub const STATE_DECLARED: &str = "declared";
/// Accepted as the organization's component (P2, a person).
pub const STATE_REGISTERED: &str = "registered";
/// Released for others to depend on (P2, a person).
pub const STATE_PUBLISHED: &str = "published";
/// A candidate the organization decided is not a gear (P2, a person).
pub const STATE_REJECTED: &str = "rejected";
/// Still present, no longer to be chosen (P2, a person).
pub const STATE_DEPRECATED: &str = "deprecated";

/// Every lifecycle state, in the order the lifecycle runs.
pub const STATES: [&str; 6] = [
    STATE_CANDIDATE,
    STATE_DECLARED,
    STATE_REGISTERED,
    STATE_PUBLISHED,
    STATE_REJECTED,
    STATE_DEPRECATED,
];

/// The states whose descriptive fields discovery still owns: nobody has
/// decided anything about such an entry, so what the repository says now is
/// the best answer. Past them a person owns the entry, and a walk only says
/// when it saw it last.
fn discovery_owns(state: &str) -> bool {
    matches!(state, STATE_CANDIDATE | STATE_DECLARED)
}

/// A registry entry, as stored.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
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
}

/// Where an entry was found, as stored. Carries what the repository said
/// there, so a project's own gears can be answered from the registry in the
/// shape `project_gears` answers them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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
    /// `gear.toml`, `gear.gdl`, `attribute`, `package` or `kit`.
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
}

impl OccurrenceRecord {
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
#[derive(Clone, Debug)]
pub struct RepoRead {
    pub project_id: Uuid,
    pub project_name: String,
    pub repo: String,
    pub repo_key: String,
    pub git_ref: String,
    pub commit: Option<String>,
    pub fingerprint: String,
    pub gears: Vec<LocalGear>,
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

/// What a walk changes in the registry. Pure: the stored entries,
/// occurrences and reads (each with its instance id) and what the walk saw,
/// to the nodes to write and the ids to retire.
///
/// - A component found anew is `declared`. An existing entry keeps its state,
///   whatever it is: a `rejected` entry is not resurrected, and nothing a
///   person decided is undone by a walk.
/// - Discovery refreshes what an entry says (kind, description, category,
///   capabilities) only while nobody owns it ([`discovery_owns`]).
/// - The occurrences of a repository read anew are what that read found;
///   the ones it no longer declares are retired. So are the occurrences of a
///   repository a project no longer names, and of a project out of scope.
/// - An entry with no occurrence left is `orphaned` and kept.
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

    // What the reads found, keyed by occurrence id; the first finding of a
    // component in one read wins, as in `project_gears`.
    let mut produced: BTreeMap<String, OccurrenceRecord> = BTreeMap::new();
    let mut found_by_entry: BTreeMap<String, (&RepoRead, &LocalGear)> = BTreeMap::new();
    // The name an entry goes by: the stored one, else the first spelling
    // found. `Studio-Tasks` in one project and `studio-tasks` in another are
    // one entry under one name.
    let mut names: BTreeMap<String, String> = BTreeMap::new();
    for read in &walk.reads {
        let project = read.project_id.to_string();
        for gear in &read.gears {
            let entry_id = gts::registry_entry_instance_id(&org, &gear.name);
            let name = names
                .entry(entry_id.clone())
                .or_insert_with(|| {
                    by_id
                        .get(&entry_id)
                        .map(|e| e.name.clone())
                        .unwrap_or_else(|| gear.name.clone())
                })
                .clone();
            let id = gts::occurrence_instance_id(&entry_id, &project, &read.repo, &gear.path);
            if produced.contains_key(&id) {
                continue;
            }
            found_by_entry
                .entry(entry_id.clone())
                .or_insert((read, gear));
            produced.insert(
                id,
                OccurrenceRecord {
                    organization_id: walk.org,
                    entry: name,
                    entry_id,
                    project_id: Some(read.project_id),
                    project_name: Some(read.project_name.clone()),
                    repo: read.repo.clone(),
                    repo_key: read.repo_key.clone(),
                    git_ref: Some(read.git_ref.clone()).filter(|r| !r.is_empty()),
                    path: gear.path.clone(),
                    commit: read.commit.clone(),
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
                    fingerprint: read.fingerprint.clone(),
                    seen_at: walk.now.clone(),
                },
            );
        }
    }

    // The stored occurrences that stay, and the ones that go.
    let mut remaining: BTreeMap<String, usize> = BTreeMap::new();
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
        }
    }
    for occ in produced.values() {
        *remaining.entry(occ.entry_id.clone()).or_default() += 1;
    }

    // The entries the reads found: new ones declared, known ones seen again.
    for (entry_id, (read, gear)) in &found_by_entry {
        match by_id.get_mut(entry_id) {
            Some(entry) => {
                entry.last_seen = Some(walk.now.clone());
                entry.fingerprint = Some(read.fingerprint.clone());
                if discovery_owns(&entry.state) {
                    entry.kind = gear.kind.clone();
                    entry.description = gear.description.clone().or(entry.description.take());
                    entry.category = gear.category.clone().or(entry.category.take());
                    if !gear.capabilities.is_empty() {
                        entry.capabilities = gear.capabilities.clone();
                    }
                }
            }
            None => {
                by_id.insert(
                    entry_id.clone(),
                    EntryRecord {
                        organization_id: walk.org,
                        name: names
                            .get(entry_id)
                            .cloned()
                            .unwrap_or_else(|| gear.name.clone()),
                        kind: gear.kind.clone(),
                        state: STATE_DECLARED.to_string(),
                        description: gear.description.clone(),
                        category: gear.category.clone(),
                        owner: None,
                        capabilities: gear.capabilities.clone(),
                        orphaned: false,
                        first_seen: Some(walk.now.clone()),
                        last_seen: Some(walk.now.clone()),
                        fingerprint: Some(read.fingerprint.clone()),
                    },
                );
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

/// What a person can do about a repository the walk could not read.
///
/// The walk runs as the service, on a schedule nobody is signed in to, so a
/// repository connected with someone's personal token is not readable to it --
/// by design: an organization-wide job must not borrow one person's
/// credential. The fix is to share the connection, not to impersonate.
pub fn read_failure_hint(error: &str) -> Option<String> {
    let e = error.to_ascii_lowercase();
    if e.contains("not readable") || e.contains("personal") {
        return Some(
            "The repository is connected with a personal token, which the registry's background read cannot use. Share the connection with the workspace or the organization, or connect the repository with a shared token."
                .to_owned(),
        );
    }
    if e.contains("401") || e.contains("403") || e.contains("bad credentials") {
        return Some("The connection's token was refused by the provider: renew it on the Connections page.".to_owned());
    }
    if e.contains("404") || e.contains("not found") {
        return Some("The repository or branch was not found with this connection: check the project's Sources.".to_owned());
    }
    None
}

/// The last walk's statuses after `walked`: a full walk replaces them, a walk
/// over named projects replaces only theirs.
pub fn merge_walks(previous: Vec<ProjectWalk>, walked: Vec<ProjectWalk>, full: bool) -> Vec<ProjectWalk> {
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
}

fn now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_default()
}

/// Typed records of one node type, each with its instance id. A payload that
/// does not read as `T` is skipped and logged.
fn records<T: serde::de::DeserializeOwned>(nodes: Vec<GtsNode>) -> Vec<(String, T)> {
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
        let last_walk = self.settings(ctx).await?.last_walk;
        let value = serde_json::to_value(SettingsRecord {
            organization_id: Some(org),
            excluded_project_ids: ids.clone(),
            last_walk,
        })?;
        self.sink
            .upsert(
                ctx,
                &[gts::registry_settings_node(&org.to_string(), value)],
                &[],
            )
            .await?;
        Ok(ids)
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
            let repos = match self.project_repos(ctx, &project.id.to_string()).await {
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
                    .project_gears_unless(ctx, &self.project_gears, known)
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
                    Ok(ProjectGearsRead::Read { fingerprint, gears }) => {
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
                            commit: reader.head_commit(ctx).await,
                            fingerprint,
                            gears: gears.as_ref().clone(),
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
        settings.last_walk = merge_walks(std::mem::take(&mut settings.last_walk), statuses, only.is_empty());
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
