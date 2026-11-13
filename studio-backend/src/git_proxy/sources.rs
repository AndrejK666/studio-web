//! What the proxy decides without the network: where a request goes upstream,
//! and what credential it came with. Kept apart from `rest` so each decision
//! is a plain function with a test. Which sources a project has is
//! `project_sources`.

use base64::Engine;

/// One Git source of a project, as a session or a desktop clones it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Source {
    pub name: String,
    /// The source host's clone URL. Never returned to a client.
    pub url: String,
    pub branch: Option<String>,
    /// Where the IDE checks it out, relative to the workspace root.
    pub target: Option<String>,
    /// credstore reference of the source host token. Never returned either.
    pub token_ref: Option<String>,
    /// The tenant holding the source's connection, when that is outside the
    /// project's organization (the platform's root, another organization):
    /// its token is not the organization's to use, so `token_ref` is `None`
    /// and the proxy refuses the source rather than reach the host as the
    /// platform (`cpt-studio-constraint-connector-own-connections`).
    pub held_outside: Option<uuid::Uuid>,
}

/// Where the proxy serves a workspace's source, gateway-rooted: what a
/// desktop's listing returns and what a session clones (#1095).
pub fn source_path(workspace_id: uuid::Uuid, name: &str) -> String {
    format!("/studio-git/v1/workspaces/{workspace_id}/sources/{name}")
}

/// Whether a presented token has the shape of a session's Git proxy
/// credential (#1095): 64 lowercase hex characters, as studio-session mints
/// it. A person's token is a JWT, with dots, so it is never mistaken for one,
/// and only a token of this shape is looked up among the sessions.
pub fn looks_like_session_credential(token: &str) -> bool {
    token.len() == 64
        && token
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Who a session's clone, fetch or push acts as (#1095): the session itself,
/// as a service, in the tenant its launcher was in, and only for the
/// workspace it was launched for. `None` for any other workspace: the
/// credential is that one session's, so another workspace is not there to it.
///
/// The scopes are the task worker's (`*`): what the session may reach is
/// still decided by the tenant clamp, and what it may read is the
/// workspace's sources, read under this context like a member's.
pub fn session_context(
    identity: &crate::studio_session::sdk::SessionIdentity,
    workspace_id: uuid::Uuid,
) -> Option<toolkit_security::SecurityContext> {
    if identity.workspace_id != workspace_id {
        return None;
    }
    toolkit_security::SecurityContext::builder()
        .subject_id(identity.session_id)
        .subject_type("service")
        .subject_tenant_id(identity.tenant_id)
        .token_scopes(vec!["*".to_owned()])
        .build()
        .ok()
}

/// The source a request names: one of the project's, else one of the
/// session's own extras (`true` in the answer). A project source wins a name
/// both have; the launch never gives an extra a project source's name.
pub fn pick(project: Vec<Source>, extras: Vec<Source>, name: &str) -> Option<(Source, bool)> {
    if let Some(found) = project.into_iter().find(|s| s.name == name) {
        return Some((found, false));
    }
    extras
        .into_iter()
        .find(|s| s.name == name)
        .map(|found| (found, true))
}

/// What the connection catalogue says about the key an extra source names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExtraKey {
    /// A connection of the organization holds it.
    Owned,
    /// A connection held outside the organization holds it.
    NotOwned(uuid::Uuid),
    /// No connection the workspace sees holds it.
    Unknown,
    /// The catalogue cannot be asked right now.
    Unavailable,
}

/// The refusal `git` prints for an extra source's key, or `None` to go on.
pub fn extra_key_refusal(verdict: ExtraKey) -> Option<(axum::http::StatusCode, String)> {
    match verdict {
        ExtraKey::Owned => None,
        ExtraKey::NotOwned(holder) => {
            Some((axum::http::StatusCode::FORBIDDEN, not_owned_text(holder)))
        }
        ExtraKey::Unknown => Some((
            axum::http::StatusCode::FORBIDDEN,
            "No connection of this organization holds the key this source was launched with; \
             connect the repository to the project, or relaunch without the key for a public one."
                .to_owned(),
        )),
        ExtraKey::Unavailable => Some((
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "Studio cannot check whose key this source uses right now; try again.".to_owned(),
        )),
    }
}

