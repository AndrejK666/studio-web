//! The HTTP side of the GitLab driver: one place that sends a request, waits
//! out a throttle, follows GitLab's pages and says what a refusal means.
//!
//! The rules are the ones Insight's GitLab connector learned in production
//! (`constructorfabric/insight`, `src/ingestion/connectors/git/gitlab`):
//!
//! - **Auth.** `PRIVATE-TOKEN` works for personal, group and project access
//!   tokens alike, on REST and on GraphQL.
//! - **Throttles.** A 429 carries `Retry-After` in seconds; it is honoured up
//!   to [`Retry::max_wait`]. A 5xx or a dropped connection backs off
//!   exponentially. Both give up after [`Retry::attempts`] retries.
//! - **Pages.** GitLab answers `Link: <…>; rel="next"` for offset and keyset
//!   pagination alike, so one walker serves both. The link is followed only
//!   on the installation's own origin: a reply must not be able to send the
//!   connection's token to another host.
//! - **Refusals** are classified by the kind of endpoint ([`Family`]): a
//!   refusal on a project's own listing is the connection's problem and fails
//!   the call; on one item inside it (a merge request's notes, a feature the
//!   edition is not licensed for) it is that item's, and the item is skipped.
//! - **GraphQL** answers 200 with an `errors` array, so the status alone never
//!   says a query worked.

use std::fmt;
use std::time::Duration;

use reqwest::header::HeaderMap;
use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;

use super::super::driver::ConnectionAuth;

/// What kind of endpoint a call is, which decides what a refusal means.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Family {
    /// The token, the project, or one of the project's own listings (issues,
    /// merge requests, commits, the tree). A refusal here is the
    /// connection's or the configuration's, and the call fails with it.
    Scope,
    /// One item inside a project: a merge request's notes or diffs, its
    /// approvals, a pipeline's jobs. 402, 403 and 404 are about that item --
    /// deleted, hidden from the token, or a feature this edition or project
    /// does not have (402 is GitLab's "not licensed") -- so it is skipped and
    /// the walk goes on.
    Item,
}

/// Why GitLab refused, as a type a caller can match on rather than a string
/// to search. The message still starts with `GitLab {status}` so that code
/// reading the text (clone causes, the registry) keeps working.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GitLabErrorKind {
    /// 401: the token was refused.
    Unauthorized,
    /// 403: the token may not do this -- read it, or write it (a protected
    /// branch refuses a push, a read-only token any write).
    Forbidden,
    /// 404: there is no such thing, or the token cannot see it.
    NotFound,
    /// 402: the edition is not licensed for the feature.
    NotLicensed,
    /// 429, still after every retry.
    RateLimited,
    /// 5xx, still after every retry, or no answer at all.
    Unavailable,
    /// 409: the write conflicts with what is there (a merge request already
    /// open for the branch, a ref moved meanwhile).
    Conflict,
    /// 400 or 422: GitLab refused the request as invalid (a file that already
    /// exists, a branch name it does not accept).
    Invalid,
    /// Any other status.
    Rejected,
    /// A GraphQL `errors` array inside an HTTP 200.
    GraphQl,
}

/// A refusal from GitLab.
#[derive(Clone, Debug)]
pub struct GitLabError {
    pub kind: GitLabErrorKind,
    /// The HTTP status, when GitLab answered one.
    pub status: Option<u16>,
    /// What GitLab said, cut short.
    pub detail: String,
}

impl GitLabError {
    fn from_status(status: StatusCode, body: &str) -> Self {
        let kind = match status.as_u16() {
            401 => GitLabErrorKind::Unauthorized,
            402 => GitLabErrorKind::NotLicensed,
            403 => GitLabErrorKind::Forbidden,
            404 => GitLabErrorKind::NotFound,
            409 => GitLabErrorKind::Conflict,
            400 | 422 => GitLabErrorKind::Invalid,
            429 => GitLabErrorKind::RateLimited,
            500..=599 => GitLabErrorKind::Unavailable,
            _ => GitLabErrorKind::Rejected,
        };
        Self {
            kind,
            status: Some(status.as_u16()),
            detail: body.chars().take(300).collect(),
        }
    }

    /// Whether GitLab's message says `needle` (case-insensitive): GitLab
    /// answers several different refusals with the same 400.
    pub fn says(&self, needle: &str) -> bool {
        self.detail.to_lowercase().contains(&needle.to_lowercase())
    }

