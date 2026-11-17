//! The gears-matcher service's API, as this gear calls it
//! (`gears-matcher/schemas/service/matcher-service.openapi.yaml`).
//!
//! Five calls: `GET /v1/info`, `POST /v1/runs` (with an `Idempotency-Key`),
//! `GET /v1/runs/{id}`, `GET /v1/runs/{id}/report` and
//! `POST /v1/runs/{id}/cancel`, each with the shared secret as a bearer. The
//! answers are kept as JSON: the report is the matcher's own document, which
//! this gear reads field by field (`report.rs`) rather than re-declares, so a
//! field it does not know is passed on, never refused.

use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;

use super::config::MatcherConfig;

/// What went wrong on the way to the matcher, by whose fault.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MatcherError {
    /// No address or no secret here.
    NotConfigured(String),
    /// No answer: DNS, connection, timeout.
    Transport(String),
    /// A non-2xx answer: the problem's stable `code` and its one-line
    /// `detail` (the service never puts a key or document text there).
    Upstream {
        status: u16,
        code: Option<String>,
        detail: String,
    },
}

impl MatcherError {
    /// Worth asking again later: no answer, too many runs at once, or the
    /// service's own trouble.
    pub fn is_transient(&self) -> bool {
        match self {
            Self::Transport(_) => true,
            Self::Upstream { status, .. } => *status == 429 || *status >= 500,
            Self::NotConfigured(_) => false,
        }
    }
}

impl std::fmt::Display for MatcherError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotConfigured(m) => f.write_str(m),
            Self::Transport(m) => write!(f, "the gears-matcher service did not answer: {m}"),
            Self::Upstream {
                status,
                code,
                detail,
            } => match code {
                Some(code) => write!(
                    f,
                    "the gears-matcher service answered {status} {code}: {detail}"
                ),
                None => write!(f, "the gears-matcher service answered {status}: {detail}"),
            },
        }
    }
}

impl std::error::Error for MatcherError {}

pub type Result<T> = std::result::Result<T, MatcherError>;

/// The service, as the gear needs it. A trait so the run can be tested on a
/// fake service.
#[async_trait]
pub trait Matcher: Send + Sync + 'static {
    /// What is missing to call it; `None` when it can be called.
    fn missing(&self) -> Option<String>;
    async fn info(&self) -> Result<Value>;
    /// Submit a run. The same `key` with the same body answers the same run.
    async fn submit(&self, key: &str, body: &Value) -> Result<Value>;
    async fn run(&self, id: &str) -> Result<Value>;
    async fn report(&self, id: &str) -> Result<Value>;
    async fn cancel(&self, id: &str) -> Result<Value>;
}

pub struct HttpMatcher {
    client: reqwest::Client,
    base_url: String,
    secret: Option<String>,
    missing: Option<String>,
}

impl HttpMatcher {
    pub fn from_config(cfg: &MatcherConfig) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(cfg.request_timeout_secs.max(5)))
            .build()
            .unwrap_or_default();
        Self {
            client,
            base_url: cfg.resolve_base_url(),
            secret: cfg.resolve_secret(),
            missing: cfg.missing(),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base_url)
    }

    fn ready(&self) -> Result<&str> {
        if let Some(why) = &self.missing {
            return Err(MatcherError::NotConfigured(why.clone()));
        }
        Ok(self.secret.as_deref().unwrap_or_default())
    }

    async fn send(&self, rb: reqwest::RequestBuilder) -> Result<Value> {
        let secret = self.ready()?;
        let res = rb
            .bearer_auth(secret)
            .send()
            .await
            .map_err(|e| MatcherError::Transport(e.without_url().to_string()))?;
        let status = res.status();
        let body: Value = res.json().await.unwrap_or(Value::Null);
        if status.is_success() {
            return Ok(body);
        }
        Err(problem(status.as_u16(), &body))
    }
}

/// An RFC 9457 problem as the service writes it: `code` and `detail`.
pub fn problem(status: u16, body: &Value) -> MatcherError {
    let text = |k: &str| body.get(k).and_then(Value::as_str).map(str::to_owned);
    MatcherError::Upstream {
        status,
        code: text("code"),
        detail: text("detail")
            .or_else(|| text("title"))
            .unwrap_or_else(|| "no detail".to_owned()),
    }
}

/// A run id as the service's path takes it (`^[A-Za-z0-9._-]{1,64}$`): the
/// id is the service's own, but it is put in a URL here, so it is checked.
fn run_path(id: &str) -> Result<String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if ok {
        Ok(format!("/v1/runs/{id}"))
    } else {
        Err(MatcherError::Upstream {
            status: 502,
            code: Some("bad_run_id".into()),
            detail: "the service named a run id that is not one".into(),
        })
    }
}

#[async_trait]
impl Matcher for HttpMatcher {
    fn missing(&self) -> Option<String> {
        self.missing.clone()
    }

    async fn info(&self) -> Result<Value> {
        self.send(self.client.get(self.url("/v1/info"))).await
    }

    async fn submit(&self, key: &str, body: &Value) -> Result<Value> {
        self.send(
            self.client
                .post(self.url("/v1/runs"))
                .header("Idempotency-Key", key)
                .json(body),
        )
        .await
    }

    async fn run(&self, id: &str) -> Result<Value> {
        let path = run_path(id)?;
        self.send(self.client.get(self.url(&path))).await
    }

    async fn report(&self, id: &str) -> Result<Value> {
        let path = run_path(id)?;
        self.send(self.client.get(self.url(&format!("{path}/report"))))
            .await
    }

    async fn cancel(&self, id: &str) -> Result<Value> {
        let path = run_path(id)?;
        self.send(self.client.post(self.url(&format!("{path}/cancel"))))
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_problem_reads_its_code_and_detail() {
        let e = problem(
            422,
            &json!({"type": "about:blank", "title": "Unprocessable", "status": 422,
                    "code": "not_a_template", "detail": "the documents are not in the spec format"}),
        );
        assert_eq!(
            e,
            MatcherError::Upstream {
                status: 422,
                code: Some("not_a_template".into()),
                detail: "the documents are not in the spec format".into()
            }
        );
        assert!(!e.is_transient());
        assert!(problem(429, &Value::Null).is_transient());
        assert!(problem(503, &Value::Null).is_transient());
    }

    #[test]
    fn a_run_id_is_checked_before_it_goes_into_a_path() {
        assert_eq!(run_path("r-1.a_b").unwrap(), "/v1/runs/r-1.a_b");
        assert!(run_path("../info").is_err());
        assert!(run_path("").is_err());
    }

    #[tokio::test]
    async fn an_unconfigured_matcher_is_refused_before_any_call() {
        let m = HttpMatcher::from_config(&MatcherConfig {
            base_url_env: "STUDIO_TEST_GM_CLIENT_URL_NONE".into(),
            secret_env: "STUDIO_TEST_GM_CLIENT_SECRET_NONE".into(),
            ..MatcherConfig::default()
        });
        assert!(matches!(
            m.info().await,
            Err(MatcherError::NotConfigured(_))
        ));
    }
}