/// The two Git services the smart-HTTP protocol names in `info/refs`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Service {
    UploadPack,
    ReceivePack,
}

impl Service {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "git-upload-pack" => Some(Self::UploadPack),
            "git-receive-pack" => Some(Self::ReceivePack),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::UploadPack => "git-upload-pack",
            Self::ReceivePack => "git-receive-pack",
        }
    }
}

/// The upstream URL for one protocol request: the source's clone URL with the
/// protocol path appended, exactly as `git` itself would build it.
///
/// Only `http(s)` is served. An `ssh://` or `git@host:` source cannot be
/// proxied over HTTP, and a `file://` one would let a workspace setting read
/// the backend's own disk.
pub fn upstream_url(clone_url: &str, protocol_path: &str) -> Option<String> {
    let base = clone_url.trim().trim_end_matches('/');
    let lower = base.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return None;
    }
    Some(format!("{base}/{protocol_path}"))
}

/// The Studio token a Git request carries: the password of Basic credentials
/// (what a credential helper hands `git`), or a Bearer token (what
/// `http.extraHeader` sends). The Basic user name is ignored.
pub fn presented_token(authorization: Option<&str>) -> Option<String> {
    let value = authorization?.trim();
    if let Some(token) = value.strip_prefix("Bearer ") {
        let token = token.trim();
        return (!token.is_empty()).then(|| token.to_owned());
    }
    let encoded = value.strip_prefix("Basic ")?.trim();
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    let decoded = String::from_utf8(decoded).ok()?;
    let (_, password) = decoded.split_once(':')?;
    (!password.is_empty()).then(|| password.to_owned())
}

/// What `git` prints for a source whose connection is held outside the
/// project's organization ([`Source::held_outside`]).
pub fn not_owned_text(holder: uuid::Uuid) -> String {
    use crate::connectors::sdk::ownership::{CONNECTION_NOT_OWNED, NOT_OWNED_HINT, whose};
    format!(
        "{CONNECTION_NOT_OWNED}: this source's connection is held by {}, outside the project's organization. {NOT_OWNED_HINT}",
        whose(holder)
    )
}

