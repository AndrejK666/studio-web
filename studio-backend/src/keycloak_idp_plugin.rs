//! Keycloak IdP plugin — real user provisioning behind AM's pluggable
//! IdP contract (ADR-0004, invite-first onboarding).
//!
//! Replaces the static echo plugin in the OIDC profile: an invite in the
//! portal (`POST /account-management/v1/tenants/{id}/users`) now creates an
//! actual Keycloak user with the `tenant_id` attribute set to the target
//! tenant, so the person can immediately "Sign in with SSO". Tenant mapping
//! is attribute-based: ALL Studio tenants live in one realm and a tenant has
//! no realm-side resources of its own, so `provision_tenant` succeeds with
//! no metadata — that is the truthful realm-side outcome, not a skip.
//!
//! Selection: registers a `PluginV1<IdpPluginSpecV1>` instance under the
//! same vendor as the static plugin with a LOWER priority number (lower
//! wins), so linking + configuring it takes over user provisioning.
//!
//! The odata filter/pagination helpers are copied from the static plugin's
//! `client.rs` (same SPI, same snapshot-based evaluation) — the snapshot
//! here comes from the Keycloak Admin API instead of an in-memory map.

use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;
use toolkit::Gear;
use toolkit::client_hub::ClientScope;
use toolkit::context::GearCtx;
use toolkit::gts::PluginV1;
use toolkit_odata::filter::{FilterNode, FilterOp, ODataValue};
use toolkit_odata::{CursorV1, ODataOrderBy, OrderKey, Page, SortDir};
use toolkit_security::SecurityContext;
use tracing::{info, warn};
use types_registry_sdk::{RegisterResult, TypesRegistryClient};
use uuid::Uuid;

use account_management_sdk::{
    IdpDeprovisionFailure, IdpDeprovisionTenantRequest, IdpDeprovisionUserRequest,
    IdpListUsersRequest, IdpPluginClient, IdpPluginSpecV1, IdpProvisionFailure,
    IdpProvisionResult, IdpProvisionTenantRequest, IdpProvisionUserRequest, IdpUser,
    IdpUserDuplicateField, IdpUserFilterField, IdpUserOperationFailure,
};

/* ── Config ── */

#[derive(Debug, Clone, Deserialize, toolkit_macros::ExpandVars)]
#[serde(default, deny_unknown_fields)]
pub struct KeycloakIdpPluginConfig {
    /// Vendor for GTS registration — same pool as static-idp-plugin ("cf").
    pub vendor: String,
    /// Lower number wins; static ships with 100.
    pub priority: i16,
    /// Keycloak base URL, e.g. `https://localhost:8443`.
    pub base_url: String,
    /// Realm hosting Studio users.
    pub realm: String,
    /// Confidential client with service-account realm-management roles
    /// (`manage-users`, `view-users`).
    pub client_id: String,
    #[expand_vars]
    pub client_secret: String,
    /// Extra CA certs (PEM) for the dev Keycloak's self-signed TLS.
    pub custom_ca_certificate_paths: Vec<String>,
    /// Temporary password assigned when the invite carries none; the user
    /// must rotate it at first sign-in (UPDATE_PASSWORD required action).
    #[expand_vars]
    pub default_temp_password: String,
    /// Snapshot ceiling for list_users (dev-scale; one attribute query).
    pub list_snapshot_max: u32,
}

impl Default for KeycloakIdpPluginConfig {
    fn default() -> Self {
        Self {
            vendor: "cf".to_owned(),
            priority: 50,
            base_url: "https://localhost:8443".to_owned(),
            realm: "studio".to_owned(),
            client_id: "studio-admin".to_owned(),
            client_secret: String::new(),
            custom_ca_certificate_paths: Vec::new(),
            default_temp_password: "studio".to_owned(),
            list_snapshot_max: 1000,
        }
    }
}

/* ── Keycloak Admin API client ── */

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
}

/// Keycloak user representation (the fields we read).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KcUser {
    id: Uuid,
    username: String,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    first_name: Option<String>,
    #[serde(default)]
    last_name: Option<String>,
}