    /// Whether this refusal is about one item rather than the connection:
    /// what [`Family::Item`] skips.
    pub fn is_item_refusal(&self) -> bool {
        matches!(
            self.kind,
            GitLabErrorKind::Forbidden | GitLabErrorKind::NotFound | GitLabErrorKind::NotLicensed
        )
    }
}

impl fmt::Display for GitLabError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let status = self
            .status
            .map(|s| s.to_string())
            .unwrap_or_else(|| "unreachable".into());
        let detail = &self.detail;
        match self.kind {
            GitLabErrorKind::Unauthorized => write!(
                f,
                "GitLab 401: the token was refused -- it needs the read_api and \
                 read_repository scopes ({detail})"
            ),
            GitLabErrorKind::Forbidden => write!(
                f,
                "GitLab 403: the token may not do this -- a protected branch, or a token \
                 without the api / write_repository scope for a write ({detail})"
            ),
            GitLabErrorKind::Conflict => write!(f, "GitLab 409: conflict ({detail})"),
            GitLabErrorKind::Invalid => {
                write!(f, "GitLab {status}: GitLab refused the request ({detail})")
            }
            GitLabErrorKind::NotFound => write!(
                f,
                "GitLab 404: not found, or not visible to this token ({detail})"
            ),
            GitLabErrorKind::NotLicensed => write!(
                f,
                "GitLab 402: this GitLab edition does not include the feature ({detail})"
            ),
            GitLabErrorKind::RateLimited => write!(
                f,
                "GitLab 429: the token is rate limited, still after retrying ({detail})"
            ),
            GitLabErrorKind::Unavailable => {
                write!(f, "GitLab {status}: the server failed to answer ({detail})")
            }
            GitLabErrorKind::Rejected => write!(f, "GitLab {status}: {detail}"),
            GitLabErrorKind::GraphQl => write!(f, "GitLab GraphQL error: {detail}"),
        }
    }
}

impl std::error::Error for GitLabError {}

/// How hard to try again.
#[derive(Clone, Debug)]
pub struct Retry {
    /// Retries after the first attempt.
    pub attempts: u32,
    /// The first back-off; each later one doubles it.
    pub backoff: Duration,
    /// The longest one wait may be, whatever `Retry-After` asks for. Studio
    /// reads on demand, so a ten-minute wait would only time the caller out.
    pub max_wait: Duration,
}

impl Default for Retry {
    fn default() -> Self {
        Self {
            attempts: 4,
            backoff: Duration::from_millis(500),
            max_wait: Duration::from_secs(60),
        }
    }
}

/// The installation root a connection's address names. Tolerates an address
/// typed with the API suffix (`https://gitlab.example/api/v4`), which is what
/// people copy out of GitLab's own docs.
pub(super) fn instance_root(base_url: &str) -> &str {
    let root = base_url.trim().trim_end_matches('/');
    root.strip_suffix("/api/v4")
        .or_else(|| root.strip_suffix("/api/graphql"))
        .unwrap_or(root)
        .trim_end_matches('/')
}

/// One connection's view of the API.
pub(super) struct Api<'a> {
    http: &'a reqwest::Client,
    retry: &'a Retry,
    root: String,
    token: &'a str,
}

/// One page of a listing, and where the next one is.
pub(super) struct Page<T> {
    pub items: Vec<T>,
    pub next: Option<String>,
}

impl<'a> Api<'a> {
    pub fn new(http: &'a reqwest::Client, retry: &'a Retry, auth: &'a ConnectionAuth) -> Self {
        Self {
            http,
            retry,
            root: instance_root(&auth.base_url).to_owned(),
            token: auth.token.trim(),
        }
    }

    /// The installation root, `https://gitlab.example`.
    pub fn root(&self) -> &str {
        &self.root
    }

    /// `{root}/api/v4/{path}`.
    pub fn v4(&self, path: &str) -> String {
        format!("{}/api/v4/{}", self.root, path.trim_start_matches('/'))
    }

    /// `{root}/api/v4/projects/{encoded path}{rest}`: a project is addressed
    /// by its full path, URL-encoded as one segment (`group%2Fsub%2Fproject`).
    pub fn project(&self, repo_full_path: &str, rest: &str) -> String {
        self.v4(&format!(
            "projects/{}{rest}",
            encode(project_path(repo_full_path))
        ))
    }