/// Basic credentials for the source host: the token as the password, the way
/// the session container's credential helper presents it.
pub fn upstream_authorization(token: &str) -> String {
    let pair = format!("oauth2:{token}");
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(pair)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_protocol_path_is_appended_like_git_does() {
        assert_eq!(
            upstream_url("https://example.com/acme/api.git/", "info/refs").as_deref(),
            Some("https://example.com/acme/api.git/info/refs")
        );
    }

    #[test]
    fn only_http_sources_are_proxied() {
        assert_eq!(
            upstream_url("git@github.com:acme/api.git", "info/refs"),
            None
        );
        assert_eq!(upstream_url("ssh://github.com/acme/api", "info/refs"), None);
        assert_eq!(upstream_url("file:///etc", "info/refs"), None);
    }

    #[test]
    fn only_a_minted_shape_is_taken_for_a_session_credential() {
        let minted = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        assert!(looks_like_session_credential(&minted));
        for not in [
            "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln",
            "",
            &minted[..63],
            &minted.to_uppercase(),
            &format!("{minted}0"),
        ] {
            assert!(!looks_like_session_credential(not), "{not}");
        }
    }

    #[test]
    fn a_session_acts_for_its_own_workspace_only_and_as_a_service() {
        let identity = crate::studio_session::sdk::SessionIdentity {
            session_id: uuid::Uuid::from_u128(0x5e5),
            tenant_id: uuid::Uuid::from_u128(0x0a),
            workspace_id: uuid::Uuid::from_u128(0xb0),
        };
        let ctx = session_context(&identity, uuid::Uuid::from_u128(0xb0)).expect("its workspace");
        assert_eq!(ctx.subject_id(), identity.session_id);
        assert_eq!(ctx.subject_tenant_id(), identity.tenant_id);
        assert_eq!(ctx.subject_type(), Some("service"));
        assert!(ctx.bearer_token().is_none(), "no person's token travels");
        assert!(session_context(&identity, uuid::Uuid::from_u128(0xb1)).is_none());
    }

    fn src(name: &str, token_ref: Option<&str>) -> Source {
        Source {
            name: name.to_owned(),
            url: format!("https://github.com/acme/{name}"),
            branch: None,
            target: None,
            token_ref: token_ref.map(str::to_owned),
            held_outside: None,
        }
    }

    #[test]
    fn a_project_source_is_found_before_a_sessions_extra() {
        let project = vec![src("api", Some("ref-api"))];
        let extras = vec![
            src("_root", Some("ref-root")),
            src("gears-rust", None),
            src("api", Some("ref-other")),
        ];
        let (api, extra) = pick(project.clone(), extras.clone(), "api").expect("api");
        assert!(!extra);
        assert_eq!(api.token_ref.as_deref(), Some("ref-api"));
        let (root, extra) = pick(project.clone(), extras.clone(), "_root").expect("root");
        assert!(extra);
        assert_eq!(root.token_ref.as_deref(), Some("ref-root"));
        let (corpus, extra) = pick(project.clone(), extras.clone(), "gears-rust").expect("corpus");
        assert!(extra && corpus.token_ref.is_none());
        assert!(pick(project, extras, "elsewhere").is_none());
        assert!(
            pick(vec![], vec![], "_root").is_none(),
            "a member has no extras"
        );
    }

    #[test]
    fn an_extras_key_is_lent_only_when_the_organization_holds_it() {
        assert_eq!(extra_key_refusal(ExtraKey::Owned), None);
        let holder = uuid::Uuid::from_u128(0x1);
        let (status, text) = extra_key_refusal(ExtraKey::NotOwned(holder)).expect("refused");
        assert_eq!(status, axum::http::StatusCode::FORBIDDEN);
        assert_eq!(text, not_owned_text(holder), "says whose and what to do");
        let (status, text) = extra_key_refusal(ExtraKey::Unknown).expect("refused");
        assert_eq!(status, axum::http::StatusCode::FORBIDDEN);
        assert!(
            text.contains("No connection of this organization"),
            "{text}"
        );
        let (status, _) = extra_key_refusal(ExtraKey::Unavailable).expect("refused");
        assert_eq!(status, axum::http::StatusCode::SERVICE_UNAVAILABLE);
    }

    #[test]
    fn the_token_is_the_basic_password() {
        let header = format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode("studio:tok-123")
        );
        assert_eq!(presented_token(Some(&header)).as_deref(), Some("tok-123"));
    }

    #[test]
    fn a_bearer_token_is_accepted_too() {
        assert_eq!(
            presented_token(Some("Bearer tok-456")).as_deref(),
            Some("tok-456")
        );
    }

    #[test]
    fn no_or_empty_credentials_present_no_token() {
        assert_eq!(presented_token(None), None);
        assert_eq!(presented_token(Some("Bearer  ")), None);
        let empty = format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode("studio:")
        );
        assert_eq!(presented_token(Some(&empty)), None);
        assert_eq!(presented_token(Some("Digest abc")), None);
    }

    #[test]
    fn a_source_held_outside_the_organization_says_whose_and_what_to_do() {
        let text = not_owned_text(uuid::Uuid::from_u128(1));
        assert!(text.starts_with("CONNECTION_NOT_OWNED"), "{text}");
        assert!(text.contains("the platform's root"), "{text}");
        assert!(text.contains("organization-scope connection of your own"));
    }

    #[test]
    fn only_the_two_git_services_are_known() {
        assert_eq!(Service::parse("git-upload-pack"), Some(Service::UploadPack));
        assert_eq!(
            Service::parse("git-receive-pack"),
            Some(Service::ReceivePack)
        );
        assert_eq!(Service::parse("git-upload-archive"), None);
    }
}
