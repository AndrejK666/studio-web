//! One component's page, in one answer (`GET /components/{name}`): what it
//! is, what it provides, what it needs, who stands for it, and where its
//! passport and documents are.
//!
//! Everything here is read, none of it guessed. The pieces were scattered:
//! the node (a crate, a FrontX package, a `service.gdl`), the scan's facts on
//! its profile (`profile.auto`: capabilities, dependencies, screens, the
//! calls an MFE makes), the reference's join with the Gearbox engine
//! (extension points, hosts, plugins), the organization's registry (where a
//! project declares it), the built-in kits' claims (ADR-0071) and the MCP
//! tools a Studio gear serves. `/component-values` flattens the scan's lists
//! into "a, b" strings for a table; this keeps them lists.
//!
//! ── The type ─────────────────────────────────────────────────────────────────
//!
//! One word a person reads first, out of the evidence the catalogue holds
//! ([`component_type`]):
//!
//! | type | decided by |
//! |---|---|
//! | `kit` | a kit node, or the taxonomy's `kit` |
//! | `infra` | a `service.gdl` that says `kind = "infra"` |
//! | `service` | any other `service.gdl`: an own service, its own image |
//! | `plugin` | the taxonomy's `plugin` (engine role, `is_plugin`, `implements`) |
//! | `gear` | the taxonomy's `gear` or `planned`, or a registry `gear` |
//! | `mfe` | the taxonomy's `micro-frontend` (`frontx.gdl` `mfe(...)`, federation) |
//! | `library` | an SDK, a crate library, a FrontX library or shell |
//! | `other` | a tool, or nothing that decides |
//!
//! A FrontX shell is filed as a library here: it is a package the product
//! mounts screens in, not a screen.

use serde_json::Value;

use super::reference::{
    ComponentReferenceDto, ReferenceEngineGearDto, ReferenceExtensionPointDto,
    ReferenceReadinessDto,
};
use super::registry::RegistryEntry;

// ── wire shapes ──────────────────────────────────────────────────────────────

/// A file in a repository: its path and, when the repository is known, a
/// link a browser opens.
#[derive(Debug, Clone, PartialEq, Eq)]
#[toolkit_macros::api_dto(response)]
pub struct ComponentFileDto {
    /// What it is: `gear.gdl`, `frontx.gdl`, `service.gdl`, `README.md`, …
    pub label: String,
    /// Repository-relative.
    pub path: String,
    pub url: Option<String>,
}

/// One screen an MFE puts in the shell, as its `mfe.json` declares it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[toolkit_macros::api_dto(response)]
pub struct ComponentScreenDto {
    pub id: String,
    pub label: Option<String>,
    pub route: Option<String>,
    /// `platform`, `organization`, `project`, … when declared.
    pub level: Option<String>,
    /// `screen`, `sidebar`, … — the shell domain it extends.
    pub domain: Option<String>,
}

/// An MCP tool a gear serves.
#[derive(Debug, Clone, PartialEq, Eq)]
#[toolkit_macros::api_dto(response)]
pub struct ComponentToolDto {
    pub name: String,
    pub description: String,
    /// `read`, `write` or `destructive`.
    pub effect: String,
}

/// What one built-in kit claims of the component (ADR-0071 §2).
#[derive(Debug, Clone, PartialEq, Eq)]
#[toolkit_macros::api_dto(response)]
pub struct ComponentKitClaimDto {
    pub kit: String,
    pub kit_name: String,
    /// The gear the claim is on, as the kit names it.
    pub gear: String,
    pub types: Vec<String>,
    pub mcp_tools: Vec<String>,
    /// `METHOD /path` write routes.
    pub routes: Vec<String>,
}

/// What the component gives a product.
#[derive(Debug, Clone, PartialEq, Eq)]
#[toolkit_macros::api_dto(response)]
pub struct ComponentProvidesDto {
    /// Capability keys its passport declares (`gear.gdl`, `service.gdl`
    /// `provides`, the registry's).
    pub capabilities: Vec<String>,
    /// For a plugin: the extension point spec it fills.
    pub implements: Option<String>,
    /// For a plugin: the gears that declare that point (engine ids).
    pub hosts: Vec<String>,
    /// For a host: the points it declares.
    pub extension_points: Vec<ReferenceExtensionPointDto>,
    /// For a host: the plugins that fill its points (engine ids).
    pub plugins: Vec<String>,
    /// Whether contract files (OpenAPI) were found beside its code; null
    /// when the scan did not look.
    pub openapi: Option<bool>,
    /// Whether it has an events module; null when the scan did not look.
    pub events: Option<bool>,
    /// The MCP tools a Studio gear serves.
    pub mcp_tools: Vec<ComponentToolDto>,
    /// GTS types its code registers.
    pub types: Vec<String>,
    /// For an MFE: the screens its `mfe.json` puts in the shell.
    pub screens: Vec<ComponentScreenDto>,
    /// For a service: `name: port`.
    pub ports: Vec<String>,
    pub health: Option<String>,
    /// For an infra service: the variables a gear's configuration reads
    /// from it (`oidc.issuer`, …).
    pub variables: Vec<String>,
}

