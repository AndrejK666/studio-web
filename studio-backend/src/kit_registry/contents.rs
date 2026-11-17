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
//! - **Organization kits** (ADR-0068 phase 7) are read from the manifest
//!   their shelf keeps ([`super::shelf`], [`super::manifest`]).

use super::service::{KitDescriptor, SHELF_BUILTIN, SHELF_OFFICIAL};

/// `manifest` of a built-in kit: its contents are compiled in.
pub const MANIFEST_BUILTIN: &str = "built-in";
/// `manifest` of a kit described by its installer manifest.
pub const MANIFEST_CF_STUDIO_KIT: &str = ".cf-studio-kit.toml";
/// `manifest` of a kit described by Studio's interim `kit.json` (an
/// organization's own kit, or a built-in kit that brings a model).
pub const MANIFEST_KIT_JSON: &str = "kit.json";
/// `manifest` of a kit described by an authored `kit.gdl` (a bundle kit,
/// `STUDIO_KIT_BUNDLES_DIR`).
pub const MANIFEST_KIT_GDL: &str = "kit.gdl";

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
    /// What it claims of the gears it stands for: types, tools and write
    /// routes (ADR-0071 §2).
    pub gears: Vec<super::manifest::ManifestGearClaim>,
    pub permissions: KitPermissions,
    pub material: Vec<KitMaterial>,
    pub kinds: Vec<String>,
    pub docs: Vec<String>,
    /// The built micro-frontends it carries, `mfe/<package>`.
    pub mfe: Vec<String>,
    /// The kits it cannot work without (ADR-0071 §5).
    pub requires: Vec<String>,
    /// What its model overlay adds beside its own types: fields and
    /// relations on other types, and the tabs the model shows.
    pub model: KitModel,
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
    /// Domain types another kit brings that the screen shows; the shell hides
    /// it where one is not installed.
    pub needs: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KitType {
    pub gts: String,
    pub name: String,
    pub description: Option<String>,
    /// The type's id in the model: `<slug>-<name>`, or the id it declares.
    pub id: String,
    /// Declared by an id Studio's core already has (ADR-0070 §4): an
    /// organization that has the type keeps its definition and its objects,
    /// and one the core left dormant becomes this kit's again.
    pub adopts: bool,
    /// Its fields, relations aside.
    pub fields: Vec<KitField>,
}

/// `origin` of a field or relation the kit declares itself.
pub const ORIGIN_KIT: &str = "kit";
/// `origin` of one that moved out of Studio's core into the kit as the
/// core had it (ADR-0070 phase 5).
pub const ORIGIN_CORE: &str = "core";

/// A field of a kit's model: on one of its types, or on another (`on`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KitField {
    /// The type it is on, by its model id; `None` inside [`KitType::fields`].
    pub on: Option<String>,
    pub name: String,
    pub type_name: String,
    pub description: Option<String>,
    pub required: bool,
    /// [`ORIGIN_KIT`] or [`ORIGIN_CORE`].
    pub origin: &'static str,
}

/// A relation a kit's model declares, between two types by their model ids.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KitRelation {
    pub on: String,
    pub name: String,
    pub target: String,
    pub label: Option<String>,
    /// `references`, `owns`, `member`, `composes`, `derives`...
    pub verb: Option<String>,
    pub origin: &'static str,
}

/// A tab the kit's model shows on a level (a `shows` relation).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KitModelTab {
    /// `organization`, `workspace` or `project`.
    pub level: String,
    pub name: String,
    pub label: String,
    /// The type it lists, by its model id.
    pub target: String,
}

/// What a kit's model adds beside its own types.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KitModel {
    /// Fields it adds to types it does not bring.
    pub fields: Vec<KitField>,
    pub relations: Vec<KitRelation>,
    pub tabs: Vec<KitModelTab>,
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
    /// Which screen and tool answer its items.
    pub destination: Option<super::manifest::ManifestInboxDestination>,
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
            Some(mut contents) => {
                // What its compiled-in `kit.json` adds: a model, Inbox
                // sources, MCP tools, what it claims of the gears, and the
                // routes it calls (`permissions`, only there: ADR-0071 §2).
                if let Some(m) = super::manifest::builtin_manifest(&kit.slug) {
                    let more = super::manifest::contents_of(&m);
                    contents.screens.extend(more.screens);
                    contents.types.extend(more.types);
                    contents.inbox.extend(more.inbox);
                    contents.mcp_tools.extend(more.mcp_tools);
                    contents.gears.extend(more.gears);
                    contents.requires.extend(more.requires);
                    contents.rules.extend(more.rules);
                    contents.functions.extend(more.functions);
                    contents.permissions.reads.extend(more.permissions.reads);
                    contents.permissions.writes.extend(more.permissions.writes);
                    contents
                        .permissions
                        .listens
                        .extend(more.permissions.listens);
                    contents.model.fields.extend(more.model.fields);
                    contents.model.relations.extend(more.model.relations);
                    contents.model.tabs.extend(more.model.tabs);
                }
                (contents, Some(MANIFEST_BUILTIN))
            }
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
        needs: Vec::new(),
    }
}

