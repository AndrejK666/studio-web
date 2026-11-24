//! What a kit is made of, as files: its `kit.gdl`, its source manifest, and
//! an archive of its contents (`GET /catalog/{kit_slug}/archive`).
//!
//! # The archive
//!
//! A `.tar.gz` whose every entry is under one directory, `<slug>/`:
//!
//! ```text
//! <slug>/README.md            what is here, where it came from, what is missing
//! <slug>/kit.gdl              authored, or rendered (ADR-0068 §3, `gdl.rs`)
//! <slug>/kit.json             the source manifest as written: kit.json or
//! <slug>/.cf-studio-kit.toml    .cf-studio-kit.toml (none for an authored kit.gdl)
//! <slug>/model/overlay.json   the model overlay as written: types, fields,
//!                               relations, tabs, lifecycles (ADR-0067 §6)
//! <slug>/model/contents.json  the types as Studio reads them: GTS id, model id,
//!                               new or adopted (ADR-0070), fields; and what the
//!                               model adds on other types
//! <slug>/claims.json          what it claims of the gears (ADR-0071 §2), its
//!                               MCP tools and its permissions
//! <slug>/material/…           files `cfs` writes into a checkout, read from the
//!                               kit's repository at its pinned commit
//! <slug>/mfe/<package>/…      the micro-frontend bundles it serves at run time
//! ```
//!
//! A built-in kit has no repository: its screens ship in Studio's portal
//! image, and the README says so. Repository reads go through a connection
//! (an organization's kit: the one its shelf names; an official kit: the
//! caller's organization's first GitHub connection) as this gear's service
//! identity in the organization. One that fails leaves those files out and
//! the README says which and why: the archive is partial, never refused.
//!
//! Limits: [`MAX_FILE_BYTES`] per file, [`MAX_ARCHIVE_BYTES`] and
//! [`MAX_ENTRIES`] in all, [`FETCH_BUDGET`] for the repository reads. Every
//! entry's path is checked ([`safe_path`]): relative, no `..`, `.` or empty
//! segment, no backslash, drive or control character.

use crate::plural::plural;
use std::io::Write;
use std::path::Path;
use std::time::{Duration, Instant};

use flate2::{Compression, write::GzEncoder};
use futures_util::StreamExt;
use serde_json::{Value, json};
use uuid::Uuid;

use super::contents::{
    KitContents, KitDetail, KitField, MANIFEST_BUILTIN, MANIFEST_CF_STUDIO_KIT, MANIFEST_KIT_GDL,
    MANIFEST_KIT_JSON,
};
use super::gdl::{GdlInput, KIT_GDL, OVERLAY_PATH, render};
use super::installed::Refusal;
use super::kind::{KitKind, kind_of};
use super::manifest::{CF_STUDIO_KIT_TOML, KIT_JSON};
use super::service::{SHELF_BUILTIN, SHELF_OFFICIAL};
use super::shelf::{KitSourceReader, RepoAt, ShelfKit};

/// The largest file put in an archive.
pub const MAX_FILE_BYTES: usize = 8 * 1024 * 1024;
/// The most bytes of files in one archive, before compression.
pub const MAX_ARCHIVE_BYTES: usize = 64 * 1024 * 1024;
/// The most files in one archive.
pub const MAX_ENTRIES: usize = 2000;
/// How long the repository reads of one archive may take in all.
pub const FETCH_BUDGET: Duration = Duration::from_secs(60);
/// Repository reads at once.
const FETCH_CONCURRENCY: usize = 8;
/// The largest authored `kit.gdl` read.
const MAX_GDL_BYTES: u64 = 256 * 1024;

/// `path` when it is safe as an archive entry or a repository path:
/// relative, `/`-separated, no `..`, `.` or empty segment, no backslash,
/// drive letter or control character, at most 240 bytes. A trailing `/` is
/// dropped.
pub fn safe_path(path: &str) -> Option<String> {
    let path = path.trim().trim_end_matches('/');
    if path.is_empty()
        || path.len() > 240
        || path.starts_with('/')
        || path.contains(['\\', ':'])
        || path.chars().any(char::is_control)
    {
        return None;
    }
    if path
        .split('/')
        .any(|seg| seg.is_empty() || seg == "." || seg == "..")
    {
        return None;
    }
    Some(path.to_owned())
}

/// What the kit's page and its routes say about its files.
///
/// `kit.gdl` is rendered from this manifest; `None` when the kit has an
/// authored one (a bundle kit).
pub fn rendered_from(detail: &KitDetail) -> Option<&'static str> {
    match detail.manifest {
        Some(MANIFEST_KIT_GDL) => None,
        Some(MANIFEST_BUILTIN) => Some("the built-in kit.json and Studio's screens"),
        Some(MANIFEST_KIT_JSON) => Some(KIT_JSON),
        Some(MANIFEST_CF_STUDIO_KIT) => Some(CF_STUDIO_KIT_TOML),
        _ => Some("the catalogue entry (no manifest describes this kit)"),
    }
}

