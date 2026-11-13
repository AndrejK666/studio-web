//! Whether each of a project's repositories could be cloned, and why not
//! (#1071).
//!
//! The server's own sync already says when it last read a repository (the
//! repository node's `synced_at`, the Sources tab's "Last sync"). What nobody
//! said is whether the people working on the project could get the code: an
//! IDE session that cloned a private source without its token failed at the
//! provider, and the portal showed the source as healthy.
//!
//! So each clone or fetch somebody else's code path sees is recorded here, as
//! the LAST outcome per (project, repository) — a row overwritten, never a
//! history:
//!
//! - `studio-git` (the Git remote desktops clone through) records every
//!   `info/refs` of an upload-pack: cloned when the source host served it,
//!   failed with the cause when it, or the proxy itself, refused.
//! - `studio-session` records a launch that has to clone a source without the
//!   token its connection should lend (the connection is not found, is held
//!   outside the organization, or its token cannot be read), and forgets
//!   that failure once a launch has the token again.
//!
//! The writers reach this through [`super::port::CloneOutcomes`]; the reader
//! is `GET /studio-artifact-ingest/v1/sources/clone-status`, which the Sources
//! tab and the `project_sources` MCP tool read. No token and no URL is stored:
//! a repository is keyed by host and path (`project_sources::repository_key`),
//! and the detail text goes through [`redact`] first.

use std::sync::Arc;

use async_trait::async_trait;
use axum::extract::Query;
use axum::{Extension, Router};
use sea_orm::{ActiveValue, ColumnTrait, Condition, EntityTrait};
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit::client_hub::ClientHub;
use toolkit_db::Db;
use toolkit_db::secure::{SecureDeleteExt, SecureEntityExt, SecureInsertExt, SecureOnConflict};
use toolkit_security::{AccessScope, SecurityContext};
use uuid::Uuid;

use super::entity::clone_status as row;
use super::rest::StudioArtifactIngestError;

/// The longest detail kept: enough for a host's one-line answer.
const DETAIL_MAX: usize = 300;

/// Who cloned or fetched a source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloneChannel {
    /// A desktop, through Studio's Git remote (`studio-git`).
    Desktop,
    /// A portal IDE session: its clones through `studio-git` (#1095), and
    /// what its launch already knows.
    IdeSession,
}

impl CloneChannel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Desktop => "desktop",
            Self::IdeSession => "ide_session",
        }
    }
}

/// What fixes a failed clone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloneAction {
    /// Pick a connection for the source.
    Connect,
    /// Pick the source's connection again, or give it a token that works.
    Reconnect,
    /// Something only an organization admin can change.
    AskAdmin,
    /// The repository's name or URL is wrong, or the connection cannot see it.
    CheckRepository,
    /// Nothing is wrong on Studio's side; try again later.
    Retry,
}

impl CloneAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Connect => "connect",
            Self::Reconnect => "reconnect",
            Self::AskAdmin => "ask_admin",
            Self::CheckRepository => "check_repository",
            Self::Retry => "retry",
        }
    }

    /// The action in a sentence, for a reader without the portal's labels.
    pub fn text(self) -> &'static str {
        match self {
            Self::Connect => "Connect the source through one of the organization's connections.",
            Self::Reconnect => {
                "Reconnect the source: pick its connection again, or update the connection's token."
            }
            Self::AskAdmin => {
                "Ask an organization admin to connect the repository through the organization's own connection."
            }
            Self::CheckRepository => {
                "Check the repository's name and URL, and that the connection can see it."
            }
            Self::Retry => "Try again later; the repository's host did not answer.",
        }
    }
}

/// Why a clone failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloneCause {
    /// The source names no connection, and its host asked for credentials.
    NoConnection,
    /// The source names a connection that is not found from the project.
    ConnectionNotFound,
    /// The connection is one person's, and its token is not lent to others.
    ConnectionPersonal,
    /// The connection is held outside the project's organization.
    HeldOutside,
    /// The connection's token could not be read.
    TokenUnreadable,
    /// The host refused the token (401/403).
    ProviderRefused,
    /// The host says the repository does not exist (404).
    RepositoryNotFound,
    /// The host could not be reached.
    Unreachable,
    /// The host failed to answer (any other status).
    ProviderError,
    /// The source is not an http(s) repository.
    NotHttp,
}