impl KcUser {
    fn into_idp_user(self) -> IdpUser {
        let display = match (&self.first_name, &self.last_name) {
            (Some(f), Some(l)) => Some(format!("{f} {l}")),
            (Some(f), None) => Some(f.clone()),
            (None, Some(l)) => Some(l.clone()),
            (None, None) => None,
        };
        let mut u = IdpUser::new(self.id, self.username);
        u.email = self.email;
        u.first_name = self.first_name;
        u.last_name = self.last_name;
        u.display_name = display;
        u
    }
}

struct KeycloakAdmin {
    http: reqwest::Client,
    cfg: KeycloakIdpPluginConfig,
}

impl KeycloakAdmin {
    fn admin_base(&self) -> String {
        format!("{}/admin/realms/{}", self.cfg.base_url, self.cfg.realm)
    }

    fn unavailable(detail: impl std::fmt::Display) -> IdpUserOperationFailure {
        IdpUserOperationFailure::Unavailable {
            detail: format!("keycloak: {detail}"),
        }
    }

    /// Service-account token per call. Dev-scale: no caching — one extra
    /// round-trip per admin operation keeps expiry/rotation logic out.
    async fn token(&self) -> Result<String, IdpUserOperationFailure> {
        let url = format!(
            "{}/realms/{}/protocol/openid-connect/token",
            self.cfg.base_url, self.cfg.realm
        );
        let resp = self
            .http
            .post(&url)
            .form(&[
                ("grant_type", "client_credentials"),
                ("client_id", self.cfg.client_id.as_str()),
                ("client_secret", self.cfg.client_secret.as_str()),
            ])
            .send()
            .await
            .map_err(Self::unavailable)?;
        if !resp.status().is_success() {
            return Err(Self::unavailable(format!(
                "token endpoint returned {} (check studio-admin client + secret)",
                resp.status()
            )));
        }
        Ok(resp
            .json::<TokenResponse>()
            .await
            .map_err(Self::unavailable)?
            .access_token)
    }

    /// Create the user; returns the Keycloak-issued user id.
    async fn create_user(
        &self,
        tenant_id: Uuid,
        payload: &account_management_sdk::IdpNewUser,
    ) -> Result<Uuid, IdpUserOperationFailure> {
        let token = self.token().await?;
        let (password, temporary) = match &payload.password {
            Some(p) => (p.value.clone(), p.temporary),
            None => (self.cfg.default_temp_password.clone(), true),
        };
        let body = json!({
            "username": payload.username,
            "email": payload.email,
            "firstName": payload.first_name,
            "lastName": payload.last_name,
            "enabled": true,
            "attributes": { "tenant_id": [tenant_id.to_string()] },
            "credentials": [{ "type": "password", "value": password, "temporary": temporary }],
            "requiredActions": if temporary { json!(["UPDATE_PASSWORD"]) } else { json!([]) },
        });
        let resp = self
            .http
            .post(format!("{}/users", self.admin_base()))
            .bearer_auth(&token)
            .json(&body)
            .send()
            .await
            .map_err(Self::unavailable)?;
        match resp.status().as_u16() {
            201 => {
                // Location: .../users/{id}
                let loc = resp
                    .headers()
                    .get("location")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.rsplit('/').next())
                    .and_then(|v| Uuid::parse_str(v).ok());
                loc.ok_or_else(|| Self::unavailable("created user but Location header unparsable"))
            }
            // On the create endpoint a 409 has no cause other than a
            // uniqueness collision (KC emits the combined constant).
            409 => Err(IdpUserOperationFailure::DuplicateUser {
                field: IdpUserDuplicateField::UsernameOrEmail,
                detail: "keycloak: user exists with same username or email".to_owned(),
            }),
            400 => Err(IdpUserOperationFailure::Rejected {
                detail: format!(
                    "keycloak rejected the payload: {}",
                    resp.text().await.unwrap_or_default()
                ),
            }),
            s => Err(Self::unavailable(format!("createUser returned {s}"))),
        }
    }

    async fn delete_user(&self, user_id: Uuid) -> Result<(), IdpUserOperationFailure> {
        let token = self.token().await?;
        let resp = self
            .http
            .delete(format!("{}/users/{}", self.admin_base(), user_id))
            .bearer_auth(&token)
            .send()
            .await
            .map_err(Self::unavailable)?;
        match resp.status().as_u16() {
            // 404 folds into Ok: "the user is gone after the call".
            204 | 404 => Ok(()),
            s => Err(Self::unavailable(format!("deleteUser returned {s}"))),
        }
    }

    /// All users of the tenant (attribute query), mapped to the projection.
    async fn tenant_users(&self, tenant_id: Uuid) -> Result<Vec<IdpUser>, IdpUserOperationFailure> {
        let token = self.token().await?;
        let resp = self
            .http
            .get(format!("{}/users", self.admin_base()))
            .bearer_auth(&token)
            .query(&[
                ("q", format!("tenant_id:{tenant_id}")),
                ("max", self.cfg.list_snapshot_max.to_string()),
                ("briefRepresentation", "true".to_owned()),
            ])
            .send()
            .await
            .map_err(Self::unavailable)?;
        if !resp.status().is_success() {
            return Err(Self::unavailable(format!(
                "user query returned {}",
                resp.status()
            )));
        }
        let users: Vec<KcUser> = resp.json().await.map_err(Self::unavailable)?;
        Ok(users.into_iter().map(KcUser::into_idp_user).collect())
    }
}