/// The file `GET /catalog/{kit_slug}/manifest` answers with: `kit.json`,
/// `.cf-studio-kit.toml` or `kit.gdl`; `None` when no manifest describes the
/// kit.
pub fn source_file(detail: &KitDetail) -> Option<&'static str> {
    match detail.manifest {
        Some(MANIFEST_BUILTIN | MANIFEST_KIT_JSON) => Some(KIT_JSON),
        Some(MANIFEST_CF_STUDIO_KIT) => Some(CF_STUDIO_KIT_TOML),
        Some(MANIFEST_KIT_GDL) => Some(KIT_GDL),
        _ => None,
    }
}

/// The content type a source manifest is served with.
pub fn content_type_of(file: &str) -> &'static str {
    match file {
        KIT_JSON => "application/json",
        CF_STUDIO_KIT_TOML => "application/toml; charset=utf-8",
        _ => "text/plain; charset=utf-8",
    }
}

/// Fill in each MCP tool's description from the MCP registry (the tools a
/// kit claims carry only their names).
pub fn with_tool_descriptions(contents: &mut KitContents) {
    if contents.mcp_tools.iter().all(|t| t.description.is_some()) {
        return;
    }
    let registry = crate::mcp::tools();
    for tool in contents
        .mcp_tools
        .iter_mut()
        .filter(|t| t.description.is_none())
    {
        if let Some(known) = registry.iter().find(|t| t.name == tool.name) {
            tool.description = Some(known.description.to_owned());
        }
    }
}

/// The kit's model overlay as written, when it brings one.
pub fn overlay_of(detail: &KitDetail, shelf: Option<&ShelfKit>) -> Option<Value> {
    if let Some(kit) = shelf {
        return kit.manifest.model.clone();
    }
    if detail.kit.shelf == SHELF_BUILTIN {
        return super::manifest::builtin_manifest(&detail.kit.slug).and_then(|m| m.model);
    }
    None
}

/// The kit's `kit.gdl`: authored (a bundle kit's, read from its directory),
/// else rendered from what Studio read of it. `local` is the bundle kit's
/// directory.
pub async fn gdl_text(
    detail: &KitDetail,
    shelf: Option<&ShelfKit>,
    local: Option<&Path>,
) -> anyhow::Result<String> {
    if detail.manifest == Some(MANIFEST_KIT_GDL)
        && let Some(root) = local
    {
        return read_local_text(&root.join(KIT_GDL)).await;
    }
    let kind = kind_of(detail);
    Ok(render(&GdlInput {
        detail,
        rendered_from: rendered_from(detail).unwrap_or(KIT_GDL),
        overlay: overlay_of(detail, shelf).is_some(),
        kind: &kind,
    }))
}

async fn read_local_text(path: &Path) -> anyhow::Result<String> {
    let meta = tokio::fs::metadata(path).await?;
    if meta.len() > MAX_GDL_BYTES {
        anyhow::bail!("{} is larger than {MAX_GDL_BYTES} bytes", path.display());
    }
    Ok(tokio::fs::read_to_string(path).await?)
}

/// A kit's source manifest, as written.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceManifest {
    pub file: &'static str,
    pub body: String,
    /// Not the file as written: the copy the shelf keeps, written out again
    /// because the repository could not be read.
    pub kept_copy: bool,
}

fn refusal_text(r: &Refusal) -> String {
    match r {
        Refusal::Invalid(why) => why.clone(),
        Refusal::Internal(e) => format!("{e:#}"),
        other => other.to_string(),
    }
}

