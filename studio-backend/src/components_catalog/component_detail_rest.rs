//! `GET /components/{name}`: one component's page in one answer
//! (`super::component_detail`), for the portal's component page.

use super::*;
use crate::components_catalog::component_detail::{
    ComponentDetailDto, ComponentKitClaimDto, ComponentToolDto, DetailInputs, build,
};

/// Whether `wanted` names `name`, case-blind.
fn same(name: &str, wanted: &str) -> bool {
    name.trim().eq_ignore_ascii_case(wanted)
}

/// The kits' claims and the MCP tools of every gear the component goes by:
/// its catalogue name, its other names, its engine ids and its registry
/// aliases (a Studio gear is claimed under `studio-<name>`).
fn claims_and_tools(names: &[String]) -> (Vec<ComponentKitClaimDto>, Vec<ComponentToolDto>) {
    let mut claims: Vec<ComponentKitClaimDto> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for name in names {
        let key = name.to_ascii_lowercase();
        if key.is_empty() || seen.contains(&key) {
            continue;
        }
        seen.push(key);
        for c in crate::kit_registry::port::builtin_gear_claims(name) {
            if !claims
                .iter()
                .any(|x| x.kit == c.kit && x.gear.eq_ignore_ascii_case(name))
            {
                claims.push(ComponentKitClaimDto {
                    kit: c.kit,
                    kit_name: c.kit_name,
                    gear: name.clone(),
                    types: c.types,
                    mcp_tools: c.mcp_tools,
                    routes: c.routes,
                });
            }
        }
    }
    let tools = crate::mcp::tools_by_gear()
        .into_iter()
        .filter(|(gear, _)| seen.iter().any(|s| s == gear))
        .map(|(_, t)| ComponentToolDto {
            name: t.name.to_owned(),
            description: t.description.to_owned(),
            effect: match t.effect {
                crate::mcp::sdk::Effect::Read => "read",
                crate::mcp::sdk::Effect::Write => "write",
                crate::mcp::sdk::Effect::Destructive => "destructive",
            }
            .to_owned(),
        })
        .collect();
    (claims, tools)
}

async fn get_component(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    Path(name): Path<String>,
) -> ApiResult<JsonBody<ComponentDetailDto>> {
    let wanted = name.trim();
    if wanted.is_empty() {
        return Err(StudioComponentsCatalogError::invalid_argument()
            .with_field_violation("name", "must not be empty", "INVALID")
            .create());
    }
    // The reference is cached per catalogue generation; it never waits for
    // a cold Gearbox cache.
    let (entries, _, _, _) = reference_entries(&ctx, &catalog, 0, false).await?;
    let reference = entries.iter().find(|e| {
        same(&e.name, wanted)
            || e.aka.iter().any(|a| same(a, wanted))
            || e.engine.iter().any(|g| same(&g.id, wanted))
    });
    let (nodes, _) = catalog
        .service
        .list_component_nodes(&ctx)
        .await
        .map_err(internal)?;
    let node = reference
        .and_then(|r| r.instance_id.as_deref())
        .and_then(|id| nodes.iter().find(|n| n.instance_id == id))
        .or_else(|| {
            nodes.iter().find(|n| {
                n.value
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|x| same(x, wanted))
            })
        });
    let node_name = node
        .and_then(|n| n.value.get("name").and_then(Value::as_str))
        .unwrap_or(wanted)
        .to_owned();
    let profile = catalog
        .service
        .list_profiles(&ctx)
        .await
        .map_err(internal)?
        .into_iter()
        .find(|p| {
            p.value
                .get("gear_name")
                .and_then(Value::as_str)
                .is_some_and(|g| same(g, &node_name))
        })
        .map(|p| p.value);
    // The registry is the organization's: at the platform's level, or where
    // it cannot be read, the page goes on without it.
    let registry = catalog
        .service
        .registry_entries(&ctx)
        .await
        .unwrap_or_default()
        .into_iter()
        .find(|r| {
            same(&r.entry.name, wanted)
                || same(&r.entry.name, &node_name)
                || r.entry.aliases.iter().any(|a| same(a, wanted))
        });
    if reference.is_none() && node.is_none() && registry.is_none() {
        return Err(StudioComponentsCatalogError::not_found(format!(
            "the catalogue has no component `{wanted}`"
        ))
        .with_resource(wanted.to_owned())
        .create());
    }

    let mut names: Vec<String> = vec![wanted.to_owned(), node_name.clone()];
    if let Some(r) = reference {
        names.push(r.name.clone());
        names.extend(r.aka.iter().cloned());
        names.extend(r.engine.iter().map(|g| g.id.clone()));
    }
    if let Some(r) = &registry {
        names.push(r.entry.name.clone());
        names.extend(r.entry.aliases.iter().cloned());
    }
    let (claims, tools) = claims_and_tools(&names);

    Ok(Json(build(DetailInputs {
        name: reference.map_or(node_name.as_str(), |r| r.name.as_str()),
        node: node.map(|n| (n.type_id.as_str(), &n.value)),
        profile: profile.as_ref(),
        reference,
        registry: registry.as_ref(),
        claims,
        tools,
    })))
}

pub(super) fn register(router: Router, openapi: &dyn OpenApiRegistry) -> Router {
    OperationBuilder::get("/studio-components-catalog/v1/components/{name}")
        .operation_id("studio_components_catalog.get_component")
        .summary(
            "One component's page: its type, what it provides and needs, and who stands for it",
        )
        .description(
            "One component by name (case-blind; a catalogue name, another name it is \
             stored under, an engine id, or a registry entry's name or alias), with \
             everything its page shows in one answer: `component_type` (`gear`, \
             `plugin`, `mfe`, `service`, `infra`, `library`, `kit` or `other`) and the \
             evidence for it; the passport it was read from (`gear.gdl`, `frontx.gdl`, \
             `service.gdl`) and its documents, with links; what it provides \
             (capabilities, extension points and plugins, the point a plugin fills and \
             its hosts, an MFE's screens, MCP tools, GTS types, a service's ports and \
             variables); what it needs (catalogued dependencies, the gears and services \
             it calls or requires, databases, runtime capabilities, connections); the \
             catalogued components that depend on it and the built-in kits that claim \
             its types, tools or write routes (ADR-0071); its maturity, readiness and \
             engine facts.\n\n\
             UNKNOWN IS NULL OR EMPTY, NEVER GUESSED: every list is what a passport, \
             a manifest or the engine says. The organization's registry (where \
             projects declare it) is `GET /registry/{name}`. 404 when neither the \
             catalogue, the engine nor the registry knows the name.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("name", "Component name")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(get_component)
        .json_response_with_schema::<ComponentDetailDto>(openapi, StatusCode::OK, "The component")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi)
}