/* ── OData snapshot helpers ─────────────────────────────────────────────
   Copied from gears-rust static-idp-plugin (domain/client.rs) — identical
   SPI semantics; the snapshot source differs. Keep in sync on SDK bumps. */

fn matches_filter(user: &IdpUser, filter: &FilterNode<IdpUserFilterField>) -> bool {
    match filter {
        FilterNode::Binary { field, op, value } => eval_binary(user, *field, *op, value),
        FilterNode::Composite {
            op: FilterOp::And,
            children,
        } => children.iter().all(|c| matches_filter(user, c)),
        FilterNode::Composite {
            op: FilterOp::Or,
            children,
        } => children.iter().any(|c| matches_filter(user, c)),
        FilterNode::Composite { .. } => unreachable!(
            "the OData parser only emits And/Or as composite ops (see \
             static-idp-plugin, from which this evaluator is copied)"
        ),
        FilterNode::Not(inner) => !matches_filter(user, inner),
        FilterNode::InList { field, values } => values
            .iter()
            .any(|v| eval_binary(user, *field, FilterOp::Eq, v)),
    }
}

fn eval_binary(
    user: &IdpUser,
    field: IdpUserFilterField,
    op: FilterOp,
    value: &ODataValue,
) -> bool {
    let lhs: Option<String> = match field {
        IdpUserFilterField::Id => Some(user.id.to_string()),
        IdpUserFilterField::Username => Some(user.username.clone()),
        IdpUserFilterField::Email => user.email.clone(),
        IdpUserFilterField::DisplayName => user.display_name.clone(),
        IdpUserFilterField::FirstName => user.first_name.clone(),
        IdpUserFilterField::LastName => user.last_name.clone(),
    };
    let rhs: String = match value {
        ODataValue::String(s) => s.clone(),
        ODataValue::Uuid(u) => u.to_string(),
        other => unreachable!("String/Uuid only at this SPI; got {other:?}"),
    };
    let Some(lhs) = lhs else {
        return matches!(op, FilterOp::Ne);
    };
    let lo = |s: &str| s.to_lowercase();
    match op {
        FilterOp::Eq => lhs == rhs,
        FilterOp::Ne => lhs != rhs,
        FilterOp::Contains => lo(&lhs).contains(&lo(&rhs)),
        FilterOp::StartsWith => lo(&lhs).starts_with(&lo(&rhs)),
        FilterOp::EndsWith => lo(&lhs).ends_with(&lo(&rhs)),
        other => unreachable!("op {other:?} rejected upstream by the REST parser"),
    }
}

fn compare_by_order(a: &IdpUser, b: &IdpUser, order: &ODataOrderBy) -> std::cmp::Ordering {
    for key in &order.0 {
        let ord = project_field(a, &key.field).cmp(&project_field(b, &key.field));
        let ord = match key.dir {
            SortDir::Asc => ord,
            SortDir::Desc => ord.reverse(),
        };
        if !ord.is_eq() {
            return ord;
        }
    }
    std::cmp::Ordering::Equal
}

fn project_field(u: &IdpUser, field: &str) -> String {
    match field {
        "id" => u.id.to_string(),
        "username" => u.username.clone(),
        "email" => u.email.clone().unwrap_or_default(),
        "display_name" => u.display_name.clone().unwrap_or_default(),
        "first_name" => u.first_name.clone().unwrap_or_default(),
        "last_name" => u.last_name.clone().unwrap_or_default(),
        other => unreachable!("unknown order field {other:?} (whitelisted upstream)"),
    }
}

