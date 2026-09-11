//! HTTP surface for the settings gear.
//!
//! Deliberately the same three operations on the same resource as the platform
//! gear it replaces — `GET`, `POST` (replace) and `PATCH` (partial) on
//! `/settings` — under Studio's own path. Keeping the shape is what makes the
//! eventual move back a base-path change rather than a client rewrite
//! (ADR-0017).
//!
//! The response omits `tenant_id`. The platform gear returns it because its key
//! includes it; ours does not have one to report, and echoing a tenant here
//! would invite a client to believe preferences are per-organization.

use std::sync::Arc;

use axum::{Extension, Router};
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;

use super::service::{Settings, SettingsPatch, SettingsService};

#[resource_error(gts_id!("cf.studio.user.settings.v1~"))]
pub struct UserSettingsError;

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

// ── DTOs ────────────────────────────────────────────────────────────────────

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct UserSettingsDto {
    /// The canonical person these belong to — not the sign-in method used to
    /// read them.
    pub user_id: String,
    pub theme: Option<String>,
    pub language: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct ReplaceUserSettingsRequest {
    pub theme: String,
    pub language: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct PatchUserSettingsRequest {
    #[serde(default)]
    pub theme: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
}

fn to_dto(settings: Settings) -> UserSettingsDto {
    UserSettingsDto {
        user_id: settings.user_id.to_string(),
        theme: settings.theme,
        language: settings.language,
    }
}

fn configured(service: Option<Arc<SettingsService>>) -> ApiResult<Arc<SettingsService>> {
    service.ok_or_else(|| {
        CanonicalError::service_unavailable()
            .with_detail(
                "studio-user-settings is not configured: it needs its own `database:` section, \
                 and studio-user must be running so a caller can be resolved to a person",
            )
            .create()
    })
}

/// A bad value is the caller's problem; anything else is ours.
fn invalid(error: anyhow::Error) -> CanonicalError {
    UserSettingsError::invalid_argument()
        .with_constraint(format!("{error:#}"))
        .create()
}

fn internal(error: anyhow::Error) -> CanonicalError {
    CanonicalError::internal(format!("user settings failed: {error:#}")).create()
}

// ── Handlers ────────────────────────────────────────────────────────────────

async fn get_settings(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<SettingsService>>>,
) -> ApiResult<JsonBody<UserSettingsDto>> {
    let service = configured(service)?;
    Ok(Json(to_dto(service.get(&ctx).await.map_err(internal)?)))
}

async fn replace_settings(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<SettingsService>>>,
    Json(req): Json<ReplaceUserSettingsRequest>,
) -> ApiResult<JsonBody<UserSettingsDto>> {
    let service = configured(service)?;
    let settings = service
        .replace(&ctx, &req.theme, &req.language)
        .await
        .map_err(invalid)?;
    Ok(Json(to_dto(settings)))
}

async fn patch_settings(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<SettingsService>>>,
    Json(req): Json<PatchUserSettingsRequest>,
) -> ApiResult<JsonBody<UserSettingsDto>> {
    let service = configured(service)?;
    let settings = service
        .patch(
            &ctx,
            &SettingsPatch {
                theme: req.theme,
                language: req.language,
            },
        )
        .await
        .map_err(invalid)?;
    Ok(Json(to_dto(settings)))
}

// ── Routes ──────────────────────────────────────────────────────────────────

pub fn register_routes(
    router: Router,
    openapi: &dyn OpenApiRegistry,
    service: Option<Arc<SettingsService>>,
) -> Router {
    let router = OperationBuilder::get("/studio-user-settings/v1/settings")
        .operation_id("studio_user_settings.get_settings")
        .summary("Read the signed-in person's preferences")
        .description(
            "Keyed on the canonical Studio person, so the answer is the same however that \
             person signed in and whichever organization they are working in. A person who has \
             set nothing gets empty fields rather than a 404 — an unset preference is a normal \
             state, not a missing resource.",
        )
        .tag("StudioUserSettings")
        .authenticated()
        .require_license_features::<License>([])
        .handler(get_settings)
        .json_response_with_schema::<UserSettingsDto>(openapi, StatusCode::OK, "Preferences")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-user-settings/v1/settings")
        .operation_id("studio_user_settings.replace_settings")
        .summary("Replace the signed-in person's preferences")
        .description(
            "Both fields are required and both are written. Use PATCH to change one and leave \
             the other alone.",
        )
        .tag("StudioUserSettings")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<ReplaceUserSettingsRequest>(openapi, "Preferences")
        .handler(replace_settings)
        .json_response_with_schema::<UserSettingsDto>(openapi, StatusCode::OK, "Preferences")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    OperationBuilder::patch("/studio-user-settings/v1/settings")
        .operation_id("studio_user_settings.patch_settings")
        .summary("Change some of the signed-in person's preferences")
        .description(
            "A field the request omits is left as it was. Creates the record on first write, so \
             a client never has to fall back to POST.",
        )
        .tag("StudioUserSettings")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<PatchUserSettingsRequest>(openapi, "Partial preferences")
        .handler(patch_settings)
        .json_response_with_schema::<UserSettingsDto>(openapi, StatusCode::OK, "Preferences")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi)
        .layer(Extension(service))
}
