//! REST surface for queued notifications.
//!
//! Four routes and one idea: a caller hands over a notification and gets an id
//! back, not a delivery. `202 Accepted` is the honest status — the message is
//! durably recorded and queued, and whether Slack takes it is not yet known.
//!
//! The synchronous route next door,
//! `POST /studio-connector/v1/connections/{id}/messages`, still exists and
//! still answers with what the platform said. That one is for a human pressing
//! "send a test message"; this one is for everything that must not be lost.

use std::sync::Arc;

use axum::extract::{Path, Query};
use axum::{Extension, Router};
use serde::Deserialize;
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::service::{DeliveryQuery, NewDelivery, NotifyService};
use super::{DeliveryState, entity};

/// Errors attributable to a delivery as a resource.
#[resource_error(gts_id!("cf.studio.notify.delivery.v1~"))]
pub struct StudioNotifyError;

/// Service handle. `None` = the gear booted without a database, so there is no
/// queue: the routes stay mounted and answer 503 with the reason.
#[derive(Clone)]
pub struct Notify(pub Option<Arc<NotifyService>>);

impl Notify {
    fn get(&self) -> ApiResult<&Arc<NotifyService>> {
        self.0.as_ref().ok_or_else(|| {
            CanonicalError::service_unavailable()
                .with_detail(
                    "queued notifications are not available in this deployment \
                     (studio-notify has no database configured)",
                )
                .create()
        })
    }
}

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