impl CloneCause {
    const ALL: [Self; 10] = [
        Self::NoConnection,
        Self::ConnectionNotFound,
        Self::ConnectionPersonal,
        Self::HeldOutside,
        Self::TokenUnreadable,
        Self::ProviderRefused,
        Self::RepositoryNotFound,
        Self::Unreachable,
        Self::ProviderError,
        Self::NotHttp,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::NoConnection => "no_connection",
            Self::ConnectionNotFound => "connection_not_found",
            Self::ConnectionPersonal => "connection_personal",
            Self::HeldOutside => "held_outside",
            Self::TokenUnreadable => "token_unreadable",
            Self::ProviderRefused => "provider_refused",
            Self::RepositoryNotFound => "repository_not_found",
            Self::Unreachable => "unreachable",
            Self::ProviderError => "provider_error",
            Self::NotHttp => "not_http",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|c| c.as_str() == value)
    }

    /// What fixes it.
    pub fn action(self) -> CloneAction {
        match self {
            Self::NoConnection | Self::ConnectionPersonal => CloneAction::Connect,
            Self::ConnectionNotFound | Self::TokenUnreadable | Self::ProviderRefused => {
                CloneAction::Reconnect
            }
            Self::HeldOutside => CloneAction::AskAdmin,
            Self::RepositoryNotFound | Self::NotHttp => CloneAction::CheckRepository,
            Self::Unreachable | Self::ProviderError => CloneAction::Retry,
        }
    }

    /// The cause in a plain sentence.
    pub fn text(self) -> &'static str {
        match self {
            Self::NoConnection => {
                "The source names no connection, and the repository's host asked for credentials."
            }
            Self::ConnectionNotFound => {
                "The source's connection was not found, so it was cloned without a token."
            }
            Self::ConnectionPersonal => {
                "The source's connection is one person's, and its token is not lent to others."
            }
            Self::HeldOutside => {
                "The source's connection is held outside the organization, so its token is not used."
            }
            Self::TokenUnreadable => "The connection's token could not be read.",
            Self::ProviderRefused => "The repository's host refused the connection's token.",
            Self::RepositoryNotFound => "The repository's host answered that it does not exist.",
            Self::Unreachable => "The repository's host could not be reached.",
            Self::ProviderError => "The repository's host failed to answer.",
            Self::NotHttp => {
                "The source is not an http(s) repository, so it cannot be cloned through Studio."
            }
        }
    }
}

/// Why a clone failed, with what else is known.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloneFailure {
    pub cause: CloneCause,
    /// The source host's HTTP status, when it answered one.
    pub upstream_status: Option<u16>,
    /// Free text; [`redact`]ed before it is stored.
    pub detail: String,
}

impl CloneFailure {
    pub fn new(cause: CloneCause) -> Self {
        Self {
            cause,
            upstream_status: None,
            detail: String::new(),
        }
    }

    #[must_use]
    pub fn with_status(mut self, status: u16) -> Self {
        self.upstream_status = Some(status);
        self
    }

    #[must_use]
    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = detail.into();
        self
    }
}

/// One clone or fetch: `failure` is `None` when it went through.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloneOutcome {
    pub channel: CloneChannel,
    pub failure: Option<CloneFailure>,
}

impl CloneOutcome {
    pub fn cloned(channel: CloneChannel) -> Self {
        Self {
            channel,
            failure: None,
        }
    }

    pub fn failed(channel: CloneChannel, failure: CloneFailure) -> Self {
        Self {
            channel,
            failure: Some(failure),
        }
    }
}

