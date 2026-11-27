//! Document-type detection for files that arrived from somewhere else.
//!
//! A document created in Studio knows its type — you picked it from the
//! catalogue. A file pulled out of an existing repository does not, so before
//! it can be validated against a template something has to decide *which*
//! template. That decision is made here, cheaply and offline, in two steps:
//!
//! 1. **Declared** — the file's front matter names its type (`type: prd`).
//!    Whoever wrote it already answered the question; take the answer.
//!    Next to it, **declared by convention**: the file sits where a known spec
//!    layout keeps one kind of document (OpenSpec's
//!    `openspec/specs/<capability>/spec.md` is a living spec). The layout's
//!    authors answered the question for every repository that follows it, so
//!    nobody edits a file to say so — specs are read as written. See
//!    [`CONVENTIONS`].
//! 2. **Inferred** — score every candidate type on four independent signals
//!    (which required sections the file actually contains, what its path is
//!    called, what its title says, which front-matter keys it fills) and take
//!    the winner if it is both good enough and clearly ahead of the runner-up.
//!
//! Anything that does not clear those bars comes back as *undetermined* with
//! its candidates attached, which is the honest answer: a person picks. The
//! third step — asking the external Spec Quality `purpose` detector — is driven
//! by the caller on exactly that leftover set, and its verdict is recorded
//! through [`super::model::DetectionSource::SpecQuality`].
//!
//! Scoring is deliberately derived from the type's own definition (its key,
//! name, sections and rules) rather than a hard-coded table of filenames, so a
//! workspace-defined type is detected on the same terms as a built-in one.

use std::collections::BTreeSet;

use super::model::{DetectionSource, DocumentType, TypeCandidate};
use super::validate::{headings, normalize_heading, split_front_matter};

/// Extensions that can hold a specification document. Everything else (source,
/// images, lockfiles, build output) is not prose and is never classified.
const DOC_EXT: &[&str] = &["md", "markdown", "txt", "rst", "adoc", "asciidoc"];

/// Front-matter keys that may declare a document's type outright.
const TYPE_KEYS: &[&str] = &["type", "doc_type", "document_type", "kind"];

/// Words that carry no signal about which type a document is.
const STOPWORDS: &[&str] = &["the", "a", "an", "of", "and", "or", "for", "to", "v1"];

/// A score below this is never proposed — the file simply does not look enough
/// like any known type.
const ACCEPT: f32 = 0.45;

/// How far ahead of the runner-up the winner must be. Two types that score the
/// same are ambiguous, and guessing between them is worse than asking.
const MARGIN: f32 = 0.08;

/// What the classifier concluded about one file.
#[derive(Clone, Debug, PartialEq)]
pub struct Classification {
    /// The proposed type, or `None` when nothing cleared [`ACCEPT`]/[`MARGIN`].
    pub type_key: Option<String>,
    /// Confidence in the proposal, 0.0–1.0.
    pub confidence: f32,
    /// How the proposal was reached (meaningless when `type_key` is `None`).
    pub source: DetectionSource,
    /// Every type that scored at all, best first — what a person chooses from
    /// when the proposal is absent or wrong.
    pub candidates: Vec<TypeCandidate>,
    /// False when the path is not prose at all (a `.png`, a `.rs`).
    pub is_prose: bool,
    /// True when a spec layout says the file is writing but not a spec — a
    /// plan, or history (see [`ConventionVerdict::NotASpec`]). `type_key` is
    /// `None` then, and the binding is `not_a_document` rather than
    /// `unknown`: nobody needs to look at it.
    pub not_a_spec: bool,
}

/// Where a repository keeps instructions for its tools rather than its own
/// documents: a kit's templates and examples, an agent's skills and prompts,
/// CI workflows. Prose by extension, never a specification of the project.
///
/// On Insight these were a third of "Needs review" (2026-10-05): 47 files
/// under `.cf-studio/`, 43 under `.claude/`, and a kit's ADR example bound
/// as one of the project's decisions.
///
/// A directory counts at any depth, not only at the root: a monorepo keeps an
/// agent's setup beside the package it works on (`UI/.cursor/`,
/// `UI/.cypilot/`), and it is no more the project's writing there.
const TOOLING_DIRS: &[&str] = &[
    ".cf-studio",
    ".claude",
    ".github",
    // Agent and editor setup: rules, prompts, skills, a kit's copy.
    ".cypilot",
    ".cursor",
    ".windsurf",
    ".agents",
    ".drover",
];