    /// Send one request, retrying a throttle, a server error and a dropped
    /// connection. Answers whatever status GitLab settled on.
    ///
    /// A write is retried only where GitLab cannot have done it: on 429 (the
    /// request was turned away) and on a connection that never opened. A 5xx
    /// or a connection lost mid-answer may have committed, so a write is not
    /// sent again; the caller's own idempotency (an existing branch holding
    /// the same files, an open merge request found) covers a retry by hand.
    async fn send(
        &self,
        method: Method,
        url: &str,
        body: Option<&serde_json::Value>,
    ) -> anyhow::Result<reqwest::Response> {
        self.send_on(self.http, method, url, body).await
    }

    async fn send_on(
        &self,
        http: &reqwest::Client,
        method: Method,
        url: &str,
        body: Option<&serde_json::Value>,
    ) -> anyhow::Result<reqwest::Response> {
        let idempotent = matches!(method, Method::GET | Method::HEAD)
            || (method == Method::POST && url.ends_with("/api/graphql"));
        let mut attempt = 0u32;
        loop {
            let mut rb = http
                .request(method.clone(), url)
                .header("Accept", "application/json")
                .header("User-Agent", "constructor-studio");
            // A public project is read without a token: GitLab answers an
            // empty PRIVATE-TOKEN with 401, and no header with the project.
            if !self.token.is_empty() {
                rb = rb.header("PRIVATE-TOKEN", self.token);
            }
            if let Some(body) = body {
                rb = rb.json(body);
            }
            let backoff = self.retry.backoff.saturating_mul(1 << attempt.min(16));
            match rb.send().await {
                Err(e) => {
                    if attempt >= self.retry.attempts || (!idempotent && !e.is_connect()) {
                        return Err(GitLabError {
                            kind: GitLabErrorKind::Unavailable,
                            status: None,
                            detail: format!("{e}"),
                        }
                        .into());
                    }
                    tracing::debug!(error = %e, url, attempt, "gitlab: request failed, retrying");
                    tokio::time::sleep(backoff.min(self.retry.max_wait)).await;
                }
                Ok(res) => {
                    let status = res.status();
                    let transient = status == StatusCode::TOO_MANY_REQUESTS
                        || (idempotent && matches!(status.as_u16(), 500 | 502 | 503 | 504));
                    if !transient || attempt >= self.retry.attempts {
                        return Ok(res);
                    }
                    let wait = retry_after(res.headers())
                        .unwrap_or(backoff)
                        .min(self.retry.max_wait);
                    tracing::debug!(%status, url, attempt, ?wait, "gitlab: throttled or failing, waiting");
                    tokio::time::sleep(wait).await;
                }
            }
            attempt += 1;
        }
    }

    /// A successful response, or the refusal as a [`GitLabError`].
    async fn ok(&self, url: &str) -> anyhow::Result<reqwest::Response> {
        let res = self.send(Method::GET, url, None).await?;
        let status = res.status();
        if status.is_success() {
            return Ok(res);
        }
        let body = res.text().await.unwrap_or_default();
        Err(GitLabError::from_status(status, &body).into())
    }

    /// A write (`POST`, `PUT`, `DELETE`) with a JSON body, decoded; the
    /// refusal as a [`GitLabError`].
    pub async fn write<T: DeserializeOwned>(
        &self,
        method: Method,
        url: &str,
        body: &serde_json::Value,
    ) -> anyhow::Result<T> {
        let res = self.send(method, url, Some(body)).await?;
        let status = res.status();
        if !status.is_success() {
            let text = res.text().await.unwrap_or_default();
            return Err(GitLabError::from_status(status, &text).into());
        }
        Ok(res.json().await?)
    }

