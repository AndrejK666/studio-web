//! The spec-graph service's REST API, as this gear calls it (its contract is
//! the service's `GET /v1/openapi.json`).
//!
//! Every call carries the service's own key. A call that reads the project's
//! repository also carries the caller's `Authorization` header as
//! `X-Repository-Authorization`: the service fetches the project's sources
//! through this backend's Git proxy with it, once, and keeps nothing. A long
//! job is a run on the service; `Idempotency-Key` is passed through.

use axum::http::HeaderValue;
use reqwest::{Method, StatusCode};
use serde_json::Value;

/// What went wrong talking to the service, kept apart so the routes can answer
/// in their own words.
#[derive(Debug)]
pub enum UpstreamError {
    /// The gear has no URL or no key.
    Unconfigured(&'static str),
    /// The service could not be reached, or answered 5xx.
    Unavailable(String),
    /// The service answered 4xx: its status and its message.
    Refused(u16, String),
}

impl std::fmt::Display for UpstreamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unconfigured(what) => {
                write!(f, "the spec-graph service is not configured: set {what}")
            }
            Self::Unavailable(e) => write!(f, "the spec-graph service is unavailable: {e}"),
            Self::Refused(code, e) => write!(f, "the spec-graph service answered {code}: {e}"),
        }
    }
}

#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    base_url: String,
    secret: Option<String>,
}

/// Per call: the caller's header for the git remote, and an idempotency key.
#[derive(Default, Clone)]
pub struct CallHeaders {
    pub repository: Option<HeaderValue>,
    pub idempotency_key: Option<String>,
}

impl Client {
    pub fn new(http: reqwest::Client, base_url: String, secret: Option<String>) -> Self {
        Self {
            http,
            base_url,
            secret,
        }
    }

    /// One call: JSON in, JSON out (`Value::Null` for 204).
    pub async fn call(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<&Value>,
        headers: &CallHeaders,
    ) -> Result<Value, UpstreamError> {
        if self.base_url.is_empty() {
            return Err(UpstreamError::Unconfigured("STUDIO_SPEC_GRAPH_URL"));
        }
        let Some(secret) = self.secret.as_deref() else {
            return Err(UpstreamError::Unconfigured("STUDIO_SPEC_GRAPH_SECRET"));
        };
        let mut req = self
            .http
            .request(method, format!("{}{path}", self.base_url))
            .bearer_auth(secret)
            .query(query);
        if let Some(v) = &headers.repository {
            req = req.header("X-Repository-Authorization", v.clone());
        }
        if let Some(k) = &headers.idempotency_key {
            req = req.header("Idempotency-Key", k);
        }
        if let Some(b) = body {
            req = req.json(b);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| UpstreamError::Unavailable(e.to_string()))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| UpstreamError::Unavailable(e.to_string()))?;
        if status == StatusCode::NO_CONTENT || text.trim().is_empty() {
            return if status.is_success() {
                Ok(Value::Null)
            } else {
                Err(refusal(status, ""))
            };
        }
        if !status.is_success() {
            return Err(refusal(status, &text));
        }
        serde_json::from_str(&text).map_err(|e| {
            UpstreamError::Unavailable(format!("the answer is not JSON ({e}): {}", short(&text)))
        })
    }
}

fn short(s: &str) -> String {
    s.chars().take(300).collect()
}

fn refusal(status: StatusCode, text: &str) -> UpstreamError {
    // The service answers `{"error": "…"}`; anything else is passed on short.
    let msg = serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_else(|| short(text));
    if status.is_server_error() {
        UpstreamError::Unavailable(format!("{}: {msg}", status.as_u16()))
    } else {
        UpstreamError::Refused(status.as_u16(), msg)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_service_s_error_message_is_kept() {
        match refusal(
            StatusCode::BAD_REQUEST,
            r#"{"error": "base and head: the pull request's branches"}"#,
        ) {
            UpstreamError::Refused(400, m) => assert!(m.starts_with("base and head")),
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            refusal(StatusCode::BAD_GATEWAY, "upstream down"),
            UpstreamError::Unavailable(_)
        ));
    }

    #[tokio::test]
    async fn an_unconfigured_client_says_what_to_set() {
        let c = Client::new(reqwest::Client::new(), String::new(), None);
        let e = c
            .call(Method::GET, "/v1/info", &[], None, &CallHeaders::default())
            .await
            .unwrap_err();
        assert!(e.to_string().contains("STUDIO_SPEC_GRAPH_URL"));
        let c = Client::new(reqwest::Client::new(), "http://svc".into(), None);
        let e = c
            .call(Method::GET, "/v1/info", &[], None, &CallHeaders::default())
            .await
            .unwrap_err();
        assert!(e.to_string().contains("STUDIO_SPEC_GRAPH_SECRET"));
    }
}