/// Files at the repository root that brief an agent, not a reader.
const TOOLING_FILES: &[&str] = &["claude.md", "agents.md"];

/// True when `path` is tool configuration (see [`TOOLING_DIRS`]).
fn is_tooling_path(path: &str) -> bool {
    let segments: Vec<&str> = path.split(['/', '\\']).filter(|s| !s.is_empty()).collect();
    let Some((file, dirs)) = segments.split_last() else {
        return false;
    };
    if dirs.is_empty() {
        return TOOLING_FILES.contains(&file.to_ascii_lowercase().as_str());
    }
    dirs.iter()
        .any(|d| TOOLING_DIRS.contains(&d.to_ascii_lowercase().as_str()))
}

/// Confidence of a type a spec layout declares: high enough for a project's
/// pipeline to confirm it at the default threshold (0.8), and short of the
/// 1.0 a file's own declaration earns.
pub const CONVENTION_CONFIDENCE: f32 = 0.9;

/// What a spec layout says a file in one of its places is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConventionVerdict {
    /// A document of this catalogue type.
    Type(&'static str),
    /// Writing, but not a spec: a plan of work, or history kept for the
    /// record. Known, so nobody is asked about it, and never counted.
    NotASpec,
}

/// One place a spec layout keeps one kind of file.
#[derive(Clone, Copy, Debug)]
pub struct ConventionRule {
    /// The layout's own directory, matched at any depth (`openspec`,
    /// `UI/openspec`), ignoring case.
    pub root: &'static str,
    /// The path under `root`, one entry per segment: `*` is any one segment,
    /// `**` any number of them (none included), anything else is that name,
    /// ignoring case.
    pub pattern: &'static [&'static str],
    pub verdict: ConventionVerdict,
    /// Why, in words, for the person reading the binding.
    pub why: &'static str,
}

/// Spec layouts recognized by where a file sits. Data, not code: another
/// layout is another few rows. The first rule that matches wins, so a
/// narrower rule goes above a wider one.
///
/// OpenSpec: `specs/` holds the living specs, one capability per directory;
/// `changes/<id>/` a change in flight — its proposal, its design and its task
/// list — and `changes/archive/` the changes already applied.
///
/// A proposal is bound as `prd`: the catalogue has no change-proposal type,
/// and a proposal (why, what changes, impact) is the requirements side of a
/// change, which is what a PRD holds.
pub const CONVENTIONS: &[ConventionRule] = &[
    ConventionRule {
        root: "openspec",
        pattern: &["changes", "archive", "**"],
        verdict: ConventionVerdict::NotASpec,
        why: "OpenSpec archive: a change already applied, kept as history",
    },
    ConventionRule {
        root: "openspec",
        pattern: &["specs", "**", "spec.md"],
        verdict: ConventionVerdict::Type("feature"),
        why: "OpenSpec layout: a living spec (openspec/specs/<capability>/spec.md)",
    },
    ConventionRule {
        root: "openspec",
        pattern: &["changes", "*", "proposal.md"],
        verdict: ConventionVerdict::Type("prd"),
        why: "OpenSpec layout: a change proposal (openspec/changes/<id>/proposal.md)",
    },
    ConventionRule {
        root: "openspec",
        pattern: &["changes", "*", "design.md"],
        verdict: ConventionVerdict::Type("design"),
        why: "OpenSpec layout: a change's design (openspec/changes/<id>/design.md)",
    },
    ConventionRule {
        root: "openspec",
        pattern: &["changes", "*", "tasks.md"],
        verdict: ConventionVerdict::NotASpec,
        why: "OpenSpec layout: a change's task list, a plan rather than a spec",
    },
];

/// Whether `segments` match `pattern` (see [`ConventionRule::pattern`]).
fn glob_segments(pattern: &[&str], segments: &[&str]) -> bool {
    match pattern.split_first() {
        None => segments.is_empty(),
        Some((&"**", rest)) => {
            (0..=segments.len()).any(|skip| glob_segments(rest, &segments[skip..]))
        }
        Some((head, rest)) => match segments.split_first() {
            Some((seg, tail)) => {
                (*head == "*" || seg.eq_ignore_ascii_case(head)) && glob_segments(rest, tail)
            }
            None => false,
        },
    }
}