/// The kit's source manifest: a built-in kit's compiled-in `kit.json`, the
/// official kit's `.cf-studio-kit.toml` copy at its pin, an organization's
/// kit's manifest read at its pinned commit (its kept copy when the
/// repository does not answer and it is a `kit.json`), a bundle kit's
/// `kit.gdl`. `Ok(None)` when no manifest describes the kit; `Err` says why
/// one could not be read.
pub async fn source_manifest(
    detail: &KitDetail,
    shelf: Option<&ShelfKit>,
    local: Option<&Path>,
    reader: &dyn KitSourceReader,
    org: Uuid,
) -> Result<Option<SourceManifest>, String> {
    let Some(file) = source_file(detail) else {
        return Ok(None);
    };
    if let Some(kit) = shelf {
        let path = if kit.origin.path.is_empty() {
            kit.origin.manifest_file.clone()
        } else {
            format!("{}/{}", kit.origin.path, kit.origin.manifest_file)
        };
        let read = match super::installed::service_context(org) {
            Ok(ctx) => reader
                .read_file(&ctx, org, &kit.origin, &path)
                .await
                .map_err(|r| refusal_text(&r)),
            Err(e) => Err(format!("{e:#}")),
        };
        return match read {
            Ok(Some(bytes)) => Ok(Some(SourceManifest {
                file,
                body: String::from_utf8_lossy(&bytes).into_owned(),
                kept_copy: false,
            })),
            other => {
                let why = match other {
                    Ok(_) => format!("{path} is not at {}", kit.origin.commit),
                    Err(why) => why,
                };
                if file == KIT_JSON {
                    let body =
                        serde_json::to_string_pretty(&kit.manifest).map_err(|e| format!("{e}"))?;
                    tracing::warn!(kit = %kit.kit.slug, "studio-kits: the kit's manifest could not be read at its commit, the shelf's copy is served: {why}");
                    Ok(Some(SourceManifest {
                        file,
                        body,
                        kept_copy: true,
                    }))
                } else {
                    Err(format!(
                        "{} at {} could not be read: {why}",
                        kit.origin.repository, kit.origin.commit
                    ))
                }
            }
        };
    }
    match detail.manifest {
        Some(MANIFEST_BUILTIN) => Ok(
            super::manifest::builtin_manifest_text(&detail.kit.slug).map(|body| SourceManifest {
                file,
                body: body.to_owned(),
                kept_copy: false,
            }),
        ),
        Some(MANIFEST_CF_STUDIO_KIT) if detail.kit.shelf == SHELF_OFFICIAL => Ok(
            super::contents::official_manifest_text(&detail.kit).map(|body| SourceManifest {
                file,
                body: body.to_owned(),
                kept_copy: false,
            }),
        ),
        Some(MANIFEST_KIT_GDL) => match local {
            Some(root) => read_local_text(&root.join(KIT_GDL))
                .await
                .map(|body| {
                    Some(SourceManifest {
                        file,
                        body,
                        kept_copy: false,
                    })
                })
                .map_err(|e| format!("{e:#}")),
            None => Ok(None),
        },
        _ => Ok(None),
    }
}

// ── The archive ──

/// Files gathered for one archive, under its root directory.
pub struct Archive {
    root: String,
    entries: Vec<(String, Vec<u8>)>,
    bytes: usize,
    /// What is missing, and why; the README lists them.
    pub notes: Vec<String>,
}

impl Archive {
    pub fn new(root: &str) -> Self {
        Self {
            root: root.to_owned(),
            entries: Vec::new(),
            bytes: 0,
            notes: Vec::new(),
        }
    }

    /// Add `path` (under the root). Refused with a note when the path is
    /// not safe, the file too large or the archive full.
    pub fn add(&mut self, path: &str, bytes: Vec<u8>) -> bool {
        let Some(path) = safe_path(path) else {
            self.notes.push(format!(
                "`{path}` was left out: not a path an archive may hold"
            ));
            return false;
        };
        if self.entries.iter().any(|(p, _)| *p == path) {
            return false;
        }
        if bytes.len() > MAX_FILE_BYTES {
            self.notes.push(format!(
                "`{path}` was left out: {} bytes, more than {MAX_FILE_BYTES}",
                bytes.len()
            ));
            return false;
        }
        if self.entries.len() + 1 >= MAX_ENTRIES || self.bytes + bytes.len() > MAX_ARCHIVE_BYTES {
            self.notes.push(format!(
                "`{path}` was left out: the archive holds at most {MAX_ENTRIES} files and \
                 {MAX_ARCHIVE_BYTES} bytes"
            ));
            return false;
        }
        self.bytes += bytes.len();
        self.entries.push((path, bytes));
        true
    }

    /// The paths added so far, under the root.
    #[cfg(test)]
    pub fn paths(&self) -> Vec<&str> {
        self.entries.iter().map(|(p, _)| p.as_str()).collect()
    }

    /// How many added paths start with `prefix`.
    pub fn count_under(&self, prefix: &str) -> usize {
        self.entries
            .iter()
            .filter(|(p, _)| p.starts_with(prefix))
            .count()
    }

    /// The archive, `readme` first, as a gzipped tar.
    pub fn finish(self, readme: &str) -> std::io::Result<Vec<u8>> {
        let mtime = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        let mut gz = GzEncoder::new(Vec::new(), Compression::default());
        let readme = ("README.md".to_owned(), readme.as_bytes().to_vec());
        for (path, bytes) in std::iter::once(&readme).chain(self.entries.iter()) {
            let name = format!("{}/{path}", self.root);
            let Some(header) = tar_header(&name, bytes.len() as u64, mtime) else {
                continue;
            };
            gz.write_all(&header)?;
            gz.write_all(bytes)?;
            let pad = (512 - bytes.len() % 512) % 512;
            gz.write_all(&vec![0u8; pad])?;
        }
        gz.write_all(&[0u8; 1024])?;
        gz.finish()
    }
}

/// `name` split into a ustar prefix and name; `None` when it cannot be.
fn split_name(name: &str) -> Option<(&str, &str)> {
    if name.len() <= 100 {
        return Some(("", name));
    }
    name.match_indices('/')
        .map(|(i, _)| (&name[..i], &name[i + 1..]))
        .find(|(prefix, rest)| prefix.len() <= 155 && !rest.is_empty() && rest.len() <= 100)
}

fn put_octal(field: &mut [u8], value: u64) {
    let width = field.len() - 1;
    let text = format!("{value:0width$o}");
    let text = &text.as_bytes()[text.len().saturating_sub(width)..];
    field[..width].copy_from_slice(text);
    field[width] = 0;
}