/// What the component takes from elsewhere.
#[derive(Debug, Clone, PartialEq, Eq)]
#[toolkit_macros::api_dto(response)]
pub struct ComponentNeedsDto {
    /// Other catalogued crates or packages its manifests depend on.
    pub components: Vec<String>,
    /// Gears or services it calls or requires: an MFE's calls, a service's
    /// `requires`, the engine's co-located dependencies.
    pub services: Vec<String>,
    /// Database engines its manifests name.
    pub databases: Vec<String>,
    /// What the runtime gives it (`db`, `rest`, …), as the engine projects it.
    pub runtime: Vec<String>,
    /// What it is connected to at start: a service's `env` (`KEY ← source`)
    /// and the secrets an infra service is given.
    pub connections: Vec<String>,
}

/// Who uses the component, beyond the projects the registry lists.
#[derive(Debug, Clone, PartialEq, Eq)]
#[toolkit_macros::api_dto(response)]
pub struct ComponentUsedByDto {
    /// Catalogued components whose manifests depend on it.
    pub components: Vec<String>,
    /// The built-in kits that claim its types, tools or write routes.
    pub kits: Vec<ComponentKitClaimDto>,
}

/// One component, as its page reads it.
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(response)]
pub struct ComponentDetailDto {
    /// The catalogue name (or the registry's, for a component only a project
    /// declares).
    pub name: String,
    pub title: Option<String>,
    /// `gear`, `plugin`, `mfe`, `service`, `infra`, `library`, `kit` or
    /// `other` (see the module's table).
    pub component_type: String,
    /// The evidence that decided `component_type`.
    pub type_reason: String,
    /// The taxonomy's kind, when the catalogue has the component.
    pub kind: Option<String>,
    pub description: Option<String>,
    pub category: Option<String>,
    /// `platform`, `organization` or `project`.
    pub tier: Option<String>,
    pub version: Option<String>,
    /// The repository's web address.
    pub repository: Option<String>,
    /// Its directory in the repository.
    pub path: Option<String>,
    /// The file that describes it: `gear.gdl`, `gear.toml`, `frontx.gdl`,
    /// `service.gdl`, `kit.gdl`. Null when none was read.
    pub passport: Option<ComponentFileDto>,
    pub docs: Vec<ComponentFileDto>,
    pub provides: ComponentProvidesDto,
    pub needs: ComponentNeedsDto,
    pub used_by: ComponentUsedByDto,
    /// `gear.gdl` `maturity` (`preview`, `stable`, …).
    pub maturity: Option<String>,
    pub readiness: Option<ReferenceReadinessDto>,
    /// Every engine gear the component is.
    pub engine: Vec<ReferenceEngineGearDto>,
}

// ── reading ──────────────────────────────────────────────────────────────────

/// What the page is built from. Every part optional except the name: a
/// component only a project declares has no node, one only the engine knows
/// has no profile.
#[derive(Default)]
pub struct DetailInputs<'a> {
    pub name: &'a str,
    /// `(type_id, value)` of the catalogue node.
    pub node: Option<(&'a str, &'a Value)>,
    /// The profile, with the scan's facts under `auto`.
    pub profile: Option<&'a Value>,
    pub reference: Option<&'a ComponentReferenceDto>,
    pub registry: Option<&'a RegistryEntry>,
    pub claims: Vec<ComponentKitClaimDto>,
    pub tools: Vec<ComponentToolDto>,
}

const SERVICE_TYPE: &str = super::gts::SERVICE_TYPE;
const KIT_TYPE: &str = super::gts::KIT_TYPE;

fn str_of(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_owned()),
        // A field answer: the full value.
        Value::Object(o) => o
            .get("v")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
        _ => None,
    }
}