fn project_key_tuple(u: &IdpUser, order: &ODataOrderBy) -> Vec<String> {
    order.0.iter().map(|k| project_field(u, &k.field)).collect()
}

fn compare_key_to_cursor(
    item_keys: &[String],
    cursor_keys: &[String],
    order: &ODataOrderBy,
) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    for (idx, key) in order.0.iter().enumerate() {
        let lhs = item_keys.get(idx).map_or("", String::as_str);
        let rhs = cursor_keys.get(idx).map_or("", String::as_str);
        let ord = lhs.cmp(rhs);
        let ord = match key.dir {
            SortDir::Asc => ord,
            SortDir::Desc => ord.reverse(),
        };
        if !ord.is_eq() {
            return ord;
        }
    }
    Ordering::Equal
}

/* ── IdpPluginClient impl ── */

#[async_trait]
impl IdpPluginClient for KeycloakAdmin {
    /// Attribute-based tenant mapping: one realm hosts every Studio tenant
    /// and a tenant materializes no realm-side resources, so success with
    /// no metadata IS the realm-side outcome (not a skipped operation).
    async fn provision_tenant(
        &self,
        _ctx: &SecurityContext,
        _req: &IdpProvisionTenantRequest,
    ) -> Result<IdpProvisionResult, IdpProvisionFailure> {
        Ok(IdpProvisionResult::default())
    }

    /// Users are deprovisioned individually by AM's user pipeline; the
    /// tenant itself owns nothing realm-side to tear down.
    async fn deprovision_tenant(
        &self,
        _ctx: &SecurityContext,
        _req: &IdpDeprovisionTenantRequest,
    ) -> Result<(), IdpDeprovisionFailure> {
        Ok(())
    }

    async fn provision_user(
        &self,
        _ctx: &SecurityContext,
        req: &IdpProvisionUserRequest,
    ) -> Result<IdpUser, IdpUserOperationFailure> {
        let tenant_id = req.tenant_context.tenant_id;
        let id = self.create_user(tenant_id, &req.payload).await?;
        info!(user = %req.payload.username, %tenant_id, kc_id = %id,
              "keycloak-idp-plugin: user provisioned");
        let mut user = IdpUser::new(id, req.payload.username.clone());
        user.email = req.payload.email.clone();
        user.first_name = req.payload.first_name.clone();
        user.last_name = req.payload.last_name.clone();
        user.display_name = req.payload.display_name.clone();
        Ok(user)
    }

    async fn deprovision_user(
        &self,
        _ctx: &SecurityContext,
        req: &IdpDeprovisionUserRequest,
    ) -> Result<(), IdpUserOperationFailure> {
        self.delete_user(req.user_id).await?;
        info!(user_id = %req.user_id, tenant = %req.tenant_context.tenant_id,
              "keycloak-idp-plugin: user deprovisioned");
        Ok(())
    }

