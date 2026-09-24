//! What the proxy decides without the network: which sources a workspace's
//! settings name, where a request goes upstream, and what credential it came
//! with. Kept apart from `rest` so each decision is a plain function with a test.

use base64::Engine;

/// The name the workspace's own repository (`root_repo_url`) is served under.
/// A leading underscore keeps it out of the way of a source named by a person,
/// and it still matches the `[a-z0-9_-]+` rule every source name follows.
pub const ROOT_SOURCE: &str = "_root";

/// One Git source of a workspace, as its settings record it.
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
}

fn text(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// Every Git source in a workspace settings document: the root repository
/// first, when there is one, then `repos` in order. A `local` source is a
/// folder on the backend host, so there is nothing to clone and it is left out;
/// so is an entry with no URL or with a name the rest of Studio would refuse.
pub fn sources_in(settings: &serde_json::Value) -> Vec<Source> {
    let mut out = Vec::new();
    if let Some(url) = text(settings, "root_repo_url") {
        out.push(Source {
            name: ROOT_SOURCE.to_owned(),
            url,
            branch: text(settings, "root_branch"),
            target: None,
            token_ref: text(settings, "root_token_ref"),
        });
    }
    let repos = settings
        .get("repos")
        .and_then(serde_json::Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    for repo in repos {
        if text(repo, "source").as_deref() == Some("local") {
            continue;
        }
        let (Some(name), Some(url)) = (text(repo, "name"), text(repo, "url")) else {
            continue;
        };
        if !valid_name(&name) || out.iter().any(|s: &Source| s.name == name) {
            continue;
        }
        out.push(Source {
            name,
            url,
            branch: text(repo, "branch"),
            target: text(repo, "target"),
            token_ref: text(repo, "token_ref"),
        });
    }
    out
}

/// The source-name rule `studio-session` enforces at launch.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
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
    use serde_json::json;

    #[test]
    fn the_root_repository_comes_first_under_its_reserved_name() {
        let got = sources_in(&json!({
            "root_repo_url": "https://example.com/acme/root.git",
            "root_branch": "main",
            "root_token_ref": "root-token",
            "repos": [{ "name": "api", "source": "github", "url": "https://github.com/acme/api" }]
        }));
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].name, ROOT_SOURCE);
        assert_eq!(got[0].branch.as_deref(), Some("main"));
        assert_eq!(got[0].token_ref.as_deref(), Some("root-token"));
        assert_eq!(got[1].name, "api");
    }

    #[test]
    fn a_local_folder_is_not_a_git_source() {
        let got = sources_in(&json!({
            "repos": [
                { "name": "here", "source": "local", "path": "/srv/here" },
                { "name": "there", "source": "git", "url": "https://example.com/there.git" }
            ]
        }));
        assert_eq!(
            got.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            ["there"]
        );
    }

    #[test]
    fn an_entry_studio_would_refuse_is_left_out() {
        let got = sources_in(&json!({
            "repos": [
                { "name": "Bad Name", "url": "https://example.com/a.git" },
                { "name": "nourl" },
                { "name": "dup", "url": "https://example.com/1.git" },
                { "name": "dup", "url": "https://example.com/2.git" }
            ]
        }));
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].url, "https://example.com/1.git");
    }

    #[test]
    fn settings_without_sources_have_none() {
        assert!(sources_in(&json!({})).is_empty());
        assert!(sources_in(&json!({ "repos": [], "root_repo_url": "  " })).is_empty());
    }

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
    fn only_the_two_git_services_are_known() {
        assert_eq!(Service::parse("git-upload-pack"), Some(Service::UploadPack));
        assert_eq!(
            Service::parse("git-receive-pack"),
            Some(Service::ReceivePack)
        );
        assert_eq!(Service::parse("git-upload-archive"), None);
    }
}