/// The first rule of [`CONVENTIONS`] that `path` follows, if any.
pub fn convention_for(path: &str) -> Option<&'static ConventionRule> {
    let segments: Vec<&str> = path.split(['/', '\\']).filter(|s| !s.is_empty()).collect();
    CONVENTIONS.iter().find(|rule| {
        segments
            .iter()
            .enumerate()
            .filter(|(_, s)| s.eq_ignore_ascii_case(rule.root))
            .any(|(i, _)| glob_segments(rule.pattern, &segments[i + 1..]))
    })
}

/// Directories inside a kit that hold its scaffolding: the artifact
/// templates a kit generates documents from, and the examples it shows.
const KIT_SCAFFOLDING_DIRS: &[&str] = &["artifacts", "templates", "examples"];

/// True when `path` is a kit's own scaffolding rather than the project's
/// writing: anything under `kits/<kit>/artifacts/`, `kits/<kit>/**/templates/`
/// or `kits/<kit>/**/examples/`, and any `template.md` inside a kit.
///
/// [`TOOLING_DIRS`] catches a kit vendored under `.cf-studio/`; this catches
/// the same kit wherever else a repository keeps it (`kits/` at the root,
/// `docs/kits/`, a monorepo package). A kit's example ADR declares its type
/// and fills every section, so the classifier bound it as one of the
/// project's decisions and a person had to reject each one by hand.
pub fn is_kit_scaffolding(path: &str) -> bool {
    let segments: Vec<String> = path
        .split(['/', '\\'])
        .filter(|s| !s.is_empty())
        .map(str::to_ascii_lowercase)
        .collect();
    let Some(kits) = segments.iter().position(|s| s == "kits") else {
        return false;
    };
    // `kits/<kit>/.../<file>`: the kit's name, then at least the file.
    let inside = &segments[kits + 1..];
    let Some((file, dirs)) = inside.split_last() else {
        return false;
    };
    if dirs.is_empty() {
        return false;
    }
    file == "template.md"
        || dirs[1..]
            .iter()
            .any(|d| KIT_SCAFFOLDING_DIRS.contains(&d.as_str()))
}

/// True when a path looks like it could hold a specification document: prose
/// by its extension, and neither tool configuration nor a kit's scaffolding.
pub fn is_prose_path(path: &str) -> bool {
    if is_tooling_path(path) || is_kit_scaffolding(path) {
        return false;
    }
    let ext = path
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    // A path with no dot after the last separator has no extension at all.
    let has_ext = path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .contains('.');
    has_ext && DOC_EXT.contains(&ext.as_str())
}

/// Lowercase alphanumeric words, with the noise words dropped.
fn tokens(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| t.len() > 1)
        .map(|t| t.to_ascii_lowercase())
        .filter(|t| !STOPWORDS.contains(&t.as_str()))
        .collect()
}

/// Normalize a declared type value (`"Product Requirements"`, `"PRD"`) the same
/// way a type key is written, so the two can be compared.
fn normalize_declared(value: &str) -> String {
    value
        .trim()
        .trim_matches(['"', '\''])
        .to_ascii_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join("_")
}

/// The type a file declares in its front matter, when it names a known one.
fn declared_type(content: &str, types: &[DocumentType]) -> Option<String> {
    let (fm, _) = split_front_matter(content);
    for key in TYPE_KEYS {
        let Some(raw) = fm.get(*key) else { continue };
        let declared = normalize_declared(raw);
        if declared.is_empty() {
            continue;
        }
        // A declaration may name the key (`prd`) or the display name
        // (`Product Requirements (PRD)`); accept either.
        if let Some(t) = types
            .iter()
            .find(|t| t.key == declared || normalize_declared(&t.name) == declared)
        {
            return Some(t.key.clone());
        }
    }
    None
}

/// Fraction of `ty`'s required section headings the document actually has.
fn section_score(ty: &DocumentType, body: &str) -> Option<(f32, usize, usize)> {
    let required: Vec<_> = ty.template.sections.iter().filter(|s| s.required).collect();
    if required.is_empty() {
        return None;
    }
    let present: BTreeSet<String> = headings(body).into_iter().map(|h| h.title_norm).collect();
    let hits = required
        .iter()
        .filter(|s| s.titles().any(|t| present.contains(&normalize_heading(t))))
        .count();
    Some((hits as f32 / required.len() as f32, hits, required.len()))
}

