//! Where the engine's corpus comes from: the platform's gear repositories
//! (ADR-0046).
//!
//! A gear repository is a connection of the `gear-repository` kind. The
//! platform's are the ones the root tenant holds, and the engine reads them
//! together, in the order they were added. Listing them needs a caller's
//! security context, so they are read on the way into a request that may use
//! the engine (this gear's routes and the catalogue's), at most once a
//! minute; a change is checked out on the next use. While the platform has
//! none, the deployment's corpus stays the one root.

use std::sync::Arc;

use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;
use toolkit_security::SecurityContext;
use tracing::warn;

use super::gearbox::{CorpusSource, GearRoot, Gearbox};
use crate::connectors::sdk::{Connectors, GearRepositorySource, ownership::PLATFORM_ROOT_TENANT};

/// The routes whose handlers may run the engine.
const ENGINE_ROUTES: [&str; 2] = ["/studio-product/", "/studio-components-catalog/"];

/// A gear repository as a root of the corpus. The checkout directory is
/// namespaced by the connection, so two connections never share one, and a
/// renamed source id keeps its clone.
pub fn root_of(r: GearRepositorySource) -> GearRoot {
    GearRoot {
        source: CorpusSource {
            label: if r.git_ref.is_empty() {
                r.repo.clone()
            } else {
                format!("{}@{}", r.repo, r.git_ref)
            },
            key: format!("gearbox-{}", r.connection_id.simple()),
            repo: r.source_id.clone(),
            url: r.url,
            username: r.username,
            token: r.token,
            git_ref: r.git_ref,
        },
        id: r.source_id,
        connection_id: Some(r.connection_id),
    }
}

/// `ctx`'s subject acting in the platform's (root) tenant, where its gear
/// repositories are held.
fn in_root(ctx: &SecurityContext) -> anyhow::Result<SecurityContext> {
    let mut b = SecurityContext::builder()
        .subject_id(ctx.subject_id())
        .subject_tenant_id(PLATFORM_ROOT_TENANT)
        .token_scopes(ctx.token_scopes().to_vec());
    if let Some(kind) = ctx.subject_type() {
        b = b.subject_type(kind);
    }
    if let Some(token) = ctx.bearer_token() {
        b = b.bearer_token(token.clone());
    }
    b.build()
        .map_err(|e| anyhow::anyhow!("cannot read the platform's gear repositories: {e}"))
}

/// The engine's status, asked with `?refresh=true`: the Sources page asks so
/// right after it adds or removes a repository, and reads the list anew.
const STATUS_ROUTE: &str = "/studio-product/v1/gearbox";

/// Read the platform's gear repositories into the engine, when due or when
/// `now`.
pub async fn refresh(gearbox: &Gearbox, connectors: &Connectors, ctx: &SecurityContext, now: bool) {
    if !now && !gearbox.roots_due() {
        return;
    }
    let Some(service) = connectors.get() else {
        return;
    };
    let listed = match in_root(ctx) {
        Ok(root) => service.gear_repositories(&root, PLATFORM_ROOT_TENANT).await,
        Err(e) => Err(e),
    };
    match listed {
        Ok(list) => gearbox.use_repositories(list.into_iter().map(root_of).collect()),
        // Keep the roots there are; the next request tries again.
        Err(e) => {
            gearbox.mark_roots_checked();
            warn!(error = %format!("{e:#}"), "studio-product: the platform's gear repositories could not be read");
        }
    }
}

/// The layer that does [`refresh`] on the way into an engine route.
pub async fn layer(
    gearbox: Arc<Gearbox>,
    connectors: Connectors,
    request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path();
    let now = path == STATUS_ROUTE
        && request
            .uri()
            .query()
            .is_some_and(|q| q.split('&').any(|kv| kv == "refresh=true"));
    if ENGINE_ROUTES.iter().any(|p| path.starts_with(p))
        && let Some(ctx) = request.extensions().get::<SecurityContext>()
    {
        refresh(&gearbox, &connectors, ctx, now).await;
    }
    next.run(request).await
}