    async fn list_users(
        &self,
        _ctx: &SecurityContext,
        req: &IdpListUsersRequest,
    ) -> Result<Page<IdpUser>, IdpUserOperationFailure> {
        // Snapshot from the realm (attribute query), then the same
        // filter/order/cursor walk as the static plugin.
        let mut snapshot = self.tenant_users(req.tenant_context.tenant_id).await?;
        if let Some(filter) = req.filter.as_ref() {
            snapshot.retain(|u| matches_filter(u, filter));
        }
        let effective_order = req
            .order
            .clone()
            .unwrap_or_else(|| {
                ODataOrderBy(vec![OrderKey {
                    field: "username".into(),
                    dir: SortDir::Asc,
                }])
            })
            .ensure_tiebreaker("id", SortDir::Asc);
        snapshot.sort_by(|a, b| compare_by_order(a, b, &effective_order));

        let cursor: Option<CursorV1> = match req.pagination.cursor() {
            None => None,
            Some(raw) => Some(CursorV1::decode(raw).map_err(|err| {
                IdpUserOperationFailure::Rejected {
                    detail: format!("keycloak-idp-plugin: invalid cursor: {err}"),
                }
            })?),
        };
        if let Some(c) = cursor.as_ref()
            && let Err(err) = toolkit_odata::validate_cursor_against(c, &effective_order, None)
        {
            return Err(IdpUserOperationFailure::Rejected {
                detail: format!(
                    "keycloak-idp-plugin: cursor issued for a different $orderby: {err}"
                ),
            });
        }

        let remaining: Vec<IdpUser> = match cursor.as_ref() {
            Some(c) => snapshot
                .into_iter()
                .filter(|u| {
                    compare_key_to_cursor(
                        &project_key_tuple(u, &effective_order),
                        &c.k,
                        &effective_order,
                    )
                    .is_gt()
                })
                .collect(),
            None => snapshot,
        };

        let top = req.pagination.top() as usize;
        let mut page_items: Vec<IdpUser> = remaining.into_iter().take(top + 1).collect();
        let next_cursor = if page_items.len() > top {
            page_items.pop();
            match page_items.last() {
                None => None,
                Some(last) => Some(
                    CursorV1 {
                        k: project_key_tuple(last, &effective_order),
                        o: effective_order.0.first().map_or(SortDir::Asc, |k| k.dir),
                        s: effective_order.to_signed_tokens(),
                        f: None,
                        d: "fwd".to_owned(),
                    }
                    .encode()
                    .map_err(|err| IdpUserOperationFailure::Rejected {
                        detail: format!("keycloak-idp-plugin: cursor encode failed: {err}"),
                    })?,
                ),
            }
        } else {
            None
        };

        Ok(Page::new(
            page_items,
            toolkit_odata::PageInfo {
                next_cursor,
                prev_cursor: None,
                limit: u64::from(req.pagination.top()),
            },
        ))
    }

    // update_user intentionally keeps the default UnsupportedOperation:
    // the portal has no user-edit surface yet, and a partial merge-patch
    // against Keycloak deserves its own tested slice (ADR-0004 phase 2).
}

/* ── Gear ── */

#[toolkit::gear(
    name = "keycloak-idp-plugin",
    deps = [types_registry]
)]
pub struct KeycloakIdpPlugin {
    service: OnceLock<Arc<KeycloakAdmin>>,
}

impl Default for KeycloakIdpPlugin {
    fn default() -> Self {
        Self {
            service: OnceLock::new(),
        }
    }
}

#[async_trait]
impl Gear for KeycloakIdpPlugin {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let cfg: KeycloakIdpPluginConfig = ctx.config_expanded_or_default()?;

        if cfg.client_secret.is_empty() {
            // Linked into every profile; only OIDC-style profiles configure
            // it. Deprioritize sharply so the static echo plugin wins
            // selection and this instance stays inert.
            warn!(
                "keycloak-idp-plugin: no client_secret configured — registering at \
                 priority 10000 (inactive; static-idp-plugin will win selection)"
            );
        }
        let effective_priority = if cfg.client_secret.is_empty() {
            10_000
        } else {
            cfg.priority
        };

        let mut builder = reqwest::Client::builder();
        for path in &cfg.custom_ca_certificate_paths {
            let pem = std::fs::read(path)
                .map_err(|e| anyhow::anyhow!("keycloak-idp-plugin: CA {path}: {e}"))?;
            builder = builder.add_root_certificate(reqwest::Certificate::from_pem(&pem)?);
        }
        let http = builder.build()?;

        info!(
            vendor = %cfg.vendor,
            priority = effective_priority,
            base_url = %cfg.base_url,
            realm = %cfg.realm,
            client_id = %cfg.client_id,
            "keycloak-idp-plugin: configured"
        );

        let service = Arc::new(KeycloakAdmin { http, cfg: cfg.clone() });

        let (instance_id, instance_json) = PluginV1::<IdpPluginSpecV1>::build_registration(
            "cf.studio._.keycloak_idp.v1",
            cfg.vendor.clone(),
            effective_priority,
        )?;
        let registry = ctx.client_hub().get::<dyn TypesRegistryClient>()?;
        let results = registry.register(vec![instance_json]).await?;
        RegisterResult::ensure_all_ok(&results)?;

        self.service
            .set(service.clone())
            .map_err(|_| anyhow::anyhow!("{} gear already initialized", Self::MODULE_NAME))?;

        let api: Arc<dyn IdpPluginClient> = service;
        ctx.client_hub()
            .register_scoped::<dyn IdpPluginClient>(ClientScope::gts_id(&instance_id), api);

        info!(instance_id = %instance_id);
        Ok(())
    }
}