/// A ustar header of a regular file.
fn tar_header(name: &str, size: u64, mtime: u64) -> Option<[u8; 512]> {
    let (prefix, name) = split_name(name)?;
    let mut h = [0u8; 512];
    h[..name.len()].copy_from_slice(name.as_bytes());
    put_octal(&mut h[100..108], 0o644);
    put_octal(&mut h[108..116], 0);
    put_octal(&mut h[116..124], 0);
    put_octal(&mut h[124..136], size);
    put_octal(&mut h[136..148], mtime);
    h[148..156].fill(b' ');
    h[156] = b'0';
    h[257..263].copy_from_slice(b"ustar\0");
    h[263..265].copy_from_slice(b"00");
    h[345..345 + prefix.len()].copy_from_slice(prefix.as_bytes());
    let sum: u32 = h.iter().map(|b| u32::from(*b)).sum();
    let checksum = format!("{sum:06o}\0 ");
    h[148..156].copy_from_slice(checksum.as_bytes());
    Some(h)
}

/// A file or directory to read from a repository into the archive.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Wanted {
    /// Where it goes, under the archive's root.
    pub into: String,
    /// Where it is, from the repository's root.
    pub from: String,
    pub directory: bool,
}

fn join(dir: &str, path: &str) -> String {
    let dir = dir.trim_matches('/');
    let path = path.trim_start_matches('/');
    if dir.is_empty() {
        path.to_owned()
    } else {
        format!("{dir}/{path}")
    }
}

/// The resources of kit `slug` in a `.cf-studio-kit.toml`: each `source`
/// (from the repository's root) into `material/<install_path>`.
pub fn toml_material(body: &str, slug: &str) -> Vec<Wanted> {
    let mut out = Vec::new();
    let mut current: Option<String> = None;
    // source, install_path, directory
    let mut resource: Option<(Option<String>, Option<String>, bool)> = None;
    let mut flush = |resource: &mut Option<(Option<String>, Option<String>, bool)>, ours: bool| {
        if let Some((Some(from), Some(into), directory)) = resource.take()
            && ours
        {
            out.push(Wanted {
                into: join("material", &into),
                from: from.trim_end_matches('/').to_owned(),
                directory,
            });
        }
    };
    let mut in_kit = false;
    for raw in body.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let ours = current.as_deref() == Some(slug);
        if line.starts_with('[') {
            flush(&mut resource, ours);
            in_kit = line == "[[kits]]";
            if in_kit {
                current = None;
            } else if line == "[[kits.resources]]" {
                resource = Some((None, None, false));
            }
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value
            .trim()
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .map(str::to_owned);
        if in_kit && key.trim() == "slug" {
            current = value;
            continue;
        }
        if let Some((from, into, directory)) = resource.as_mut() {
            match key.trim() {
                "source" => *from = value,
                "install_path" => *into = value,
                "type" => *directory = value.as_deref() == Some("directory"),
                _ => {}
            }
        }
    }
    let ours = current.as_deref() == Some(slug);
    flush(&mut resource, ours);
    out
}

/// A `kit.json`'s material and bundles, beside the manifest in `kit_dir`:
/// `material/<path>` and `mfe/<package>/…`.
pub fn kit_dir_wanted(contents: &KitContents, kit_dir: &str) -> Vec<Wanted> {
    let material = contents.material.iter().map(|m| Wanted {
        into: join("material", &m.path),
        from: join(kit_dir, m.path.trim_end_matches('/')),
        directory: m.path.ends_with('/'),
    });
    let mfe = contents.mfe.iter().map(|p| Wanted {
        into: p.clone(),
        from: join(kit_dir, p),
        directory: true,
    });
    material.chain(mfe).collect()
}

/// One repository read: where it goes, where it is, and what came back.
type FileRead = (String, String, Result<Option<Vec<u8>>, String>);