    /// A GET that does not follow a redirect: a download GitLab hands to
    /// object storage answers 302 to a signed link, and following it would
    /// pull the file through Studio -- with the token, which reqwest only
    /// strips from `Authorization`, not from `PRIVATE-TOKEN`.
    pub async fn get_unfollowed(&self, url: &str) -> anyhow::Result<reqwest::Response> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        let res = self.send_on(&client, Method::GET, url, None).await?;
        let status = res.status();
        if status.is_success() || status.is_redirection() {
            return Ok(res);
        }
        let body = res.text().await.unwrap_or_default();
        Err(GitLabError::from_status(status, &body).into())
    }

    /// GET and decode.
    pub async fn get<T: DeserializeOwned>(&self, url: &str) -> anyhow::Result<T> {
        let res = self.ok(url).await?;
        Ok(res.json().await?)
    }

    /// GET and decode, `None` for a 404: the answer to "is there one?".
    pub async fn get_opt<T: DeserializeOwned>(&self, url: &str) -> anyhow::Result<Option<T>> {
        match self.ok(url).await {
            Ok(res) => Ok(Some(res.json().await?)),
            Err(e) if kind_of(&e) == Some(GitLabErrorKind::NotFound) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// The raw body and headers, `None` for a 404.
    pub async fn get_raw(&self, url: &str) -> anyhow::Result<Option<(HeaderMap, Vec<u8>)>> {
        match self.ok(url).await {
            Ok(res) => {
                let headers = res.headers().clone();
                Ok(Some((headers, res.bytes().await?.to_vec())))
            }
            Err(e) if kind_of(&e) == Some(GitLabErrorKind::NotFound) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// One page of a listing, and the link to the next.
    pub async fn page<T: DeserializeOwned>(
        &self,
        url: &str,
        family: Family,
    ) -> anyhow::Result<Option<Page<T>>> {
        let res = match self.ok(url).await {
            Ok(res) => res,
            Err(e) if family == Family::Item && is_item_refusal(&e) => {
                tracing::debug!(url, error = %e, "gitlab: item not readable, skipped");
                return Ok(None);
            }
            Err(e) => return Err(e),
        };
        let next = next_link(res.headers()).filter(|n| self.same_origin(n));
        let items: Vec<T> = res.json().await?;
        Ok(Some(Page { items, next }))
    }

    /// Every page of a listing, up to `max_pages`; `true` when the walk was
    /// cut short by the cap. A [`Family::Item`] listing the token cannot read
    /// is empty.
    pub async fn walk<T: DeserializeOwned>(
        &self,
        first: &str,
        family: Family,
        max_pages: u32,
    ) -> anyhow::Result<(Vec<T>, bool)> {
        let mut out = Vec::new();
        let mut url = first.to_owned();
        for _ in 0..max_pages.max(1) {
            let Some(page) = self.page::<T>(&url, family).await? else {
                return Ok((out, false));
            };
            out.extend(page.items);
            match page.next {
                Some(next) => url = next,
                None => return Ok((out, false)),
            }
        }
        Ok((out, true))
    }

    /// One GraphQL query's `data`. An `errors` array is an error even though
    /// the status is 200; one that says the token is rate limited is waited
    /// out like a 429.
    pub async fn graphql<T: DeserializeOwned>(
        &self,
        query: &str,
        variables: serde_json::Value,
    ) -> anyhow::Result<T> {
        let body = serde_json::json!({ "query": query, "variables": variables });
        let mut attempt = 0u32;
        loop {
            let reply = self.graphql_raw(&body).await?;
            let errors: Vec<String> = reply
                .get("errors")
                .and_then(serde_json::Value::as_array)
                .map(|errs| {
                    errs.iter()
                        .map(|e| {
                            e.get("message")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or("unknown error")
                                .to_owned()
                        })
                        .collect()
                })
                .unwrap_or_default();
            if errors.is_empty() {
                let data = reply.get("data").cloned().unwrap_or_default();
                return Ok(serde_json::from_value(data)?);
            }
            let joined = errors.join("; ");
            if joined.to_lowercase().contains("rate limit") && attempt < self.retry.attempts {
                let wait = self
                    .retry
                    .backoff
                    .saturating_mul(1 << attempt.min(16))
                    .min(self.retry.max_wait);
                tokio::time::sleep(wait).await;
                attempt += 1;
                continue;
            }
            return Err(GitLabError {
                kind: GitLabErrorKind::GraphQl,
                status: Some(200),
                detail: joined.chars().take(300).collect(),
            }
            .into());
        }
    }

    /// One GraphQL request, answered as GitLab sent it.
    pub async fn graphql_raw(&self, body: &serde_json::Value) -> anyhow::Result<serde_json::Value> {
        let url = format!("{}/api/graphql", self.root);
        let res = self.send(Method::POST, &url, Some(body)).await?;
        let status = res.status();
        if !status.is_success() {
            let text = res.text().await.unwrap_or_default();
            return Err(GitLabError::from_status(status, &text).into());
        }
        Ok(res.json().await?)
    }

    /// Whether `url` is on this installation: scheme, host and port.
    pub fn same_origin(&self, url: &str) -> bool {
        let (Ok(a), Ok(b)) = (reqwest::Url::parse(url), reqwest::Url::parse(&self.root)) else {
            return false;
        };
        let same = a.scheme() == b.scheme()
            && a.host_str() == b.host_str()
            && a.port_or_known_default() == b.port_or_known_default();
        if !same {
            tracing::warn!(
                next = url,
                "gitlab: a next-page link points off the installation; not followed"
            );
        }
        same
    }
}

/// The kind of a GitLab refusal inside an error chain.
pub(super) fn kind_of(e: &anyhow::Error) -> Option<GitLabErrorKind> {
    e.downcast_ref::<GitLabError>().map(|g| g.kind)
}

/// Whether an error is a refusal about one item ([`GitLabError::is_item_refusal`]).
pub(super) fn is_item_refusal(e: &anyhow::Error) -> bool {
    e.downcast_ref::<GitLabError>()
        .is_some_and(GitLabError::is_item_refusal)
}

/// `Retry-After` in seconds. The HTTP-date form is not one GitLab sends; it
/// falls back to the exponential back-off.
fn retry_after(headers: &HeaderMap) -> Option<Duration> {
    headers
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()
        .map(Duration::from_secs)
}

/// The `rel="next"` target of a `Link` header.
pub(super) fn next_link(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(reqwest::header::LINK)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .find_map(|part| {
            let mut pieces = part.split(';');
            let target = pieces.next()?.trim();
            let is_next = pieces.any(|p| {
                let p = p.trim().replace(' ', "");
                p == "rel=\"next\"" || p == "rel=next"
            });
            let url = target.strip_prefix('<')?.strip_suffix('>')?;
            is_next.then(|| url.to_owned())
        })
}

/// A project path as GitLab names it: no surrounding slashes, no `.git`.
pub(super) fn project_path(repo_full_path: &str) -> &str {
    let p = repo_full_path.trim().trim_matches('/');
    p.strip_suffix(".git").unwrap_or(p)
}

/// Percent-encoding for one path segment or query value: everything but the
/// unreserved characters, `/` included.
pub(super) fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::{HeaderValue, LINK};

    #[test]
    fn the_next_link_is_found_among_the_others() {
        let mut h = HeaderMap::new();
        h.insert(
            LINK,
            HeaderValue::from_static(
                "<https://g.example/api/v4/x?page=1>; rel=\"first\", \
                 <https://g.example/api/v4/x?page=3>; rel=\"next\", \
                 <https://g.example/api/v4/x?page=9>; rel=\"last\"",
            ),
        );
        assert_eq!(
            next_link(&h).as_deref(),
            Some("https://g.example/api/v4/x?page=3")
        );
        assert_eq!(next_link(&HeaderMap::new()), None);
    }

    #[test]
    fn a_project_path_is_one_encoded_segment() {
        assert_eq!(
            encode(project_path("/group/sub/app.git")),
            "group%2Fsub%2Fapp"
        );
        assert_eq!(encode("a b&c"), "a%20b%26c");
    }

    #[test]
    fn an_address_typed_with_the_api_suffix_names_the_installation() {
        assert_eq!(
            instance_root("https://g.example/api/v4/"),
            "https://g.example"
        );
        assert_eq!(
            instance_root("https://g.example/gitlab"),
            "https://g.example/gitlab"
        );
        assert_eq!(instance_root("https://gitlab.com"), "https://gitlab.com");
    }

    #[test]
    fn a_refusal_keeps_its_status_in_the_text_and_its_kind_in_the_type() {
        let e = GitLabError::from_status(StatusCode::UNAUTHORIZED, "401 Unauthorized");
        assert_eq!(e.kind, GitLabErrorKind::Unauthorized);
        let text = e.to_string();
        assert!(text.starts_with("GitLab 401"), "{text}");
        assert!(text.contains("read_api"), "{text}");
        assert!(GitLabError::from_status(StatusCode::PAYMENT_REQUIRED, "").is_item_refusal());
        assert!(!GitLabError::from_status(StatusCode::UNAUTHORIZED, "").is_item_refusal());
    }
}
