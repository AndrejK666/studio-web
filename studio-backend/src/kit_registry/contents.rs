//! What a kit brings, shown before anyone installs it (ADR-0068 §2, §4, §8).
//!
//! Organised by the sections of the kit manifest (`kit.gdl`, ADR-0068 §3):
//! screens, types, rules, functions, services, inbox sources, MCP tools,
//! permissions, and the working material `cfs` writes into a checkout.
//!
//! Where it comes from, per shelf:
//!
//! - **Built-in kits** are compiled into Studio, so their contents are
//!   declared here, beside [`super::service::builtin_catalogue`], and say only
//!   what Studio has today.
//! - **Official kits** are read from a copy of their `.cf-studio-kit.toml` at
//!   the commit [`super::service::official_catalogue`] pins (`manifests/`). A
//!   request never fetches anything. A deployment that pins another commit
//!   (`STUDIO_KIT_CATALOGUE`) or another repository gets empty contents and no
//!   manifest rather than a description of a version it does not install.
//! - **Organization kits** (ADR-0068 phase 7) are not read yet: empty.

use super::service::{KitDescriptor, SHELF_BUILTIN, SHELF_OFFICIAL};

/// `manifest` of a built-in kit: its contents are compiled in.
pub const MANIFEST_BUILTIN: &str = "built-in";
/// `manifest` of a kit described by its installer manifest.
pub const MANIFEST_CF_STUDIO_KIT: &str = ".cf-studio-kit.toml";

/// One kit of the library and what it brings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KitDetail {
    pub kit: KitDescriptor,
    pub contents: KitContents,
    /// Where `contents` came from: [`MANIFEST_BUILTIN`],
    /// [`MANIFEST_CF_STUDIO_KIT`], `kit.gdl`, or `None` when nothing reliable
    /// describes the kit (and `contents` is empty).
    pub manifest: Option<&'static str>,
}