/// Read `wanted` from the repository `at` names into `archive`; what cannot
/// be read becomes a note.
pub async fn fetch_into(
    archive: &mut Archive,
    reader: &dyn KitSourceReader,
    org: Uuid,
    at: &RepoAt,
    wanted: &[Wanted],
) {
    let label = format!("{} at {}", at.repository, short(&at.commit));
    let ctx = match super::installed::service_context(org) {
        Ok(ctx) => ctx,
        Err(e) => {
            archive.notes.push(format!(
                "Nothing was read from {label}: {e:#}. The kit's files are not in this archive."
            ));
            return;
        }
    };
    let mut files: Vec<(String, String)> = Vec::new();
    let mut checked: Vec<&Wanted> = Vec::new();
    for w in wanted {
        match (safe_path(&w.into), safe_path(&w.from)) {
            (Some(_), Some(_)) => checked.push(w),
            _ => archive.notes.push(format!(
                "`{}` was left out: its path is not one an archive may hold",
                w.from
            )),
        }
    }
    if checked.iter().any(|w| w.directory) {
        match reader.list_at(&ctx, org, at).await {
            Ok(tree) => {
                for w in checked.iter().filter(|w| w.directory) {
                    let prefix = format!("{}/", w.from);
                    let mut found = 0usize;
                    for (path, size) in &tree {
                        let Some(rest) = path.strip_prefix(&prefix) else {
                            continue;
                        };
                        found += 1;
                        if size.is_some_and(|s| s > MAX_FILE_BYTES as i64) {
                            archive.notes.push(format!(
                                "`{path}` was left out: larger than {MAX_FILE_BYTES} bytes"
                            ));
                            continue;
                        }
                        files.push((join(&w.into, rest), path.clone()));
                    }
                    if found == 0 {
                        archive.notes.push(format!(
                            "The directory `{}` is empty or missing in {label}.",
                            w.from
                        ));
                    }
                }
            }
            Err(r) => archive.notes.push(format!(
                "The directories ({}) could not be listed in {label}: {}",
                checked
                    .iter()
                    .filter(|w| w.directory)
                    .map(|w| format!("`{}`", w.from))
                    .collect::<Vec<_>>()
                    .join(", "),
                refusal_text(&r)
            )),
        }
    }
    files.extend(
        checked
            .iter()
            .filter(|w| !w.directory)
            .map(|w| (w.into.clone(), w.from.clone())),
    );
    if files.len() > MAX_ENTRIES {
        archive.notes.push(format!(
            "{} of {} files were left out: an archive holds at most {MAX_ENTRIES}",
            files.len() - MAX_ENTRIES,
            files.len()
        ));
        files.truncate(MAX_ENTRIES);
    }
    let deadline = Instant::now() + FETCH_BUDGET;
    let ctx = &ctx;
    let mut results: Vec<FileRead> =
        futures_util::stream::iter(files.into_iter().map(|(into, from)| async move {
            let left = deadline.saturating_duration_since(Instant::now());
            let read = match tokio::time::timeout(left, reader.read_at(ctx, org, at, &from)).await {
                Ok(Ok(found)) => Ok(found),
                Ok(Err(r)) => Err(refusal_text(&r)),
                Err(_) => Err(format!("not read within {} s", FETCH_BUDGET.as_secs())),
            };
            (into, from, read)
        }))
        .buffer_unordered(FETCH_CONCURRENCY)
        .collect()
        .await;
    results.sort_by(|a, b| a.0.cmp(&b.0));
    let mut missing: Vec<String> = Vec::new();
    let mut failed: Vec<(String, String)> = Vec::new();
    for (into, from, read) in results {
        match read {
            Ok(Some(bytes)) => {
                archive.add(&into, bytes);
            }
            Ok(None) => missing.push(from),
            Err(why) => failed.push((from, why)),
        }
    }
    if !missing.is_empty() {
        archive.notes.push(format!(
            "{} not in {label}: {}",
            if missing.len() == 1 {
                "1 file the manifest names is".to_string()
            } else {
                format!("{} files the manifest names are", missing.len())
            },
            listed(&missing)
        ));
    }
    if !failed.is_empty() {
        let paths: Vec<String> = failed.iter().map(|(p, _)| p.clone()).collect();
        archive.notes.push(format!(
            "{} could not be read from {label} ({}): {}",
            plural(failed.len(), "file", "files"),
            failed[0].1,
            listed(&paths)
        ));
    }
}

/// Prepare the exact inputs CFS expects, at the recorded commit. A missing
/// resource aborts the install instead of producing a partial checkout.
#[cfg(feature = "theia-bridge")]
pub(super) async fn ide_source(
    reader: &dyn KitSourceReader,
    org: Uuid,
    slug: &str,
    origin: &super::shelf::KitOrigin,
) -> anyhow::Result<Vec<crate::studio_theia::sdk::models::KitSourceFile>> {
    use crate::studio_theia::sdk::models::KitSourceFile;
    use anyhow::Context;
    use base64::Engine;

    anyhow::ensure!(
        origin.manifest_file == CF_STUDIO_KIT_TOML,
        "invalid IDE kit manifest"
    );
    let ctx = super::installed::service_context(org)?;
    let manifest_path = join(&origin.path, CF_STUDIO_KIT_TOML);
    let manifest = reader
        .read_file(&ctx, org, origin, &manifest_path)
        .await
        .map_err(|error| anyhow::anyhow!("{}", refusal_text(&error)))?
        .context("the IDE kit manifest is unavailable at the selected commit")?;
    let mut document: toml_edit::DocumentMut = std::str::from_utf8(&manifest)?.parse()?;
    let kit = document
        .get("kits")
        .and_then(toml_edit::Item::as_array_of_tables)
        .and_then(|kits| {
            kits.iter()
                .find(|kit| kit.get("slug").and_then(toml_edit::Item::as_str) == Some(slug))
        })
        .context("the IDE kit manifest has no matching kit")?;
    let resource_tables = kit
        .get("resources")
        .map(|item| {
            item.as_array_of_tables()
                .context("IDE kit resources must be manifest tables")
        })
        .transpose()?;
    let mut wanted = Vec::new();
    for resource in resource_tables.into_iter().flat_map(|tables| tables.iter()) {
        let source = resource
            .get("source")
            .and_then(toml_edit::Item::as_str)
            .and_then(safe_path)
            .context("invalid IDE kit resource source")?;
        wanted.push(Wanted {
            from: join(&origin.path, &source),
            into: source,
            directory: resource.get("type").and_then(toml_edit::Item::as_str) == Some("directory"),
        });
    }
    // CFS validates the whole manifest before selecting a kit. Stage a
    // manifest for just this kit, together with only its resources.
    let mut selected = toml_edit::ArrayOfTables::new();
    selected.push(kit.clone());
    document["kits"] = toml_edit::Item::ArrayOfTables(selected);
    let mut archive = Archive::new(slug);
    archive.add(CF_STUDIO_KIT_TOML, document.to_string().into_bytes());
    fetch_into(&mut archive, reader, org, &RepoAt::from(origin), &wanted).await;
    anyhow::ensure!(
        archive.notes.is_empty(),
        "kit source is incomplete: {}",
        archive.notes.join("; ")
    );
    anyhow::ensure!(
        archive.bytes < 1_425_000,
        "IDE kit source exceeds the 1.9 MB transfer limit"
    );
    let files: Vec<_> = archive
        .entries
        .into_iter()
        .map(|(path, bytes)| KitSourceFile {
            path,
            content: base64::engine::general_purpose::STANDARD.encode(bytes),
        })
        .collect();
    // The control route's JSON limit is 2 MiB. Leave room for the envelope.
    anyhow::ensure!(
        serde_json::to_vec(&files)?.len() < 1_900_000,
        "IDE kit source exceeds the 1.9 MB transfer limit"
    );
    Ok(files)
}