/// A list however it was stored: an array, a comma-separated string, or a
/// field answer whose `v` is one.
fn list_of(v: Option<&Value>) -> Vec<String> {
    let mut out: Vec<String> = match v {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|i| i.as_str().map(str::trim).map(str::to_owned))
            .collect(),
        Some(other) => str_of(Some(other))
            .map(|s| s.split(',').map(|p| p.trim().to_owned()).collect())
            .unwrap_or_default(),
        None => Vec::new(),
    };
    out.retain(|s| !s.is_empty());
    dedup(out)
}

fn dedup(items: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for i in items {
        if !out.contains(&i) {
            out.push(i);
        }
    }
    out
}

/// A yes/no field answer; null when it was not recorded.
fn yes_no(v: Option<&Value>) -> Option<bool> {
    match v? {
        Value::Bool(b) => Some(*b),
        other => match str_of(Some(other))?.as_str() {
            "yes" | "true" => Some(true),
            "no" | "false" => Some(false),
            _ => None,
        },
    }
}

/// The type a person reads first, and why (see the module's table).
pub fn component_type(
    type_id: Option<&str>,
    node: Option<&Value>,
    kind: Option<&str>,
    registry_kind: Option<&str>,
) -> (&'static str, String) {
    if type_id == Some(SERVICE_TYPE) {
        let infra = node
            .and_then(|n| n.get("service_kind"))
            .and_then(Value::as_str)
            == Some("infra");
        return if infra {
            (
                "infra",
                "its service.gdl says kind = \"infra\": a third-party service run beside the gears"
                    .to_owned(),
            )
        } else {
            (
                "service",
                "described by a service.gdl: a service with its own image".to_owned(),
            )
        };
    }
    if type_id == Some(KIT_TYPE) || kind == Some("kit") {
        return ("kit", "a Studio kit".to_owned());
    }
    let by_kind = match kind {
        Some("plugin") => Some(("plugin", "the catalogue files it as a plugin")),
        Some("gear") => Some(("gear", "the catalogue files it as a gear")),
        Some("planned") => Some(("gear", "a gear on the roadmap that no repository has yet")),
        Some("micro-frontend") => {
            Some(("mfe", "the catalogue files it as a FrontX micro-frontend"))
        }
        Some("sdk") => Some(("library", "the SDK crate of a gear")),
        Some("library") => Some(("library", "a crate other crates build on")),
        Some("frontend-library") => Some(("library", "a FrontX package other packages import")),
        Some("tool") => Some(("other", "a command-line tool")),
        _ => None,
    };
    if let Some((t, why)) = by_kind {
        return (t, why.to_owned());
    }
    match registry_kind {
        Some("gear") => ("gear", "a project declares it as a gear".to_owned()),
        Some("plugin") => ("plugin", "a project declares it as a plugin".to_owned()),
        Some("kit") => ("kit", "a project declares it as a kit".to_owned()),
        Some("frontx") => (
            "other",
            "a FrontX package a project declares; no catalogue read says whether it is a screen or a library".to_owned(),
        ),
        _ => ("other", "nothing the catalogue holds says what it is".to_owned()),
    }
}

/// `https://github.com/<repo>/blob/<ref>/<path>`, for a GitHub repository.
fn blob_url(repository: Option<&str>, git_ref: &str, path: &str) -> Option<String> {
    let repo = repository?.trim_end_matches('/');
    repo.starts_with("https://github.com/")
        .then(|| format!("{repo}/blob/{git_ref}/{path}"))
}

fn file(label: &str, path: String, repository: Option<&str>, git_ref: &str) -> ComponentFileDto {
    ComponentFileDto {
        label: label.to_owned(),
        url: blob_url(repository, git_ref, &path),
        path,
    }
}

fn join_path(dir: Option<&str>, name: &str) -> String {
    match dir.map(|d| d.trim_matches('/')).filter(|d| !d.is_empty()) {
        Some(d) => format!("{d}/{name}"),
        None => name.to_owned(),
    }
}

