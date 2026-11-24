//! A scripted GitLab for the driver's tests.
//!
//! Each route is a method, an exact raw path (`/api/v4/projects/acme%2Fapp`,
//! so the encoding is checked too) and the query parts it must carry; it
//! answers its replies in order and repeats the last. Every request is kept,
//! so a test can say what was asked as well as what came back. `{base}` in a
//! reply's body or headers is this server's own address, for `Link` headers.

// Scaffolding: not every test reads every field it records.
#![allow(dead_code)]

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, Method, Response, Uri};
use serde_json::Value;

use super::super::driver::ConnectionAuth;
use super::GitLabDriver;
use super::client::Retry;

#[derive(Clone, Debug)]
pub(super) struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

impl Reply {
    pub fn json(v: Value) -> Self {
        Self {
            status: 200,
            headers: vec![("content-type".into(), "application/json".into())],
            body: v.to_string(),
        }
    }

    pub fn text(body: &str) -> Self {
        Self {
            status: 200,
            headers: vec![("content-type".into(), "text/plain".into())],
            body: body.into(),
        }
    }

    pub fn status(status: u16) -> Self {
        Self {
            status,
            headers: vec![("content-type".into(), "application/json".into())],
            body: format!("{{\"message\":\"{status}\"}}"),
        }
    }

    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    /// A `Link: <{base}{path_and_query}>; rel="next"` header.
    pub fn next(self, path_and_query: &str) -> Self {
        self.header("link", &format!("<{{base}}{path_and_query}>; rel=\"next\""))
    }
}

struct Route {
    method: Method,
    path: String,
    query: Vec<String>,
    replies: VecDeque<Reply>,
}

/// One request the server saw.
#[derive(Clone, Debug)]
pub(super) struct Seen {
    pub method: Method,
    pub path: String,
    pub query: String,
    pub token: Option<String>,
    pub body: Option<Value>,
}

#[derive(Default)]
pub(super) struct MockBuilder {
    routes: Vec<Route>,
}

impl MockBuilder {
    /// Answer `GET path` whatever its query.
    pub fn get(self, path: &str, reply: Reply) -> Self {
        self.route(Method::GET, path, "", reply)
    }

    /// Answer `GET path` only when its query carries every `&`-separated part
    /// of `query`.
    pub fn get_q(self, path: &str, query: &str, reply: Reply) -> Self {
        self.route(Method::GET, path, query, reply)
    }

    pub fn post(self, path: &str, reply: Reply) -> Self {
        self.route(Method::POST, path, "", reply)
    }

    pub fn route(mut self, method: Method, path: &str, query: &str, reply: Reply) -> Self {
        self.routes.push(Route {
            method,
            path: path.into(),
            query: query
                .split('&')
                .filter(|q| !q.is_empty())
                .map(str::to_owned)
                .collect(),
            replies: VecDeque::from([reply]),
        });
        self
    }

    /// One more reply for the route added last, after the ones it has.
    pub fn then(mut self, reply: Reply) -> Self {
        self.routes
            .last_mut()
            .expect("then() follows a route")
            .replies
            .push_back(reply);
        self
    }

    pub async fn start(self) -> Mock {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(Shared {
            base: base.clone(),
            routes: Mutex::new(self.routes),
            seen: Mutex::new(Vec::new()),
        });
        let app = Router::new().fallback(serve).with_state(Arc::clone(&state));
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Mock { base, state }
    }
}

struct Shared {
    base: String,
    routes: Mutex<Vec<Route>>,
    seen: Mutex<Vec<Seen>>,
}

async fn serve(
    State(state): State<Arc<Shared>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response<Body> {
    let path = uri.path().to_owned();
    let query = uri.query().unwrap_or_default().to_owned();
    state.seen.lock().unwrap().push(Seen {
        method: method.clone(),
        path: path.clone(),
        query: query.clone(),
        token: headers
            .get("private-token")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned),
        body: serde_json::from_slice(&body).ok(),
    });
    let parts: Vec<&str> = query.split('&').collect();
    let reply = {
        let mut routes = state.routes.lock().unwrap();
        routes
            .iter_mut()
            .find(|r| {
                r.method == method
                    && r.path == path
                    && r.query.iter().all(|q| parts.contains(&q.as_str()))
            })
            .map(|r| {
                if r.replies.len() > 1 {
                    r.replies.pop_front().unwrap()
                } else {
                    r.replies[0].clone()
                }
            })
    };
    let reply = reply.unwrap_or_else(|| Reply {
        status: 404,
        headers: vec![],
        body: format!("{{\"message\":\"404 no route for {method} {path}?{query}\"}}"),
    });
    let mut res = Response::builder().status(reply.status);
    for (k, v) in &reply.headers {
        res = res.header(k, v.replace("{base}", &state.base));
    }
    res.body(Body::from(reply.body.replace("{base}", &state.base)))
        .unwrap()
}

pub(super) struct Mock {
    pub base: String,
    state: Arc<Shared>,
}

impl Mock {
    pub fn builder() -> MockBuilder {
        MockBuilder::default()
    }

    pub fn seen(&self) -> Vec<Seen> {
        self.state.seen.lock().unwrap().clone()
    }

    /// The requests to `path`, in order.
    pub fn calls(&self, path: &str) -> Vec<Seen> {
        self.seen().into_iter().filter(|s| s.path == path).collect()
    }

    pub fn auth(&self) -> ConnectionAuth {
        ConnectionAuth {
            base_url: self.base.clone(),
            token: "glpat-test".into(),
        }
    }

    /// A driver that waits milliseconds between retries.
    pub fn driver(&self) -> GitLabDriver {
        GitLabDriver::with_retry(
            reqwest::Client::new(),
            Retry {
                attempts: 3,
                backoff: std::time::Duration::from_millis(5),
                max_wait: std::time::Duration::from_millis(50),
            },
        )
    }
}