/// `text` with every credential it could carry taken out: the user and
/// password of a URL (`https://user:token@host` → `https://***@host`), an
/// `Authorization` value, and the provider tokens recognisable by their
/// prefix. Then cut to [`DETAIL_MAX`] characters.
pub fn redact(text: &str) -> String {
    const TOKEN_PREFIXES: [&str; 7] = [
        "ghp_",
        "gho_",
        "ghu_",
        "ghs_",
        "ghr_",
        "github_pat_",
        "glpat-",
    ];
    let mut out: Vec<String> = Vec::new();
    let mut hide_next = false;
    for word in text.split(' ') {
        if hide_next {
            hide_next = false;
            out.push("***".to_owned());
            continue;
        }
        let lower = word.to_ascii_lowercase();
        if lower == "bearer" || lower == "basic" || lower == "token" {
            hide_next = true;
            out.push(word.to_owned());
            continue;
        }
        if TOKEN_PREFIXES.iter().any(|p| word.contains(p)) {
            out.push("***".to_owned());
            continue;
        }
        out.push(without_userinfo(word));
    }
    let joined = out.join(" ");
    let trimmed = joined.trim();
    if trimmed.chars().count() > DETAIL_MAX {
        let cut: String = trimmed.chars().take(DETAIL_MAX).collect();
        format!("{cut}…")
    } else {
        trimmed.to_owned()
    }
}

/// `scheme://user:pass@host/…` → `scheme://***@host/…`; anything else as is.
fn without_userinfo(word: &str) -> String {
    let Some(at) = word.find("://") else {
        return word.to_owned();
    };
    let (scheme, rest) = word.split_at(at + 3);
    let authority_end = rest.find('/').unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    match authority.rfind('@') {
        Some(user_end) => format!(
            "{scheme}***@{}{}",
            &authority[user_end + 1..],
            &rest[authority_end..]
        ),
        None => word.to_owned(),
    }
}

/// The last outcome of one source, as stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LastClone {
    pub repository: String,
    pub at_ms: i64,
    pub channel: String,
    /// `None` when it was cloned.
    pub cause: Option<String>,
    pub upstream_status: Option<i32>,
    pub detail: String,
}

/// The Postgres half: one row per (project, repository).
pub struct CloneStatusStore {
    db: Db,
}

impl CloneStatusStore {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// Every stored outcome of the project's sources.
    pub async fn of_project(&self, project: Uuid) -> anyhow::Result<Vec<LastClone>> {
        let conn = self.db.conn()?;
        let rows = row::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(project))
            .all(&conn)
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| LastClone {
                repository: r.repository,
                at_ms: r.at_ms,
                channel: r.channel,
                cause: r.cause,
                upstream_status: r.upstream_status,
                detail: r.detail,
            })
            .collect())
    }

    async fn write(
        &self,
        project: Uuid,
        repository: String,
        outcome: CloneOutcome,
        at_ms: i64,
    ) -> anyhow::Result<()> {
        let conn = self.db.conn()?;
        let failure = outcome.failure;
        let model = row::ActiveModel {
            tenant_id: ActiveValue::Set(project),
            repository: ActiveValue::Set(repository),
            state: ActiveValue::Set(
                if failure.is_some() {
                    "failed"
                } else {
                    "cloned"
                }
                .to_owned(),
            ),
            at_ms: ActiveValue::Set(at_ms),
            channel: ActiveValue::Set(outcome.channel.as_str().to_owned()),
            cause: ActiveValue::Set(failure.as_ref().map(|f| f.cause.as_str().to_owned())),
            upstream_status: ActiveValue::Set(
                failure
                    .as_ref()
                    .and_then(|f| f.upstream_status)
                    .map(i32::from),
            ),
            detail: ActiveValue::Set(
                failure
                    .as_ref()
                    .map(|f| redact(&f.detail))
                    .unwrap_or_default(),
            ),
        };
        let on_conflict = SecureOnConflict::<row::Entity>::columns([
            row::Column::TenantId,
            row::Column::Repository,
        ])
        .update_columns([
            row::Column::State,
            row::Column::AtMs,
            row::Column::Channel,
            row::Column::Cause,
            row::Column::UpstreamStatus,
            row::Column::Detail,
        ])?;
        row::Entity::insert(model)
            .secure()
            .scope_unchecked(&AccessScope::for_tenant(project))?
            .on_conflict(on_conflict)
            .exec(&conn)
            .await?;
        Ok(())
    }
}