/// How much the path looks like this type: a full key match is decisive, a
/// partial name match is a hint.
fn path_score(ty: &DocumentType, path: &str) -> f32 {
    let path_toks: BTreeSet<String> = tokens(path).into_iter().collect();
    if path_toks.is_empty() {
        return 0.0;
    }
    let key_toks = tokens(&ty.key);
    if !key_toks.is_empty() && key_toks.iter().all(|t| path_toks.contains(t)) {
        return 1.0;
    }
    let name_toks = tokens(&ty.name);
    if name_toks.is_empty() {
        return 0.0;
    }
    let hits = name_toks.iter().filter(|t| path_toks.contains(*t)).count();
    hits as f32 / name_toks.len() as f32
}

/// Whether the document's own title names the type ("# ADR — …").
fn title_score(ty: &DocumentType, body: &str) -> f32 {
    let Some(title) = headings(body).into_iter().find(|h| h.level == 1) else {
        return 0.0;
    };
    let title_toks: BTreeSet<String> = tokens(&title.title_norm).into_iter().collect();
    if title_toks.is_empty() {
        return 0.0;
    }
    let key_toks = tokens(&ty.key);
    if !key_toks.is_empty() && key_toks.iter().all(|t| title_toks.contains(t)) {
        return 1.0;
    }
    let name_toks = tokens(&ty.name);
    if name_toks.is_empty() {
        return 0.0;
    }
    let hits = name_toks.iter().filter(|t| title_toks.contains(*t)).count();
    hits as f32 / name_toks.len() as f32
}

/// Fraction of the type's required front-matter keys the document fills.
/// `None` when the type requires none — that signal then carries no weight.
fn front_matter_score(ty: &DocumentType, content: &str) -> Option<f32> {
    let want = &ty.template.rules.front_matter;
    if want.is_empty() {
        return None;
    }
    let (fm, _) = split_front_matter(content);
    let hits = want
        .iter()
        .filter(|k| {
            fm.get(&k.trim().to_lowercase())
                .is_some_and(|v| !v.trim().is_empty())
        })
        .count();
    Some(hits as f32 / want.len() as f32)
}

/// Score one type against one document, and say in words why.
fn score(ty: &DocumentType, path: &str, content: &str) -> (f32, String) {
    let (_, body) = split_front_matter(content);

    // Sections are the strongest signal — they are what the template actually
    // asks for. Front matter is the weakest, and types that require none give
    // their weight back to the sections rather than letting it vanish.
    let (sections, why_sections) = match section_score(ty, body) {
        Some((s, hits, total)) => (s, format!("{hits}/{total} required sections")),
        None => (0.0, "no required sections".to_string()),
    };
    let path_s = path_score(ty, path);
    let title_s = title_score(ty, body);
    let fm = front_matter_score(ty, content);

    let (w_sections, w_fm) = match fm {
        Some(_) => (0.55, 0.10),
        None => (0.65, 0.0),
    };
    let total =
        w_sections * sections + 0.20 * path_s + 0.15 * title_s + w_fm * fm.unwrap_or_default();

    let mut why = vec![why_sections];
    if path_s > 0.0 {
        why.push("path matches".to_string());
    }
    if title_s > 0.0 {
        why.push("title matches".to_string());
    }
    if fm.is_some_and(|f| f > 0.0) {
        why.push("front matter matches".to_string());
    }
    (total, why.join(", "))
}