/// Build the page out of what the catalogue holds.
#[allow(clippy::too_many_lines)]
pub fn build(i: DetailInputs<'_>) -> ComponentDetailDto {
    let (type_id, node) = match i.node {
        Some((t, v)) => (Some(t), Some(v)),
        None => (None, None),
    };
    let auto = i.profile.and_then(|p| p.get("auto"));
    let fact = |key: &str| {
        auto.and_then(|a| a.get(key))
            .or_else(|| node.and_then(|n| n.get(key)))
    };
    let entry = i.registry.map(|r| &r.entry);
    let occurrence = i.registry.and_then(|r| r.occurrences.first());

    let kind = i.reference.map(|r| r.kind.clone()).or_else(|| {
        node.and_then(|n| n.get("kind"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    });
    let (component_type, type_reason) = component_type(
        type_id.or(i.reference.and_then(|r| r.type_id.as_deref())),
        node,
        kind.as_deref(),
        entry.map(|e| e.kind.as_str()),
    );
    let type_reason = match i
        .reference
        .map(|r| r.kind_reason.as_str())
        .filter(|r| !r.is_empty())
    {
        Some(evidence) if component_type != "service" && component_type != "infra" => {
            format!("{type_reason} ({evidence})")
        }
        _ => type_reason,
    };

    // Where it lives.
    let synced_from = str_of(node.and_then(|n| n.get("synced_from")));
    let repository = i
        .reference
        .and_then(|r| r.repository.clone())
        .or_else(|| str_of(node.and_then(|n| n.get("repository"))))
        .or_else(|| {
            synced_from
                .as_ref()
                .map(|r| format!("https://github.com/{r}"))
        })
        .or_else(|| occurrence.map(|o| format!("https://github.com/{}", o.repo)));
    // A scan's repository is where the files are; crates.io's `repository`
    // may be a monorepo's root, which is the same thing for a GitHub link.
    let files_repo = synced_from
        .as_ref()
        .map(|r| format!("https://github.com/{r}"))
        .or_else(|| occurrence.map(|o| format!("https://github.com/{}", o.repo)))
        .or_else(|| repository.clone());
    let git_ref = str_of(node.and_then(|n| n.get("git_ref")))
        .or_else(|| occurrence.and_then(|o| o.git_ref.clone()))
        .unwrap_or_else(|| "HEAD".to_owned());
    let dir = i
        .reference
        .and_then(|r| r.repo_path.clone())
        .or_else(|| str_of(node.and_then(|n| n.get("repo_path"))))
        .or_else(|| str_of(auto.and_then(|a| a.get("path"))))
        .or_else(|| occurrence.map(|o| o.path.clone()));

    // The passport: the file the catalogue read it from.
    let passport = if let Some(p) = str_of(node.and_then(|n| n.get("passport_path"))) {
        let label = p.rsplit('/').next().unwrap_or(&p).to_owned();
        Some(file(&label, p, files_repo.as_deref(), &git_ref))
    } else if let Some(manifest) = str_of(fact("manifest")) {
        Some(file(
            &manifest,
            join_path(dir.as_deref(), &manifest),
            files_repo.as_deref(),
            &git_ref,
        ))
    } else if yes_no(fact("frontx_described")) == Some(true) {
        Some(file(
            "frontx.gdl",
            join_path(dir.as_deref(), "frontx.gdl"),
            files_repo.as_deref(),
            &git_ref,
        ))
    } else if let Some(o) =
        occurrence.filter(|o| matches!(o.declared_in.as_str(), "gear.gdl" | "gear.toml" | "kit"))
    {
        let label = o
            .declared_file
            .rsplit('/')
            .next()
            .unwrap_or(&o.declared_file)
            .to_owned();
        Some(file(
            &label,
            o.declared_file.clone(),
            files_repo.as_deref(),
            &git_ref,
        ))
    } else {
        i.reference
            .and_then(|r| r.engine.iter().find_map(|g| g.gdl_path.clone()))
            .map(|p| ComponentFileDto {
                label: "gear.gdl".to_owned(),
                path: p,
                url: None,
            })
    };
    let docs: Vec<ComponentFileDto> = list_of(fact("docs"))
        .into_iter()
        .map(|p| {
            let label = p.rsplit('/').next().unwrap_or(&p).to_owned();
            file(&label, p, files_repo.as_deref(), &git_ref)
        })
        .collect();

    // What it provides.
    let engine: Vec<ReferenceEngineGearDto> =
        i.reference.map(|r| r.engine.clone()).unwrap_or_default();
    let mut capabilities = list_of(fact("capabilities"));
    if let Some(e) = entry {
        capabilities.extend(e.capabilities.iter().cloned());
    }
    // A service's `provides` is a list; an infra service's is a dict of
    // variables, kept apart.
    capabilities.extend(list_of(node.and_then(|n| n.get("provides"))));
    let variables: Vec<String> = node
        .and_then(|n| n.pointer("/infra/provides"))
        .and_then(Value::as_object)
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    let implements =
        str_of(fact("implements")).or_else(|| engine.iter().find_map(|g| g.fills.clone()));
    let hosts = dedup(
        engine
            .iter()
            .flat_map(|g| g.hosts.iter().cloned())
            .collect(),
    );
    let plugins = dedup(
        engine
            .iter()
            .flat_map(|g| g.plugins.iter().cloned())
            .collect(),
    );
    let mut extension_points: Vec<ReferenceExtensionPointDto> = Vec::new();
    for p in engine.iter().flat_map(|g| g.extension_points.iter()) {
        if !extension_points.iter().any(|x| x.spec == p.spec) {
            extension_points.push(p.clone());
        }
    }
    for spec in list_of(fact("extpoint_specs")) {
        if !extension_points.iter().any(|x| x.spec == spec) {
            extension_points.push(ReferenceExtensionPointDto {
                spec,
                interface: None,
                sdk_crate: None,
            });
        }
    }
    let screens: Vec<ComponentScreenDto> = fact("mfe_extensions")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|e| {
                    Some(ComponentScreenDto {
                        id: e.get("id")?.as_str()?.to_owned(),
                        label: str_of(e.get("label")),
                        route: str_of(e.get("route")),
                        level: str_of(e.get("level")),
                        domain: str_of(e.get("domain")),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let ports: Vec<String> = node
        .and_then(|n| n.get("ports"))
        .and_then(Value::as_object)
        .map(|o| o.iter().map(|(k, v)| format!("{k}: {v}")).collect())
        .unwrap_or_default();
    let types = list_of(fact("gtstypes"));

    // What it needs.
    let mut services = list_of(fact("mfe_calls"));
    services.extend(list_of(node.and_then(|n| n.get("requires"))));
    services.extend(engine.iter().flat_map(|g| g.colocated_deps.iter().cloned()));
    let runtime = dedup(
        engine
            .iter()
            .flat_map(|g| g.runtime_caps.iter().cloned())
            .collect(),
    );
    let mut connections: Vec<String> = node
        .and_then(|n| n.get("env"))
        .and_then(Value::as_object)
        .map(|o| {
            o.iter()
                .map(|(k, v)| match v.as_str() {
                    Some(from) if !from.is_empty() => format!("{k} ← {from}"),
                    _ => k.clone(),
                })
                .collect()
        })
        .unwrap_or_default();
    connections.extend(list_of(node.and_then(|n| n.pointer("/infra/secrets"))));

    let title = i
        .reference
        .and_then(|r| r.title.clone())
        .or_else(|| str_of(node.and_then(|n| n.get("title"))))
        .filter(|t| t != i.name);
    let description = i
        .reference
        .and_then(|r| r.description.clone())
        .or_else(|| str_of(node.and_then(|n| n.get("description"))))
        .or_else(|| entry.and_then(|e| e.description.clone()));
    let version = i
        .reference
        .and_then(|r| r.version.clone())
        .or_else(|| str_of(node.and_then(|n| n.get("version"))))
        .or_else(|| str_of(fact("version")))
        .or_else(|| entry.and_then(|e| e.version.clone()));

    ComponentDetailDto {
        name: i.name.to_owned(),
        title,
        component_type: component_type.to_owned(),
        type_reason,
        kind,
        description,
        category: i
            .reference
            .and_then(|r| r.category.clone())
            .or_else(|| entry.and_then(|e| e.category.clone())),
        tier: i
            .reference
            .and_then(|r| r.tier.clone())
            .or_else(|| str_of(node.and_then(|n| n.get("tier")))),
        version,
        repository,
        path: dir,
        passport,
        docs,
        provides: ComponentProvidesDto {
            capabilities: dedup(capabilities),
            implements,
            hosts,
            extension_points,
            plugins,
            openapi: yes_no(fact("openapi")),
            events: yes_no(fact("events")),
            mcp_tools: i.tools,
            types,
            screens,
            ports,
            health: str_of(node.and_then(|n| n.get("health"))),
            variables,
        },
        needs: ComponentNeedsDto {
            components: list_of(fact("deps_names")),
            services: dedup(services),
            databases: list_of(fact("dbs")),
            runtime,
            connections,
        },
        used_by: ComponentUsedByDto {
            components: list_of(fact("consumers_names")),
            kits: i.claims,
        },
        maturity: str_of(fact("maturity")),
        readiness: i.reference.and_then(|r| r.readiness.clone()),
        engine,
    }
}

#[cfg(test)]
#[path = "component_detail_tests.rs"]
mod tests;
