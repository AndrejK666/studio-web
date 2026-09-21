//! The subscriber surface: one live stream, one catch-up page.
//!
//! Both are scoped to the caller's tenant from the security context — never
//! from a query parameter, so a client cannot ask for someone else's events.

use std::sync::Arc;

use axum::extract::Query;
use axum::response::IntoResponse;
use axum::{Extension, Router};
use serde::Deserialize;
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_security::SecurityContext;

use super::dto::{StudioEventDto, StudioEventPage};
use super::hub::StudioEventHub;
use super::store::EventStore;

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

/// The handles carried by the router. `None` = the gear stood down for want of
/// a database, and both endpoints say so rather than pretending to be a
/// channel that delivers nothing.
#[derive(Clone)]
pub struct Channel {
    hub: Option<Arc<StudioEventHub>>,
    store: Option<Arc<EventStore>>,
}

impl Channel {
    fn hub(&self) -> ApiResult<&Arc<StudioEventHub>> {
        self.hub.as_ref().ok_or_else(unavailable)
    }

    fn store(&self) -> ApiResult<&Arc<EventStore>> {
        self.store.as_ref().ok_or_else(unavailable)
    }
}

fn unavailable() -> CanonicalError {
    CanonicalError::service_unavailable()
        .with_detail(
            "the studio events channel is not available in this deployment (studio-events has no database configured)",
        )
        .create()
}

/// How far behind the caller is, and how much it will accept.
#[derive(Debug, Deserialize)]
pub struct SinceQuery {
    /// Return events with a cursor strictly greater than this. Omitted = the
    /// whole retained window.
    #[serde(default)]
    pub after_seq: Option<i64>,
    /// Page size, clamped to 500.
    #[serde(default)]
    pub limit: Option<usize>,
}

/// `GET /studio-events/v1/stream` — the live channel.
///
/// Frames are unnamed (`data:` only): the client discriminates on the JSON's
/// `kind`. Keep-alive comments come from the broadcaster every 15 s, which is
/// what holds the connection open through idle-timeout intermediaries.
async fn stream(
    Extension(ctx): Extension<SecurityContext>,
    Extension(channel): Extension<Channel>,
) -> axum::response::Response {
    match channel.hub() {
        Ok(hub) => hub
            .channel(ctx.subject_tenant_id())
            .sse_response()
            .into_response(),
        Err(error) => error.into_response(),
    }
}

/// `GET /studio-events/v1/events?after_seq=N` — replay the gap.
async fn events(
    Extension(ctx): Extension<SecurityContext>,
    Extension(channel): Extension<Channel>,
    Query(q): Query<SinceQuery>,
) -> ApiResult<JsonBody<StudioEventPage>> {
    let limit = q.limit.unwrap_or(200).clamp(1, 500) as u64;
    let (events, latest_seq) = channel
        .store()?
        .after(ctx.subject_tenant_id(), q.after_seq.unwrap_or(0), limit)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(StudioEventPage { events, latest_seq }))
}

pub fn register_routes(
    router: Router,
    openapi: &dyn OpenApiRegistry,
    hub: Option<Arc<StudioEventHub>>,
    store: Option<Arc<EventStore>>,
) -> Router {
    let router = OperationBuilder::get("/studio-events/v1/stream")
        .operation_id("studio_events.stream")
        .summary("Live event stream for the caller's tenant (SSE)")
        .description(
            "Server-Sent Events stream of everything the assembly publishes for \
             the caller's tenant — long-running task progress and completion \
             first among them. Frames are unnamed; the event type is the JSON's \
             `kind`. On reconnect, replay the gap with \
             GET /studio-events/v1/events?after_seq=<last seq seen>.",
        )
        .tag("StudioEvents")
        .authenticated()
        .require_license_features::<License>([])
        .handler(stream)
        .sse_json::<StudioEventDto>(openapi, "Stream of studio events")
        .error_401(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-events/v1/events")
        .operation_id("studio_events.events")
        .summary("Replay recently published events")
        .description(
            "The retained window of events for the caller's tenant, oldest \
             first. `after_seq` returns only what is newer than a cursor — the \
             reconnect path for a client that missed frames. `latest_seq` is \
             the tenant's high-water mark: when it exceeds the last returned \
             `seq`, the client fell out of the retained window.",
        )
        .tag("StudioEvents")
        .authenticated()
        .require_license_features::<License>([])
        .handler(events)
        .json_response_with_schema::<StudioEventPage>(openapi, StatusCode::OK, "Retained events")
        .error_401(openapi)
        .register(router, openapi);

    router.layer(Extension(Channel { hub, store }))
}
