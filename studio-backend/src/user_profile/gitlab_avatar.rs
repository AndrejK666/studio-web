//! The photo a GitLab account already has, for a person who signed in
//! through GitLab or proved a GitLab account.
//!
//! GitHub serves an account's picture at an address made from its id, so the
//! GitHub sign-in takes it without a call. GitLab's lives at an upload path
//! no id predicts, so it is asked for: `GET /api/v4/users/{id}` by the
//! account's numeric id, which survives a rename, or `GET
//! /api/v4/users?username=` by its handle when no id is known. Both are
//! public for a public profile and need no token. Best effort: no answer in a
//! few seconds, a private profile or no picture leaves the profile as it is,
//! and sign-in never waits on more than that.

use std::time::Duration;

use serde::Deserialize;

/// How long the lookup may take: it runs while a person's profile is being
/// filled, and a photo is never worth holding that up.
const TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Deserialize)]
struct GitLabUser {
    #[serde(default)]
    username: String,
    #[serde(default)]
    avatar_url: Option<String>,
}

/// The GitLab account's picture: by `account_id` when it is GitLab's numeric
/// id, else by `username`. `base` is the GitLab's address (`https://gitlab.com`,
/// or a self-hosted one; an `/api/v4` suffix is tolerated). `Ok(None)` when
/// the account has none, is not public, or is not there.
pub(crate) async fn avatar_url(
    http: &reqwest::Client,
    base: &str,
    account_id: Option<&str>,
    username: &str,
) -> anyhow::Result<Option<String>> {
    let root = base.trim().trim_end_matches('/');
    let root = root.strip_suffix("/api/v4").unwrap_or(root);
    let id = account_id
        .map(str::trim)
        .filter(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()));
    let username = username.trim();
    let user = match id {
        Some(id) => {
            let res = http
                .get(format!("{root}/api/v4/users/{id}"))
                .timeout(TIMEOUT)
                .send()
                .await?;
            if !res.status().is_success() {
                return Ok(None);
            }
            Some(res.json::<GitLabUser>().await?)
        }
        None if !username.is_empty() => {
            let res = http
                .get(format!("{root}/api/v4/users"))
                .query(&[("username", username)])
                .timeout(TIMEOUT)
                .send()
                .await?;
            if !res.status().is_success() {
                return Ok(None);
            }
            res.json::<Vec<GitLabUser>>()
                .await?
                .into_iter()
                .find(|u| u.username.eq_ignore_ascii_case(username))
        }
        None => None,
    };
    Ok(user
        .and_then(|u| u.avatar_url)
        .map(|u| u.trim().to_owned())
        .filter(|u| u.starts_with("https://") || u.starts_with("http://")))
}

#[cfg(test)]
mod tests {
    use axum::extract::{Path, Query};
    use axum::routing::get;
    use axum::{Json, Router};
    use serde_json::{Value, json};

    use super::*;

    async fn gitlab() -> String {
        async fn by_id(Path(id): Path<String>) -> axum::response::Response {
            use axum::response::IntoResponse;
            match id.as_str() {
                "7" => Json(json!({
                    "id": 7, "username": "ada",
                    "avatar_url": "https://gitlab.example/uploads/-/system/user/avatar/7/a.png"
                }))
                .into_response(),
                "8" => {
                    Json(json!({ "id": 8, "username": "bob", "avatar_url": null })).into_response()
                }
                _ => axum::http::StatusCode::NOT_FOUND.into_response(),
            }
        }
        async fn by_name(
            Query(q): Query<std::collections::HashMap<String, String>>,
        ) -> Json<Value> {
            match q.get("username").map(String::as_str) {
                Some("carol") => Json(json!([
                    { "username": "carol2", "avatar_url": "https://wrong.example/x.png" },
                    { "username": "Carol", "avatar_url": "https://gitlab.example/c.png" }
                ])),
                _ => Json(json!([])),
            }
        }
        let app = Router::new()
            .route("/api/v4/users/{id}", get(by_id))
            .route("/api/v4/users", get(by_name));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn the_picture_is_found_by_id_first_and_by_handle_without_one() {
        let base = gitlab().await;
        let http = reqwest::Client::new();
        assert_eq!(
            avatar_url(&http, &base, Some("7"), "renamed")
                .await
                .unwrap()
                .as_deref(),
            Some("https://gitlab.example/uploads/-/system/user/avatar/7/a.png")
        );
        assert_eq!(
            avatar_url(&http, &format!("{base}/api/v4/"), None, "carol")
                .await
                .unwrap()
                .as_deref(),
            Some("https://gitlab.example/c.png")
        );
    }

    #[tokio::test]
    async fn no_picture_no_account_or_a_private_one_is_none_not_an_error() {
        let base = gitlab().await;
        let http = reqwest::Client::new();
        assert_eq!(
            avatar_url(&http, &base, Some("8"), "bob").await.unwrap(),
            None
        );
        assert_eq!(
            avatar_url(&http, &base, Some("9"), "x").await.unwrap(),
            None
        );
        assert_eq!(
            avatar_url(&http, &base, None, "nobody").await.unwrap(),
            None
        );
        assert_eq!(avatar_url(&http, &base, None, " ").await.unwrap(), None);
    }
}