/// The writers' side, published on the client hub when the gear has its
/// database.
#[async_trait]
impl super::port::CloneOutcomes for CloneStatusStore {
    async fn record(
        &self,
        project: Uuid,
        clone_url: &str,
        outcome: CloneOutcome,
    ) -> anyhow::Result<()> {
        let Some(repository) = crate::project_sources::repository_key(clone_url) else {
            return Ok(());
        };
        self.write(project, repository, outcome, now_ms()).await
    }

    async fn clear_failure(
        &self,
        project: Uuid,
        clone_url: &str,
        channel: CloneChannel,
    ) -> anyhow::Result<()> {
        let Some(repository) = crate::project_sources::repository_key(clone_url) else {
            return Ok(());
        };
        let conn = self.db.conn()?;
        row::Entity::delete_many()
            .secure()
            .scope_with(&AccessScope::for_tenant(project))
            .filter(
                Condition::all()
                    .add(row::Column::Repository.eq(repository))
                    .add(row::Column::Channel.eq(channel.as_str()))
                    .add(row::Column::State.eq("failed")),
            )
            .exec(&conn)
            .await?;
        Ok(())
    }
}

fn now_ms() -> i64 {
    i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
    )
    .unwrap_or(0)
}

fn rfc3339(at_ms: i64) -> Option<String> {
    let at = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(at_ms) * 1_000_000).ok()?;
    at.format(&time::format_description::well_known::Rfc3339)
        .ok()
}

/* ── REST ── */

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

/// One project source and the last clone or fetch of it.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SourceCloneStatusDto {
    /// The source's clone URL as the project's config records it.
    pub clone_url: String,
    /// `owner/repo` on the provider.
    pub full_path: String,
    /// `cloned`, `failed` or `never` (nothing recorded yet).
    pub state: String,
    /// RFC 3339; absent when never.
    pub at: Option<String>,
    /// Who: `desktop` (Studio's Git remote) or `ide_session` (a portal IDE
    /// session's launch); absent when never.
    pub by: Option<String>,
    /// Why it failed: `no_connection`, `connection_not_found`,
    /// `connection_personal`, `held_outside`, `token_unreadable`,
    /// `provider_refused`, `repository_not_found`, `unreachable`,
    /// `provider_error` or `not_http`. Absent unless failed.
    pub cause: Option<String>,
    /// The cause in a plain sentence.
    pub cause_text: Option<String>,
    /// What fixes it: `connect`, `reconnect`, `ask_admin`,
    /// `check_repository` or `retry`. Absent unless failed.
    pub action: Option<String>,
    /// The action in a plain sentence.
    pub action_text: Option<String>,
    /// The source host's HTTP status, when it answered one.
    pub upstream_status: Option<u16>,
    /// What else is known, with every credential taken out.
    pub detail: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SourceCloneStatusListDto {
    pub items: Vec<SourceCloneStatusDto>,
    pub total: u32,
}

#[derive(Debug, serde::Deserialize)]
pub struct CloneStatusQuery {
    pub project_id: String,
}

/// The source's row as the API shows it: `never` without a stored outcome.
pub fn status_of(
    source: &crate::project_sources::ProjectSource,
    last: Option<&LastClone>,
) -> SourceCloneStatusDto {
    let mut dto = SourceCloneStatusDto {
        clone_url: source.clone_url.clone(),
        full_path: source.full_path.clone(),
        state: "never".to_owned(),
        at: None,
        by: None,
        cause: None,
        cause_text: None,
        action: None,
        action_text: None,
        upstream_status: None,
        detail: None,
    };
    let Some(last) = last else {
        return dto;
    };
    dto.at = rfc3339(last.at_ms);
    dto.by = Some(last.channel.clone());
    match last.cause.as_deref() {
        None => dto.state = "cloned".to_owned(),
        Some(raw) => {
            dto.state = "failed".to_owned();
            dto.cause = Some(raw.to_owned());
            if let Some(cause) = CloneCause::parse(raw) {
                dto.cause_text = Some(cause.text().to_owned());
                dto.action = Some(cause.action().as_str().to_owned());
                dto.action_text = Some(cause.action().text().to_owned());
            }
            dto.upstream_status = last.upstream_status.and_then(|s| u16::try_from(s).ok());
            dto.detail = Some(last.detail.clone()).filter(|d| !d.is_empty());
        }
    }
    dto
}