fn project_tab(label: &str, route: Option<&str>) -> KitScreen {
    tab("project", label, route)
}

/// A built-in kit's screens: what Studio has for it today, nothing planned.
/// `None` for a slug that is not a built-in kit.
///
/// Everything else is in the kit's compiled-in `kit.json`
/// (`builtin/<slug>.kit.json`), one source per kit (ADR-0071 §2): its model,
/// what it claims of the gears (`gears`), and `permissions`. There,
/// `permissions.reads` names the gears' routes the kit's screen calls, as
/// `METHOD /path`, and only routes it calls today; a `POST` that only
/// computes an answer (a plan, a preview, a check, a test of a connection) is
/// a read. `permissions.writes` names the routes that change something, and
/// every route the kit claims.
fn builtin_contents(slug: &str) -> Option<KitContents> {
    let contents = match slug {
        // Project status and phases, which have no screen of their own yet;
        // the project templates a workspace offers (`project-templates-mfe`);
        // and the project's Timeline (`activity-mfe`, section `timeline`),
        // which shows this kit's `milestone`, so it needs no other kit
        // (moved from `project-activity`, ADR-0071 step 4).
        "project-lifecycle" => KitContents {
            screens: vec![
                tab("workspace", "Project templates", Some("/project-templates")),
                project_tab("Timeline", Some("/projects/timeline")),
            ],
            ..KitContents::default()
        },
        // The project's Specs section of `projects-mfe`, and the document types
        // a workspace offers (`document-types-mfe`).
        "project-specs" => KitContents {
            screens: vec![
                tab("workspace", "Document types", Some("/document-types")),
                project_tab("Specs", Some("/projects/specs")),
            ],
            ..KitContents::default()
        },
        // `reports-mfe`: the organization's reports (studio-reports).
        "org-reports" => KitContents {
            screens: vec![tab("organization", "Reports", Some("/reports"))],
            ..KitContents::default()
        },
        // `tests-mfe`: CI runs, the repositories and their open pull
        // requests, document checks and spec-to-code conformance. Its open
        // pull requests section shows project-git's `pull-request` and
        // `needs` it (ADR-0071 §5): without that type the tab shows the CI
        // runs and the conformance and no pull request.
        "project-tests" => KitContents {
            screens: vec![
                project_tab("Tests", Some("/tests")),
                KitScreen {
                    kind: "section",
                    level: "project".to_owned(),
                    label: "Open pull requests".to_owned(),
                    route: Some("/tests".to_owned()),
                    slot: Some("tests".to_owned()),
                    needs: vec![super::manifest::domain_type_gts("pull-request")],
                },
            ],
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
                needs: Vec::new(),
            }],
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
                needs: Vec::new(),
            }],
            ..KitContents::default()
        },
        // `components-mfe` (ADR-0042, ADR-0046): the platform's catalogue,
        // its gear repositories and the publication requests it answers;
        // and the organization's catalogue and registry. A project's
        // inventory (Components) is product-releases' since ADR-0071 step 4.
        // The routes are the ones the old prototype's screens call
        // (`components-catalog`, `component-registry`,
        // `catalogue-levels-view`, `platform-sources`,
        // `publication-requests`).
        "components" => KitContents {
            screens: vec![
                tab("platform", "Components", Some("/platform/components")),
                tab("platform", "Repositories", Some("/platform/repositories")),
                tab(
                    "platform",
                    "Publication requests",
                    Some("/platform/publication-requests"),
                ),
                tab("organization", "Components", Some("/components")),
            ],
            ..KitContents::default()
        },
        // From a build to a running environment (ADR-0071 §6, step 5:
        // org-infrastructure and product-releases' Releases, merged).
        // `infrastructure-mfe` (ADR-0056 §2): the places an organization
        // holds, the environments on them, their namespaces, registries and
        // image retention, and the deploys waiting on a decision; and
        // `releases-mfe`: a project's builds, images, its own environments
        // and deploys up the ladder.
        "delivery" => KitContents {
            screens: vec![
                tab("organization", "Infrastructure", Some("/infrastructure")),
                project_tab("Releases", Some("/releases")),
            ],
            ..KitContents::default()
        },
        // What a project's product is made of (ADR-0071 §6, step 5: Product
        // out of product-releases): `product-mfe`'s Product — its map,
        // configurator, frontend and description — and the project's
        // Components, its inventory (ADR-0043, ADR-0045, ADR-0056).
        "project-product" => KitContents {
            screens: vec![
                project_tab("Product", Some("/product")),
                project_tab("Components", Some("/project-components")),
            ],
            ..KitContents::default()
        },
        // Building and running a product in Constructor Research (ADR-0049,
        // docs/design/studio-kits.md §3.13). Not a base kit by default
        // (`OPT_IN_BUILTIN`); installed for an organization or one project.
        // Its screen is Organization › Constructor Research, an entry
        // of `infrastructure-mfe`; a project's build, deploy and rollback to
        // Research stay on its Releases tab (delivery, which it requires), and
        // studio-environments refuses them with `KIT_NOT_INSTALLED` where
        // this kit is not installed. Where it applies, the project's path
        // answers `research_kit` and the one "Deploy to…" dialog of
        // delivery's Releases lists the caller's Research projects as a target
        // (#1053); without it the target is absent.
        "constructor-research" => KitContents {
            // Its Inbox sources, MCP tools and the routes behind the sources
            // are in its compiled-in kit.json
            // (`builtin/constructor-research.kit.json`).
            screens: vec![tab(
                "organization",
                "Constructor Research",
                Some("/constructor-research"),
            )],
            ..KitContents::default()
        },
        // `assistant-mfe`: Studio AI, docked in the shell's sidebar beside
        // whatever screen is open (the old prototype's `studio-ai.tsx`). No
        // route: it is not a tab. It answers through studio-llm-proxy on the
        // person's own key (a workspace's AI connections count inside a
        // workspace); a chat completion only computes an answer, so it is a
        // read. Its model, tool and message types come with ADR-0070 phase 8.
        "assistant" => KitContents {
            screens: vec![KitScreen {
                kind: "section",
                level: "organization".to_owned(),
                label: "Studio AI".to_owned(),
                route: None,
                slot: Some("sidebar".to_owned()),
                needs: Vec::new(),
            }],
            ..KitContents::default()
        },
        // `project-git`, Git collaboration (ADR-0071 §6, step 5): work on a
        // Git host — pull requests (`repository.hosts`), tracker issues
        // (`work-item`, from project-issues) and the discussion on both
        // (`comment`) — and the project's Activity (`activity-mfe`, from
        // project-activity). The model comes from its `kit.json`.
        "project-git" => KitContents {
            screens: vec![project_tab("Activity", Some("/projects/activity"))],
            ..KitContents::default()
        },
        // The Project model (ADR-0066, ADR-0067; not the Studio domain model):
        // the model a project's documents make, the glossary, traces to work
        // (`domain-model-mfe`; the routes are the ones the old prototype's
        // `spec-model-tab` called, under their new path). Its open questions (`issues-mfe`, the prototype's Issues tab, at
        // `/issues`) moved here from `project-issues` with `finding`: they
        // are what the project's documents leave to decide (ADR-0071 step 4,
        // open question 2: the tab is "Open questions").
        "project-domain-model" => KitContents {
            screens: vec![
                project_tab("Project domain model", Some("/domain-model")),
                project_tab("Open questions", Some("/issues")),
            ],
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
    read_manifest(official_manifest_text(kit)?, &kit.slug)
}

/// The copy of an official kit's `.cf-studio-kit.toml`, as written, when the
/// catalogue offers it from that repository at that commit.
pub fn official_manifest_text(kit: &KitDescriptor) -> Option<&'static str> {
    MANIFEST_COPIES
        .iter()
        .find(|copy| {
            copy.slug == kit.slug
                && copy.commit == kit.default_version
                && same_repository(copy.repository_url, &kit.repository_url)
        })
        .map(|copy| copy.body)
}

/// The material and artifact kinds of kit `slug` in a `.cf-studio-kit.toml`
/// (a single- or multi-kit manifest), read line by line as the catalogue
/// reads its kits (`components_catalog::repo_enrich::manifest_kits`). `None`
/// when the manifest has no such kit.
///
/// A resource is material at its `install_path`; the kinds are the keys of
/// `[kits.resources.artifacts.<KIND>]`, in the manifest's order.
pub(super) fn read_manifest(body: &str, slug: &str) -> Option<KitContents> {
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