/* ── DTOs ── */

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SendRequest {
    /// Connection to deliver through, from
    /// `GET /studio-connector/v1/connections`.
    #[schema(value_type = String)]
    pub connection_id: Uuid,
    /// Channel, from `GET /studio-connector/v1/connections/{id}/targets`.
    /// Omitted for a provider whose credential fixes the channel.
    #[serde(default)]
    pub target: Option<String>,
    /// A short headline, rendered bold above the body.
    #[serde(default)]
    pub title: Option<String>,
    /// The message body. Markdown-ish; each driver renders it into its own
    /// platform's idiom.
    pub text: String,
    /// A link to the thing this is about, appended as its own line.
    #[serde(default)]
    pub link: Option<String>,
    /// Thread/topic within the channel. Required by Zulip, which supplies a
    /// default when it is absent; ignored by Slack and Discord.
    #[serde(default)]
    pub topic: Option<String>,
    /// Repeat-safe key. A second request with the same key in the same tenant
    /// returns the first delivery rather than queuing another — which is what
    /// makes a caller's own retry safe.
    #[serde(default)]
    pub idempotency_key: Option<String>,
    /// Tenant that owns the connection. Omitted = the caller's own.
    #[schema(value_type = Option<String>)]
    #[serde(default)]
    pub tenant_id: Option<Uuid>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DeliveryDto {
    #[schema(value_type = String)]
    pub id: Uuid,
    #[schema(value_type = String)]
    pub tenant_id: Uuid,
    #[schema(value_type = String)]
    pub connection_id: Uuid,
    /// Provider key as it was at accept time.
    pub provider: String,
    /// `queued` | `sent` | `failed`.
    pub state: String,
    /// Channel asked for, if the provider takes one.
    pub target: Option<String>,
    /// Where it landed, as the platform reported it.
    pub delivered_target: Option<String>,
    pub title: Option<String>,
    pub text: String,
    pub link: Option<String>,
    pub topic: Option<String>,
    /// Attempts made so far.
    pub attempts: i32,
    /// Why the last attempt failed, in the platform's own words.
    pub last_error: Option<String>,
    /// Provider-native message id, where the platform returns one.
    pub platform_message_id: Option<String>,
    #[schema(value_type = String)]
    pub requested_by: Uuid,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DeliveryListDto {
    pub items: Vec<DeliveryDto>,
}

/// Which tenant's deliveries, and which of them.
#[derive(Debug, Deserialize)]
pub struct DeliveryFilter {
    #[serde(default)]
    tenant: Option<Uuid>,
    /// `queued` | `sent` | `failed`. Omitted = all.
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    connection_id: Option<Uuid>,
    /// Page size, default 50.
    #[serde(default)]
    limit: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct ScopeQuery {
    #[serde(default)]
    tenant: Option<Uuid>,
}

fn to_dto(row: entity::Model) -> DeliveryDto {
    DeliveryDto {
        id: row.id,
        tenant_id: row.tenant_id,
        connection_id: row.connection_id,
        provider: row.provider,
        state: row.state,
        target: row.target,
        delivered_target: row.delivered_target,
        title: row.title,
        text: row.body,
        link: row.link,
        topic: row.topic,
        attempts: i32::from(row.attempts),
        last_error: row.last_error,
        platform_message_id: row.platform_message_id,
        requested_by: row.requested_by,
        created_at: rfc3339(row.created_at),
        updated_at: rfc3339(row.updated_at),
    }
}

/// Timestamps go out as RFC 3339 strings, like every other studio DTO.
fn rfc3339(at: time::OffsetDateTime) -> String {
    at.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| at.unix_timestamp().to_string())
}

/* ── Handlers ── */

async fn send(
    Extension(ctx): Extension<SecurityContext>,
    Extension(notify): Extension<Notify>,
    Json(req): Json<SendRequest>,
) -> ApiResult<(StatusCode, JsonBody<DeliveryDto>)> {
    let svc = notify.get()?;
    let row = svc
        .accept(
            &ctx,
            NewDelivery {
                tenant: req.tenant_id.unwrap_or_else(|| ctx.subject_tenant_id()),
                connection_id: req.connection_id,
                target: req.target.as_deref(),
                title: req.title.as_deref(),
                text: &req.text,
                link: req.link.as_deref(),
                topic: req.topic.as_deref(),
                idempotency_key: req.idempotency_key.as_deref(),
            },
        )
        .await
        // Everything `accept` refuses is the caller's to fix: an unusable
        // connection, a missing or a forbidden target, an empty message. The
        // message is written down only after all of it passes.
        .map_err(|e| {
            StudioNotifyError::invalid_argument()
                .with_constraint(format!("{e:#}"))
                .create()
        })?;
    Ok((StatusCode::ACCEPTED, Json(to_dto(row))))
}

async fn get_delivery(
    Extension(ctx): Extension<SecurityContext>,
    Extension(notify): Extension<Notify>,
    Path(id): Path<Uuid>,
    Query(q): Query<ScopeQuery>,
) -> ApiResult<JsonBody<DeliveryDto>> {
    let svc = notify.get()?;
    let tenant = q.tenant.unwrap_or_else(|| ctx.subject_tenant_id());
    let row = svc
        .get(&ctx, tenant, id)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?
        .ok_or_else(|| {
            StudioNotifyError::not_found("Delivery not found")
                .with_resource(id.to_string())
                .create()
        })?;
    Ok(Json(to_dto(row)))
}

async fn list_deliveries(
    Extension(ctx): Extension<SecurityContext>,
    Extension(notify): Extension<Notify>,
    Query(q): Query<DeliveryFilter>,
) -> ApiResult<JsonBody<DeliveryListDto>> {
    let svc = notify.get()?;
    let state = match q.state.as_deref() {
        Some(raw) => Some(DeliveryState::parse(raw).map_err(|e| {
            StudioNotifyError::invalid_argument()
                .with_constraint(format!("{e:#}"))
                .create()
        })?),
        None => None,
    };
    let items = svc
        .list(
            &ctx,
            q.tenant.unwrap_or_else(|| ctx.subject_tenant_id()),
            &DeliveryQuery {
                state,
                connection_id: q.connection_id,
                limit: q.limit.unwrap_or(50).clamp(1, 500),
            },
        )
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(DeliveryListDto {
        items: items.into_iter().map(to_dto).collect(),
    }))
}

async fn retry_delivery(
    Extension(ctx): Extension<SecurityContext>,
    Extension(notify): Extension<Notify>,
    Path(id): Path<Uuid>,
    Query(q): Query<ScopeQuery>,
) -> ApiResult<(StatusCode, JsonBody<DeliveryDto>)> {
    let svc = notify.get()?;
    let tenant = q.tenant.unwrap_or_else(|| ctx.subject_tenant_id());
    let row = svc.retry(&ctx, tenant, id).await.map_err(|e| {
        // "already delivered", "still queued", "not found" — all statements
        // about this delivery's state, which is what a precondition is.
        StudioNotifyError::failed_precondition()
            .with_precondition_violation(id.to_string(), format!("{e:#}"), "NOTIFY_RETRY_REFUSED")
            .create()
    })?;
    Ok((StatusCode::ACCEPTED, Json(to_dto(row))))
}

/* ── Registration ── */

pub fn register_routes(
    mut router: Router,
    openapi: &dyn OpenApiRegistry,
    service: Option<Arc<NotifyService>>,
) -> Router {
    router = OperationBuilder::post("/studio-notify/v1/messages")
        .operation_id("studio_notify.send")
        .summary("Queue a notification for delivery")
        .description(
            "Records the notification and queues it, then answers 202 with its id. \
             The connection is verified against the provider catalogue first, so an \
             unusable connection or a missing channel is a 400 here rather than a \
             failed delivery later. Delivery is retried with exponential backoff and \
             dead-lettered after several attempts; poll `GET /messages/{id}` for the \
             outcome. Pass `idempotency_key` to make your own retry of this request \
             safe.",
        )
        .tag("StudioNotify")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<SendRequest>(openapi, "The notification to deliver")
        .handler(send)
        .json_response_with_schema::<DeliveryDto>(
            openapi,
            StatusCode::ACCEPTED,
            "Recorded and queued",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-notify/v1/messages")
        .operation_id("studio_notify.list")
        .summary("List deliveries")
        .description(
            "Newest first, scoped to one tenant. Filter by `state` to answer the \
             two questions worth asking: `failed` for what needs attention, \
             `queued` for what is still in flight.",
        )
        .tag("StudioNotify")
        .authenticated()
        .require_license_features::<License>([])
        .handler(list_deliveries)
        .json_response_with_schema::<DeliveryListDto>(openapi, StatusCode::OK, "Deliveries")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-notify/v1/messages/{id}")
        .operation_id("studio_notify.get")
        .summary("What happened to one delivery")
        .tag("StudioNotify")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("id", "Delivery id")
        .handler(get_delivery)
        .json_response_with_schema::<DeliveryDto>(openapi, StatusCode::OK, "The delivery")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-notify/v1/messages/{id}/retry")
        .operation_id("studio_notify.retry")
        .summary("Put a failed delivery back on the queue")
        .description(
            "For a delivery that gave up — a credential that has since been rotated, \
             a channel the bot has since been invited to. Refuses a delivery that was \
             already sent (retrying would post it twice) and one that is still queued \
             (it has not given up yet).",
        )
        .tag("StudioNotify")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("id", "Delivery id")
        .handler(retry_delivery)
        .json_response_with_schema::<DeliveryDto>(openapi, StatusCode::ACCEPTED, "Queued again")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router.layer(Extension(Notify(service)))
}