/// The first few of `items`, and how many more.
fn listed(items: &[String]) -> String {
    let shown: Vec<String> = items.iter().take(8).map(|s| format!("`{s}`")).collect();
    if items.len() > shown.len() {
        format!(
            "{} and {} more",
            shown.join(", "),
            items.len() - shown.len()
        )
    } else {
        shown.join(", ")
    }
}

fn short(commit: &str) -> &str {
    if commit.len() == 40 && commit.chars().all(|c| c.is_ascii_hexdigit()) {
        &commit[..12]
    } else {
        commit
    }
}

/// A bundle kit's packages, read from its directory into `mfe/<package>/…`:
/// regular files only (no link, nothing hidden). Blocking: run it off the
/// async threads.
pub fn local_bundles(root: &Path, mfe: &[String]) -> (Vec<(String, Vec<u8>)>, Vec<String>) {
    let mut files = Vec::new();
    let mut notes = Vec::new();
    let mut total = 0usize;
    for package in mfe {
        let Some(package) = safe_path(package) else {
            continue;
        };
        let mut stack = vec![(root.join(&package), package.clone())];
        while let Some((dir, into)) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                notes.push(format!(
                    "`{into}` could not be read from the kit's directory"
                ));
                continue;
            };
            let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
            entries.sort_by_key(|e| e.file_name());
            for entry in entries {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') {
                    continue;
                }
                let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                    continue;
                };
                let path = format!("{into}/{name}");
                if meta.is_dir() {
                    stack.push((entry.path(), path));
                } else if meta.is_file() {
                    if meta.len() > MAX_FILE_BYTES as u64
                        || total + meta.len() as usize > MAX_ARCHIVE_BYTES
                        || files.len() >= MAX_ENTRIES
                    {
                        notes.push(format!("`{path}` was left out: too large for the archive"));
                        continue;
                    }
                    match std::fs::read(entry.path()) {
                        Ok(bytes) => {
                            total += bytes.len();
                            files.push((path, bytes));
                        }
                        Err(e) => notes.push(format!("`{path}` could not be read: {e}")),
                    }
                }
            }
        }
    }
    (files, notes)
}

fn field_json(f: &KitField) -> Value {
    json!({
        "on": f.on,
        "name": f.name,
        "type": f.type_name,
        "description": f.description,
        "required": f.required,
        "origin": f.origin,
    })
}