/// Decide which type a file is, given the effective type catalogue.
pub fn classify(path: &str, content: &str, types: &[DocumentType]) -> Classification {
    if !is_prose_path(path) {
        return Classification {
            type_key: None,
            confidence: 0.0,
            source: DetectionSource::Heuristic,
            candidates: Vec::new(),
            is_prose: false,
            not_a_spec: false,
        };
    }

    // A declared type is an answer, not a guess — no scoring needed.
    if let Some(key) = declared_type(content, types) {
        return Classification {
            type_key: Some(key.clone()),
            confidence: 1.0,
            source: DetectionSource::FrontMatter,
            candidates: vec![TypeCandidate {
                type_key: key,
                confidence: 1.0,
                why: "declared in front matter".to_string(),
            }],
            is_prose: true,
            not_a_spec: false,
        };
    }

    // A layout's declaration is the next best thing: the file sits where the
    // layout keeps one kind of document. A type the catalogue lacks (a
    // workspace that removed it) falls through to scoring.
    if let Some(rule) = convention_for(path) {
        match rule.verdict {
            ConventionVerdict::NotASpec => {
                return Classification {
                    type_key: None,
                    confidence: 0.0,
                    source: DetectionSource::Heuristic,
                    candidates: Vec::new(),
                    is_prose: true,
                    not_a_spec: true,
                };
            }
            ConventionVerdict::Type(key) if types.iter().any(|t| t.key == key) => {
                return Classification {
                    type_key: Some(key.to_string()),
                    confidence: CONVENTION_CONFIDENCE,
                    // Recorded as `heuristic`: the stored source is a closed
                    // set (a CHECK on the legacy bindings table), and a layout
                    // rule is our reading of the path, not the file speaking
                    // for itself. The candidate's `why` names the rule.
                    source: DetectionSource::Heuristic,
                    candidates: vec![TypeCandidate {
                        type_key: key.to_string(),
                        confidence: CONVENTION_CONFIDENCE,
                        why: rule.why.to_string(),
                    }],
                    is_prose: true,
                    not_a_spec: false,
                };
            }
            ConventionVerdict::Type(_) => {}
        }
    }

    let mut candidates: Vec<TypeCandidate> = types
        .iter()
        .map(|ty| {
            let (confidence, why) = score(ty, path, content);
            TypeCandidate {
                type_key: ty.key.clone(),
                confidence,
                why,
            }
        })
        .filter(|c| c.confidence > 0.0)
        .collect();
    // Best first; ties broken by key so the order is stable across runs.
    candidates.sort_by(|a, b| {
        b.confidence
            .total_cmp(&a.confidence)
            .then_with(|| a.type_key.cmp(&b.type_key))
    });
    candidates.truncate(3);

    let best = candidates.first();
    let runner_up = candidates.get(1).map(|c| c.confidence).unwrap_or(0.0);
    let winner = best.filter(|b| b.confidence >= ACCEPT && b.confidence - runner_up >= MARGIN);

    Classification {
        type_key: winner.map(|c| c.type_key.clone()),
        confidence: winner.map(|c| c.confidence).unwrap_or(0.0),
        source: DetectionSource::Heuristic,
        candidates,
        is_prose: true,
        not_a_spec: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::documents::model::builtin_types;

    /// A document that fills every required section of a built-in type.
    fn filled(headings: &[&str]) -> String {
        let mut out = String::from("---\nstatus: draft\nowner: alice\n---\n\n# Some Title\n\n");
        for h in headings {
            out.push_str(&format!("## {h}\n\nSome real prose here.\n\n"));
        }
        out
    }

    #[test]
    fn non_prose_paths_are_not_classified() {
        let types = builtin_types();
        for path in ["src/main.rs", "logo.png", "Cargo.lock", "Makefile"] {
            let c = classify(path, "# whatever", &types);
            assert!(!c.is_prose, "{path} should not be prose");
            assert_eq!(c.type_key, None);
        }
    }

    /// A kit's example ADR is a perfect ADR, and still not one of the
    /// project's decisions.
    #[test]
    fn tool_configuration_is_not_a_document_however_well_it_reads() {
        let types = builtin_types();
        let adr = format!(
            "---\ntype: adr\n---\n\n# ADR — x\n\n{}",
            filled(&["Status", "Context", "Decision", "Consequences"])
        );
        for path in [
            ".cf-studio/config/kits/sdlc/artifacts/ADR/examples/example.md",
            ".claude/skills/review/SKILL.md",
            ".github/PULL_REQUEST_TEMPLATE.md",
            "CLAUDE.md",
            "AGENTS.md",
        ] {
            assert!(!is_prose_path(path), "{path} is tooling");
            let c = classify(path, &adr, &types);
            assert!(!c.is_prose, "{path} should not be classified");
            assert_eq!(c.type_key, None);
        }
        // Only those directories, and the agent briefs only at the root.
        for path in [
            "docs/CLAUDE.md",
            "docs/.claude-notes.md",
            "docs/github/setup.md",
            "README.md",
        ] {
            assert!(is_prose_path(path), "{path} is a document path");
        }
    }

    /// The same kit outside `.cf-studio/` is still scaffolding, and a
    /// project's own `docs/templates/` or `examples/` outside a kit is not.
    #[test]
    fn a_kits_templates_and_examples_are_not_documents_wherever_it_lives() {
        for path in [
            "kits/sdlc/artifacts/ADR/template.md",
            "kits/sdlc/artifacts/ADR/examples/example.md",
            "kits/sdlc/artifacts/PRD/rules.md",
            "docs/kits/sdlc/templates/feature.md",
            "packages/x/kits/acme/guides/examples/one.md",
            "kits\\sdlc\\artifacts\\ADR\\template.md",
            "Kits/SDLC/Artifacts/ADR/Template.md",
            "kits/sdlc/template.md",
        ] {
            assert!(is_kit_scaffolding(path), "{path} is kit scaffolding");
            assert!(!is_prose_path(path), "{path} is not a document path");
        }
        for path in [
            "docs/templates/feature.md",
            "examples/usage.md",
            "docs/adr/template.md",
            "kits/README.md",
            "kits/sdlc/README.md",
            "kits/sdlc/guides/overview.md",
            "docs/toolkits/artifacts/a.md",
        ] {
            assert!(!is_kit_scaffolding(path), "{path} is not kit scaffolding");
            assert!(is_prose_path(path), "{path} is a document path");
        }
    }

    #[test]
    fn front_matter_declaration_wins_outright() {
        let types = builtin_types();
        // The path and every section say "adr"; the declaration says otherwise
        // and is taken at its word.
        let content = "---\ntype: design\nstatus: draft\n---\n\n# ADR — something\n\n## Context\n\n## Decision\n";
        let c = classify("docs/adr/0001-thing.md", content, &types);
        assert_eq!(c.type_key.as_deref(), Some("design"));
        assert_eq!(c.source, DetectionSource::FrontMatter);
        assert_eq!(c.confidence, 1.0);
    }

    #[test]
    fn declaration_may_name_the_display_name() {
        let types = builtin_types();
        let content = "---\ndoc_type: Architecture Decision Record\n---\n\n# Whatever\n";
        let c = classify("notes.md", content, &types);
        assert_eq!(c.type_key.as_deref(), Some("adr"));
    }

    #[test]
    fn an_unknown_declaration_falls_through_to_scoring() {
        let types = builtin_types();
        let content = format!(
            "---\ntype: not_a_real_type\nstatus: draft\n---\n\n# ADR — x\n\n{}",
            filled(&["Status", "Context", "Decision", "Consequences"])
        );
        let c = classify("docs/adr/0001-x.md", &content, &types);
        assert_eq!(c.source, DetectionSource::Heuristic);
        assert_eq!(c.type_key.as_deref(), Some("adr"));
    }

    #[test]
    fn a_real_adr_is_detected_by_its_sections_and_path() {
        let types = builtin_types();
        let content = filled(&["Status", "Context", "Decision", "Consequences"]);
        let c = classify("docs/adr/0007-shell-tokens.md", &content, &types);
        assert_eq!(c.type_key.as_deref(), Some("adr"));
        assert!(c.confidence >= ACCEPT, "confidence {}", c.confidence);
    }

    #[test]
    fn a_real_prd_is_detected_from_its_sections_alone() {
        let types = builtin_types();
        // Deliberately an unhelpful filename: only the sections identify it.
        // Numbered the way the SDLC template numbers them.
        let content = filled(&[
            "1. Overview",
            "2. Actors",
            "4. Scope",
            "5. Functional Requirements",
            "6. Non-Functional Requirements",
            "9. Acceptance Criteria",
            "11. Assumptions",
            "12. Risks",
        ]);
        let c = classify("docs/notes-2026.md", &content, &types);
        assert_eq!(c.type_key.as_deref(), Some("prd"));
    }

    /// The older shape -- Problem / Goals / Success Metrics, which the component
    /// skeleton still writes -- is still a PRD, through the section aliases.
    #[test]
    fn a_prd_in_the_older_shape_is_still_detected() {
        let types = builtin_types();
        let content = filled(&[
            "Problem",
            "Goals",
            "Non-Goals",
            "Users & Use Cases",
            "Requirements",
            "Success Metrics",
        ]);
        let c = classify("docs/notes-2026.md", &content, &types);
        assert_eq!(c.type_key.as_deref(), Some("prd"));
    }

    /// A file written straight from a built-in template is recognized as that
    /// type on its headings alone — including DECOMPOSITION and FEATURE,
    /// whose headings overlap the PRD's.
    #[test]
    fn every_builtin_template_is_classified_as_itself() {
        let types = builtin_types();
        for ty in &types {
            let c = classify("docs/spec.md", &ty.template.body, &types);
            assert_eq!(
                c.type_key.as_deref(),
                Some(ty.key.as_str()),
                "candidates: {:?}",
                c.candidates
            );
        }
    }

    #[test]
    fn prose_that_matches_nothing_is_left_undetermined() {
        let types = builtin_types();
        let content = "# Release notes\n\nWe shipped some things this week.\n";
        let c = classify("CHANGELOG.md", content, &types);
        assert!(c.is_prose);
        assert_eq!(c.type_key, None, "candidates: {:?}", c.candidates);
    }

    #[test]
    fn candidates_are_returned_even_when_nothing_is_proposed() {
        let types = builtin_types();
        // Two sections shared between several types, nothing decisive.
        let content = filled(&["Overview", "Context"]);
        let c = classify("docs/thing.md", &content, &types);
        assert_eq!(c.type_key, None);
        assert!(!c.candidates.is_empty());
        assert!(c.candidates.len() <= 3);
        // Sorted best first.
        for w in c.candidates.windows(2) {
            assert!(w[0].confidence >= w[1].confidence);
        }
    }

    #[test]
    fn a_workspace_defined_type_is_detected_on_the_same_terms() {
        use crate::documents::model::{Owner, Rules, Section, TemplateSpec};

        let custom = DocumentType {
            key: "runbook".to_string(),
            name: "Operational Runbook".to_string(),
            description: String::new(),
            gts_type_id: "gts.cf.studio.doc.runbook.v1~".to_string(),
            owner: Owner::Workspace {
                tenant_id: uuid::Uuid::nil(),
            },
            template: TemplateSpec {
                body: String::new(),
                sections: vec![
                    Section {
                        key: "symptoms".into(),
                        title: "Symptoms".into(),
                        required: true,
                        min_words: None,
                        description: None,
                        aliases: Vec::new(),
                    },
                    Section {
                        key: "diagnosis".into(),
                        title: "Diagnosis".into(),
                        required: true,
                        min_words: None,
                        description: None,
                        aliases: Vec::new(),
                    },
                    Section {
                        key: "recovery".into(),
                        title: "Recovery".into(),
                        required: true,
                        min_words: None,
                        description: None,
                        aliases: Vec::new(),
                    },
                ],
                rules: Rules::default(),
                questionnaire: Vec::new(),
                review: None,
            },
            hidden: false,
        };
        let mut types = builtin_types();
        types.push(custom);

        let content = filled(&["Symptoms", "Diagnosis", "Recovery"]);
        let c = classify("ops/runbook-postgres.md", &content, &types);
        assert_eq!(c.type_key.as_deref(), Some("runbook"));
    }

    /// An OpenSpec file as people write it: no front matter, OpenSpec's own
    /// headings, nothing of the catalogue's templates.
    const OPENSPEC_TEXT: &str = "# Login\n\n## Requirements\n\n### Requirement: Sign in\n\nThe system SHALL let a user sign in.\n";

    #[test]
    fn an_openspec_living_spec_is_a_feature_by_where_it_sits() {
        let types = builtin_types();
        let c = classify("openspec/specs/login/spec.md", OPENSPEC_TEXT, &types);
        assert_eq!(c.type_key.as_deref(), Some("feature"));
        assert_eq!(c.confidence, CONVENTION_CONFIDENCE);
        assert_eq!(c.source, DetectionSource::Heuristic);
        assert!(!c.not_a_spec);
        assert!(
            c.candidates[0].why.contains("OpenSpec"),
            "{:?}",
            c.candidates
        );
        // High enough for a project's pipeline at its default threshold.
        assert!(c.confidence >= crate::documents::pipeline::DEFAULT_THRESHOLD);
    }

    #[test]
    fn an_openspec_change_has_a_proposal_a_design_and_a_plan() {
        let types = builtin_types();
        let proposal = classify(
            "openspec/changes/add-2fa/proposal.md",
            OPENSPEC_TEXT,
            &types,
        );
        assert_eq!(proposal.type_key.as_deref(), Some("prd"));
        assert_eq!(proposal.confidence, CONVENTION_CONFIDENCE);

        let design = classify("openspec/changes/add-2fa/design.md", OPENSPEC_TEXT, &types);
        assert_eq!(design.type_key.as_deref(), Some("design"));

        let tasks = classify(
            "openspec/changes/add-2fa/tasks.md",
            "- [ ] 1.1 Do it\n",
            &types,
        );
        assert!(tasks.is_prose);
        assert!(tasks.not_a_spec);
        assert_eq!(tasks.type_key, None);
    }

    /// The archive is history: every file in it, proposal and spec alike,
    /// is known and never counted.
    #[test]
    fn the_openspec_archive_is_history_not_current_specs() {
        let types = builtin_types();
        for path in [
            "openspec/changes/archive/2025-01-01-add-2fa/proposal.md",
            "openspec/changes/archive/2025-01-01-add-2fa/design.md",
            "openspec/changes/archive/2025-01-01-add-2fa/specs/login/spec.md",
            "openspec/changes/archive/README.md",
        ] {
            let c = classify(path, OPENSPEC_TEXT, &types);
            assert!(c.not_a_spec, "{path} is history");
            assert_eq!(c.type_key, None, "{path}");
        }
    }

    #[test]
    fn an_openspec_directory_counts_at_any_depth() {
        let types = builtin_types();
        for (path, want) in [
            ("UI/openspec/specs/login/spec.md", Some("feature")),
            ("UI/openspec/changes/add-2fa/proposal.md", Some("prd")),
            ("packages/web/OpenSpec/changes/x/design.md", Some("design")),
            ("UI\\openspec\\specs\\login\\spec.md", Some("feature")),
        ] {
            let c = classify(path, OPENSPEC_TEXT, &types);
            assert_eq!(c.type_key.as_deref(), want, "{path}");
        }
        assert!(
            classify(
                "UI/openspec/changes/archive/a/proposal.md",
                OPENSPEC_TEXT,
                &types
            )
            .not_a_spec
        );
        assert!(classify("UI/openspec/changes/x/tasks.md", OPENSPEC_TEXT, &types).not_a_spec);
    }

    /// Only the layout's own places: a `spec.md` elsewhere, or a file the
    /// layout does not name, is read on the usual terms.
    #[test]
    fn files_outside_the_layouts_places_are_scored_as_usual() {
        for path in [
            "docs/specs/login/spec.md",
            "openspec/project.md",
            "openspec/AGENTS.md",
            "openspec/changes/add-2fa/notes.md",
            "openspec/changes/add-2fa/specs/login/spec.md",
            "openspec/specs/login/notes.md",
            "not-openspec/specs/login/spec.md",
        ] {
            assert!(
                convention_for(path).is_none(),
                "{path} is not a layout place"
            );
        }
        let types = builtin_types();
        let c = classify("openspec/project.md", OPENSPEC_TEXT, &types);
        assert!(!c.not_a_spec);
        assert_ne!(c.confidence, CONVENTION_CONFIDENCE);
    }

    /// The file's own word still wins over where it sits.
    #[test]
    fn front_matter_outranks_the_layout() {
        let types = builtin_types();
        let content = format!("---\ntype: adr\n---\n\n{OPENSPEC_TEXT}");
        let c = classify("openspec/changes/x/design.md", &content, &types);
        assert_eq!(c.type_key.as_deref(), Some("adr"));
        assert_eq!(c.source, DetectionSource::FrontMatter);
    }

    /// A layout naming a type the workspace's catalogue lacks proposes
    /// nothing it cannot validate; scoring has its usual turn.
    #[test]
    fn a_layout_type_missing_from_the_catalogue_falls_through() {
        let types: Vec<DocumentType> = builtin_types()
            .into_iter()
            .filter(|t| t.key != "feature")
            .collect();
        let c = classify("openspec/specs/login/spec.md", OPENSPEC_TEXT, &types);
        assert_ne!(c.type_key.as_deref(), Some("feature"));
        assert!(!c.not_a_spec);
    }

    #[test]
    fn agent_and_editor_setup_is_tooling_at_any_depth() {
        for path in [
            ".cypilot/config/rules.md",
            ".cursor/rules/style.md",
            ".windsurf/rules.md",
            ".agents/skills/review/SKILL.md",
            ".drover/plan.md",
            "UI/.cypilot/kits/sdlc/README.md",
            "UI/.cursor/rules/style.md",
            "UI/.claude/commands/x.md",
            "packages/web/.github/PULL_REQUEST_TEMPLATE.md",
            "UI\\.windsurf\\rules.md",
            "/.cursor/rules.md",
        ] {
            assert!(is_tooling_path(path), "{path} is tooling");
            assert!(!is_prose_path(path), "{path} is not a document path");
        }
        for path in [
            "docs/cursor.md",
            "docs/.cursor-notes.md",
            "UI/README.md",
            "UI/CLAUDE.md",
            "agents/overview.md",
        ] {
            assert!(!is_tooling_path(path), "{path} is not tooling");
            assert!(is_prose_path(path), "{path} is a document path");
        }
    }
}