/// The rows of `sources`, in their order, each with its stored outcome.
pub fn statuses(
    sources: &[crate::project_sources::ProjectSource],
    stored: &[LastClone],
) -> Vec<SourceCloneStatusDto> {
    sources
        .iter()
        .map(|source| {
            let key = crate::project_sources::repository_key(&source.clone_url);
            let last = key
                .as_deref()
                .and_then(|key| stored.iter().find(|s| s.repository == key));
            status_of(source, last)
        })
        .collect()
}

#[derive(Clone)]
struct CloneStatusApi {
    /// `None` = the gear has no database; the route answers 503.
    store: Option<Arc<CloneStatusStore>>,
    hub: Arc<ClientHub>,
}

/// GET /studio-artifact-ingest/v1/sources/clone-status?project_id=
async fn list_clone_status(
    Extension(ctx): Extension<SecurityContext>,
    Extension(api): Extension<CloneStatusApi>,
    Query(query): Query<CloneStatusQuery>,
) -> ApiResult<JsonBody<SourceCloneStatusListDto>> {
    let project = Uuid::parse_str(query.project_id.trim()).map_err(|_| {
        StudioArtifactIngestError::invalid_argument()
            .with_field_violation("project_id", "must name a project".to_owned(), "INVALID")
            .create()
    })?;
    let store = api.store.as_ref().ok_or_else(|| {
        CanonicalError::service_unavailable()
            .with_detail(
                "clone status is not available in this deployment \
                 (studio-artifact-ingest has no database configured)",
            )
            .create()
    })?;
    let am = api
        .hub
        .get::<dyn account_management_sdk::AccountManagementClient>()
        .map_err(|_| {
            CanonicalError::service_unavailable()
                .with_detail("account-management is not available")
                .create()
        })?;
    // Reading the project's config as the caller IS the access decision.
    let sources = crate::project_sources::read_checked(am.as_ref(), &ctx, project)
        .await
        .map_err(|why| CanonicalError::internal(why).create())?
        .ok_or_else(|| {
            StudioArtifactIngestError::not_found(format!("project {project} is not found"))
                .with_resource(project.to_string())
                .create()
        })?;
    let stored = store
        .of_project(project)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    let items = statuses(&sources, &stored);
    let total = u32::try_from(items.len()).unwrap_or(u32::MAX);
    Ok(Json(SourceCloneStatusListDto { items, total }))
}

pub fn register_routes(
    router: Router,
    openapi: &dyn OpenApiRegistry,
    store: Option<Arc<CloneStatusStore>>,
    hub: Arc<ClientHub>,
) -> Router {
    let router = OperationBuilder::get("/studio-artifact-ingest/v1/sources/clone-status")
        .operation_id("studio_artifact_ingest.list_source_clone_status")
        .summary("Whether each of a project's repositories could be cloned, and why not")
        .description(
            "One item per source in the project's config, in its order: the last clone \
             or fetch of it — `cloned`, `failed` or `never` — with when and by what \
             (`desktop`: through Studio's Git remote; `ide_session`: a portal IDE \
             session's launch), and for a failure its `cause` and the `action` that fixes \
             it. The server's own sync is not repeated here: it is the repository's \
             `synced_at`. 404 when the project is not the caller's to reach; 503 where \
             the gear has no database.",
        )
        .tag("StudioArtifactIngest")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project whose sources to report")
        .handler(list_clone_status)
        .json_response_with_schema::<SourceCloneStatusListDto>(
            openapi,
            StatusCode::OK,
            "The sources' clone status",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);
    router.layer(Extension(CloneStatusApi { store, hub }))
}

#[cfg(test)]
#[path = "clone_status_tests.rs"]
mod tests;