/// What a kit brings, by the sections of its manifest. Every list may be
/// empty.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KitContents {
    pub screens: Vec<KitScreen>,
    pub types: Vec<KitType>,
    pub rules: Vec<KitNamed>,
    pub functions: Vec<KitFunction>,
    pub services: Vec<KitNamed>,
    pub inbox: Vec<KitInboxSource>,
    pub mcp_tools: Vec<KitNamed>,
    pub permissions: KitPermissions,
    pub material: Vec<KitMaterial>,
    pub kinds: Vec<String>,
    pub docs: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KitScreen {
    /// `tab` (on a level's tab bar) or `section` (inside another screen).
    pub kind: &'static str,
    pub level: String,
    pub label: String,
    /// The portal route, when the screen exists in the portal today.
    pub route: Option<String>,
    /// For a section: the slot it goes in.
    pub slot: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KitType {
    pub gts: String,
    pub name: String,
    pub description: Option<String>,
}

/// A rule, a service or an MCP tool: a name and what it is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KitNamed {
    pub name: String,
    pub description: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KitFunction {
    pub name: String,
    /// `wasm` or `agent`.
    pub runtime: &'static str,
    pub description: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KitInboxSource {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KitPermissions {
    pub reads: Vec<String>,
    pub writes: Vec<String>,
    pub listens: Vec<String>,
}

/// A file or directory `cfs` writes into a project's checkout.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KitMaterial {
    /// Relative to the kit's directory in the checkout
    /// (`<cf-studio-path>/config/kits/<slug>/`); a directory ends in `/`.
    pub path: String,
    pub description: Option<String>,
}

/// Kit `slug` of `library`, with what it brings; `None` when the library does
/// not hold it.
pub fn find(library: Vec<KitDescriptor>, slug: &str) -> Option<KitDetail> {
    let slug = super::service::normalize_slug(slug).ok()?;
    library
        .into_iter()
        .find(|kit| kit.slug == slug)
        .map(describe)
}

/// One kit of the library with what it brings.
pub fn describe(kit: KitDescriptor) -> KitDetail {
    let (contents, manifest) = match kit.shelf.as_str() {
        SHELF_BUILTIN => match builtin_contents(&kit.slug) {
            Some(contents) => (contents, Some(MANIFEST_BUILTIN)),
            None => (KitContents::default(), None),
        },
        SHELF_OFFICIAL => match official_contents(&kit) {
            Some(contents) => (contents, Some(MANIFEST_CF_STUDIO_KIT)),
            None => (KitContents::default(), None),
        },
        _ => (KitContents::default(), None),
    };
    KitDetail {
        kit,
        contents,
        manifest,
    }
}

fn tab(level: &str, label: &str, route: Option<&str>) -> KitScreen {
    KitScreen {
        kind: "tab",
        level: level.to_owned(),
        label: label.to_owned(),
        route: route.map(str::to_owned),
        slot: None,
    }
}

fn project_tab(label: &str, route: Option<&str>) -> KitScreen {
    tab("project", label, route)
}

fn owned(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

/// A built-in kit's contents: what Studio has for it today, nothing planned.
/// `None` for a slug that is not a built-in kit.
///
/// `permissions.reads` names the gears' routes the kit's screen calls, as
/// `METHOD /path`, and only routes it calls today.
fn builtin_contents(slug: &str) -> Option<KitContents> {
    let contents = match slug {
        // Project status and phases, which have no screen of their own yet;
        // and the project templates a workspace offers (`project-templates-mfe`).
        "project-lifecycle" => KitContents {
            screens: vec![tab(
                "workspace",
                "Project templates",
                Some("/project-templates"),
            )],
            permissions: KitPermissions {
                reads: owned(&["GET /studio-organizations/v1/project-types"]),
                ..KitPermissions::default()
            },
            ..KitContents::default()
        },
        // The project's Specs section of `projects-mfe`, and the document types
        // a workspace offers (`document-types-mfe`).
        "project-specs" => KitContents {
            screens: vec![
                tab("workspace", "Document types", Some("/document-types")),
                project_tab("Specs", Some("/projects/specs")),
            ],
            permissions: KitPermissions {
                reads: owned(&[
                    "GET /studio-documents/v1/workspaces/{workspace_id}/types",
                    "GET /studio-documents/v1/spec-rows",
                    "GET /studio-spec-quality/v1/status",
                ]),
                ..KitPermissions::default()
            },
            ..KitContents::default()
        },
        // `reports-mfe`: the organization's reports (studio-reports).
        "org-reports" => KitContents {
            screens: vec![tab("organization", "Reports", Some("/reports"))],
            permissions: KitPermissions {
                reads: owned(&[
                    "GET /studio-reports/v1/reports",
                    "GET /studio-reports/v1/reports/{report_id}",
                ]),
                ..KitPermissions::default()
            },
            ..KitContents::default()
        },
        // The Issues tab: what a project has to decide before it builds from
        // its documents, computed by studio-documents.
        "project-issues" => KitContents {
            screens: vec![project_tab("Issues", Some("/issues"))],
            permissions: KitPermissions {
                reads: owned(&[
                    "GET /studio-documents/v1/spec-model/issues",
                    "GET /studio-documents/v1/spec-model/readiness",
                    "GET /studio-documents/v1/spec-model",
                ]),
                writes: owned(&[
                    "POST /studio-documents/v1/spec-model/reviews",
                    "POST /studio-documents/v1/spec-model/findings/{fingerprint}/decision",
                    "POST /studio-documents/v1/spec-model/issues",
                ]),
                ..KitPermissions::default()
            },
            ..KitContents::default()
        },
        // `tests-mfe`: CI runs, the repositories and their open pull
        // requests, document checks and spec-to-code conformance.
        "project-tests" => KitContents {
            screens: vec![project_tab("Tests", Some("/tests"))],
            permissions: KitPermissions {
                reads: owned(&[
                    "GET /studio-artifact-ingest/v1/runs",
                    "GET /studio-artifact-ingest/v1/nodes",
                    "GET /studio-artifact-ingest/v1/open-pull-requests",
                    "POST /studio-documents/v1/pull-request-checks",
                    "GET /studio-documents/v1/workspaces/{workspace_id}/capabilities",
                    "GET /studio-spec-mapping/v1/capabilities",
                    "POST /studio-spec-mapping/v1/conformance",
                ]),
                ..KitPermissions::default()
            },
            ..KitContents::default()
        },
        // A section of `projects-mfe` today: the project's ingested
        // artifacts.
        "project-artifacts" => KitContents {
            screens: vec![project_tab("Artifacts", Some("/projects/artifacts"))],
            permissions: KitPermissions {
                reads: owned(&["GET /studio-artifact-ingest/v1/nodes"]),
                ..KitPermissions::default()
            },
            ..KitContents::default()
        },
        // A section of `projects-mfe` today, which reads nothing yet.
        "project-activity" => KitContents {
            screens: vec![project_tab("Activity", Some("/projects/activity"))],
            ..KitContents::default()
        },
        // `costs-mfe`: the organization's costs, its price list and budgets
        // (studio-usage).
        "org-costs" => KitContents {
            screens: vec![KitScreen {
                kind: "tab",
                level: "organization".to_owned(),
                label: "Costs".to_owned(),
                route: Some("/costs".to_owned()),
                slot: None,
            }],
            permissions: KitPermissions {
                reads: owned(&[
                    "GET /studio-usage/v1/costs",
                    "GET /studio-usage/v1/prices",
                    "GET /studio-usage/v1/budgets",
                    "GET /studio-usage/v1/budget-status",
                ]),
                ..KitPermissions::default()
            },
            ..KitContents::default()
        },
        // `api-docs-mfe`, opened from the product menu: the gateway's
        // OpenAPI document, grouped by the gear that serves each route.
        "studio-api-docs" => KitContents {
            screens: vec![KitScreen {
                kind: "section",
                level: "platform".to_owned(),
                label: "Docs & API".to_owned(),
                route: Some("/api-docs".to_owned()),
                slot: Some("product-menu".to_owned()),
            }],
            permissions: KitPermissions {
                reads: owned(&["GET /openapi.json"]),
                ..KitPermissions::default()
            },
            ..KitContents::default()
        },
        _ => return None,
    };
    Some(contents)
}

/// An official kit's installer manifest as it is at a pinned commit.
struct ManifestCopy {
    slug: &'static str,
    repository_url: &'static str,
    commit: &'static str,
    body: &'static str,
}

/// The copies in `manifests/`, one per official kit, at the commits
/// [`super::service::official_catalogue`] pins.
const MANIFEST_COPIES: &[ManifestCopy] = &[
    ManifestCopy {
        slug: "sdlc",
        repository_url: "https://github.com/constructorfabric/studio-kit-sdlc",
        commit: "5c5b85c870cb4b62ed0506ae1a8ca196156d1c74",
        body: include_str!("manifests/sdlc.cf-studio-kit.toml"),
    },
    ManifestCopy {
        slug: "compete",
        repository_url: "https://github.com/constructorfabric/studio-kits-pm",
        commit: "fbd2f5c43fd1f34d2c12767f2d57f6ac107f2b48",
        body: include_str!("manifests/compete.cf-studio-kit.toml"),
    },
];

fn same_repository(left: &str, right: &str) -> bool {
    let norm = |url: &str| {
        url.trim()
            .trim_end_matches('/')
            .trim_end_matches(".git")
            .to_ascii_lowercase()
    };
    norm(left) == norm(right)
}

/// What an official kit brings, from the copy of its manifest -- only when
/// the catalogue offers it from that repository at that commit.
fn official_contents(kit: &KitDescriptor) -> Option<KitContents> {
    let copy = MANIFEST_COPIES.iter().find(|copy| {
        copy.slug == kit.slug
            && copy.commit == kit.default_version
            && same_repository(copy.repository_url, &kit.repository_url)
    })?;
    read_manifest(copy.body, copy.slug)
}

/// The material and artifact kinds of kit `slug` in a `.cf-studio-kit.toml`
/// (a single- or multi-kit manifest), read line by line as the catalogue
/// reads its kits (`components_catalog::repo_enrich::manifest_kits`). `None`
/// when the manifest has no such kit.
///
/// A resource is material at its `install_path`; the kinds are the keys of
/// `[kits.resources.artifacts.<KIND>]`, in the manifest's order.
fn read_manifest(body: &str, slug: &str) -> Option<KitContents> {
    #[derive(PartialEq)]
    enum At {
        Elsewhere,
        Kit,
        Resource,
    }
    let mut at = At::Elsewhere;
    let mut current_slug: Option<String> = None;
    let mut found = false;
    let mut contents = KitContents::default();
    // install_path, description, is a directory
    let mut resource: Option<(Option<String>, Option<String>, bool)> = None;
    let flush = |resource: &mut Option<(Option<String>, Option<String>, bool)>,
                 ours: bool,
                 contents: &mut KitContents| {
        if let Some((Some(path), description, directory)) = resource.take()
            && ours
        {
            let path = if directory && !path.ends_with('/') {
                format!("{path}/")
            } else {
                path
            };
            contents.material.push(KitMaterial { path, description });
        }
    };
    for raw in body.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let ours = current_slug.as_deref() == Some(slug);
        if line.starts_with('[') {
            flush(&mut resource, ours, &mut contents);
            at = At::Elsewhere;
            if line == "[[kits]]" {
                current_slug = None;
                at = At::Kit;
            } else if line == "[[kits.resources]]" {
                resource = Some((None, None, false));
                at = At::Resource;
            } else if let Some(kind) = line
                .strip_prefix("[kits.resources.artifacts.")
                .and_then(|rest| rest.strip_suffix(']'))
            {
                let kind = kind.trim().trim_matches('"').to_owned();
                if ours && !kind.is_empty() && !contents.kinds.contains(&kind) {
                    contents.kinds.push(kind);
                }
            }
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        let string = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .map(str::to_owned);
        match at {
            At::Kit if key == "slug" => {
                current_slug = string;
                found |= current_slug.as_deref() == Some(slug);
            }
            At::Resource => {
                if let Some((path, description, directory)) = resource.as_mut() {
                    match key {
                        "install_path" => *path = string,
                        "description" => *description = string,
                        "type" => *directory = string.as_deref() == Some("directory"),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    let ours = current_slug.as_deref() == Some(slug);
    flush(&mut resource, ours, &mut contents);
    found.then_some(contents)
}

#[cfg(test)]
#[path = "contents_tests.rs"]
mod tests;