/// `model/contents.json`: the types as Studio reads them, and what the model
/// adds elsewhere.
pub fn model_contents_json(c: &KitContents) -> Value {
    json!({
        "types": c.types.iter().map(|t| json!({
            "gts": t.gts,
            "id": t.id,
            "name": t.name,
            "description": t.description,
            // ADR-0070 §4: a type the core already has, which the kit adopts.
            "brings": if t.adopts { "existing" } else { "new" },
            "fields": t.fields.iter().map(field_json).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "fields": c.model.fields.iter().map(field_json).collect::<Vec<_>>(),
        "relations": c.model.relations.iter().map(|r| json!({
            "on": r.on, "name": r.name, "target": r.target, "label": r.label,
            "verb": r.verb, "origin": r.origin,
        })).collect::<Vec<_>>(),
        "tabs": c.model.tabs.iter().map(|t| json!({
            "level": t.level, "name": t.name, "label": t.label, "shows": t.target,
        })).collect::<Vec<_>>(),
    })
}

/// `claims.json`: what the kit claims of the gears, its MCP tools, its
/// Inbox sources, rules and functions, and its permissions.
pub fn claims_json(c: &KitContents) -> Value {
    json!({
        "gears": c.gears.iter().map(|g| json!({
            "gear": g.gear, "types": g.types, "mcp_tools": g.mcp_tools,
            "routes": g.routes, "sync_only_with_kit": g.sync_only_with_kit,
        })).collect::<Vec<_>>(),
        "mcp_tools": c.mcp_tools.iter().map(|t| json!({
            "name": t.name, "description": t.description,
        })).collect::<Vec<_>>(),
        "inbox": c.inbox.iter().map(|i| json!({"id": i.id, "label": i.label})).collect::<Vec<_>>(),
        "rules": c.rules.iter().map(|r| json!({"name": r.name, "description": r.description})).collect::<Vec<_>>(),
        "functions": c.functions.iter().map(|f| json!({
            "name": f.name, "runtime": f.runtime, "description": f.description,
        })).collect::<Vec<_>>(),
        "permissions": {
            "reads": c.permissions.reads,
            "writes": c.permissions.writes,
            "listens": c.permissions.listens,
        },
    })
}

/// What the archive's metadata entries are made of.
pub struct Meta<'a> {
    pub detail: &'a KitDetail,
    pub kind: &'a KitKind,
    pub gdl: &'a str,
    pub source: Option<&'a SourceManifest>,
    pub overlay: Option<&'a Value>,
}

fn pretty(v: &Value) -> Vec<u8> {
    let mut out = serde_json::to_vec_pretty(v).unwrap_or_default();
    out.push(b'\n');
    out
}

/// Add `kit.gdl`, the source manifest, the model and the claims.
pub fn add_meta(archive: &mut Archive, m: &Meta<'_>) {
    archive.add(KIT_GDL, m.gdl.as_bytes().to_vec());
    if let Some(source) = m.source
        && source.file != KIT_GDL
    {
        archive.add(source.file, source.body.as_bytes().to_vec());
    }
    if let Some(overlay) = m.overlay {
        archive.add(OVERLAY_PATH, pretty(overlay));
    }
    archive.add(
        "model/contents.json",
        pretty(&model_contents_json(&m.detail.contents)),
    );
    archive.add("claims.json", pretty(&claims_json(&m.detail.contents)));
}

/// The archive's file name: `<slug>-<version>.tar.gz`, a commit shortened.
pub fn file_name(detail: &KitDetail) -> String {
    let version: String = short(&detail.kit.default_version)
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("{}-{version}.tar.gz", detail.kit.slug)
}

/// The README at the archive's root.
pub fn readme(m: &Meta<'_>, archive: &Archive) -> String {
    let k = &m.detail.kit;
    let c = &m.detail.contents;
    let mut out = format!("# {} (`{}`)\n\n", k.name, k.slug);
    if !k.description.trim().is_empty() {
        out.push_str(&format!("{}\n\n", k.description.trim()));
    }
    out.push_str(&format!(
        "- Version: `{}`\n- Shelf: {}\n- Kit type: {} (brings {})\n- Described by: {}\n",
        k.default_version,
        k.shelf,
        m.kind.kind,
        m.kind.brings.join(", "),
        m.detail.manifest.unwrap_or("nothing reliable")
    ));
    if !k.repository_url.is_empty() {
        out.push_str(&format!("- Repository: {}\n", k.repository_url));
    }
    out.push_str("\n## What is here\n\n| File | What it is |\n| --- | --- |\n");
    let gdl = match rendered_from(m.detail) {
        Some(from) => format!(
            "the manifest in the GDL 1.7 shape of ADR-0068 §3, **rendered by Studio from {from}**: \
             no authored `kit.gdl` exists for this kit"
        ),
        None => "the kit's own manifest, as authored".to_owned(),
    };
    out.push_str(&format!("| `{KIT_GDL}` | {gdl} |\n"));
    if let Some(s) = m.source
        && s.file != KIT_GDL
    {
        let how = if s.kept_copy {
            "the copy Studio keeps of it (the repository could not be read)"
        } else {
            "as written"
        };
        out.push_str(&format!("| `{}` | the source manifest, {how} |\n", s.file));
    }
    if m.overlay.is_some() {
        out.push_str(&format!(
            "| `{OVERLAY_PATH}` | the model overlay as written: types, fields, relations, tabs, \
             lifecycles (ADR-0067 §6) |\n"
        ));
    }
    out.push_str(&format!(
        "| `model/contents.json` | the {} (GTS id, model id, new or \
         existing, fields) and what the model adds on other types |\n",
        if c.types.len() == 1 {
            "1 type as Studio reads it".to_string()
        } else {
            format!("{} types as Studio reads them", c.types.len())
        }
    ));
    out.push_str(&format!(
        "| `claims.json` | what it claims of {}, its {}, Inbox sources, rules, \
         functions and permissions |\n",
        plural(c.gears.len(), "gear", "gears"),
        plural(c.mcp_tools.len(), "MCP tool", "MCP tools")
    ));
    let material = archive.count_under("material/");
    if material > 0 || !c.material.is_empty() {
        out.push_str(&format!(
            "| `material/` | {} `cfs` writes into a project's checkout \
             (`<cf-studio-path>/config/kits/{}/`), read from the repository at the pinned commit |\n",
            plural(material, "file", "files"),
            k.slug
        ));
    }
    let bundles = archive.count_under("mfe/");
    if bundles > 0 || !c.mfe.is_empty() {
        out.push_str(&format!(
            "| `mfe/` | {} of its micro-frontend bundles, loaded by the shell at run \
             time (ADR-0068 phase 5) |\n",
            plural(bundles, "file", "files")
        ));
    }
    if k.shelf == SHELF_BUILTIN {
        out.push_str(
            "\nA built-in kit has no repository of its own. Its screens ship in Studio's portal \
             image (the portal's micro-frontends) and its data is held by the gears it claims, so \
             neither is in this archive.\n",
        );
    }
    if !archive.notes.is_empty() {
        out.push_str("\n## Partial: what is missing\n\n");
        for note in &archive.notes {
            out.push_str(&format!("- {note}\n"));
        }
    }
    out
}

/// The kit's archive, `.tar.gz`: everything above, its material and bundles
/// read where they are. `local` is a bundle kit's directory; `org` the
/// organization whose connections read a repository.
pub async fn build(
    detail: &KitDetail,
    shelf: Option<&ShelfKit>,
    local: Option<&super::bundles::LocalKit>,
    reader: &dyn KitSourceReader,
    org: Uuid,
) -> anyhow::Result<Vec<u8>> {
    let kind = kind_of(detail);
    let root_dir = local.map(|l| l.root.as_path());
    let gdl = gdl_text(detail, shelf, root_dir).await?;
    let mut archive = Archive::new(&detail.kit.slug);
    let source = match source_manifest(detail, shelf, root_dir, reader, org).await {
        Ok(found) => found,
        Err(why) => {
            archive
                .notes
                .push(format!("The source manifest could not be read: {why}"));
            None
        }
    };
    if let Some(s) = source.as_ref().filter(|s| s.kept_copy) {
        archive.notes.push(format!(
            "`{}` is the copy Studio keeps: the repository could not be read at the pinned commit.",
            s.file
        ));
    }
    let overlay = overlay_of(detail, shelf);
    let meta = Meta {
        detail,
        kind: &kind,
        gdl: &gdl,
        source: source.as_ref(),
        overlay: overlay.as_ref(),
    };
    add_meta(&mut archive, &meta);

    if let Some(kit) = shelf {
        // An organization's kit: its material and bundles beside its
        // manifest, at its pinned commit, through the connection its shelf
        // names. A `.cf-studio-kit.toml` names each resource's source.
        let wanted = match source.as_ref() {
            Some(s) if s.file == CF_STUDIO_KIT_TOML => toml_material(&s.body, &detail.kit.slug),
            // Its sources are only in the toml, which could not be read.
            _ if kit.origin.manifest_file == CF_STUDIO_KIT_TOML => Vec::new(),
            _ => kit_dir_wanted(&detail.contents, &kit.origin.path),
        };
        if !wanted.is_empty() {
            fetch_into(
                &mut archive,
                reader,
                org,
                &RepoAt::from(&kit.origin),
                &wanted,
            )
            .await;
        }
    } else if detail.kit.shelf == SHELF_OFFICIAL {
        if let Some(s) = source.as_ref() {
            let wanted = toml_material(&s.body, &detail.kit.slug);
            match super::shelf::github_repository(&detail.kit.repository_url) {
                Some(repository) if !wanted.is_empty() => {
                    let at = RepoAt {
                        connection_id: None,
                        provider: "github".to_owned(),
                        repository,
                        commit: detail.kit.default_version.clone(),
                    };
                    fetch_into(&mut archive, reader, org, &at, &wanted).await;
                }
                Some(_) => {}
                None => archive.notes.push(format!(
                    "The working material was left out: {} is not a GitHub repository Studio reads.",
                    detail.kit.repository_url
                )),
            }
        } else if !detail.contents.material.is_empty() {
            archive.notes.push(
                "The working material was left out: no manifest at the pinned version names its \
                 sources."
                    .to_owned(),
            );
        }
    } else if let Some(local) = local {
        let (root, mfe) = (local.root.clone(), local.mfe.clone());
        match tokio::task::spawn_blocking(move || local_bundles(&root, &mfe)).await {
            Ok((files, notes)) => {
                for (path, bytes) in files {
                    archive.add(&path, bytes);
                }
                archive.notes.extend(notes);
            }
            Err(e) => archive
                .notes
                .push(format!("The bundles could not be read: {e}")),
        }
    }
    let text = readme(&meta, &archive);
    Ok(archive.finish(&text)?)
}

#[cfg(test)]
#[path = "archive_tests.rs"]
mod tests;
