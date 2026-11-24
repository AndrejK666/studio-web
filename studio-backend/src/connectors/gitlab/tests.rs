//! The GitLab driver against a scripted GitLab ([`super::mock`]).
//!
//! One test per quirk Insight's GitLab connector met in production: how
//! GitLab pages, throttles and refuses, and what changed between versions.

use serde_json::json;

use super::super::driver::ConnectorDriver;
use super::client::{GitLabErrorKind, kind_of};
use super::mock::{Mock, Reply};

const PROJECT: &str = "/api/v4/projects/acme%2Fplatform%2Fapp";

/* ── Transport ── */

#[tokio::test]
async fn the_token_goes_in_private_token_and_the_identity_comes_from_user() {
    let mock = Mock::builder()
        .get(
            "/api/v4/user",
            Reply::json(json!({ "id": 7, "username": "ada", "name": "Ada L" })),
        )
        .start()
        .await;
    let id = mock.driver().test(&mock.auth()).await.unwrap();
    assert_eq!(id.account, "ada");
    assert_eq!(id.display_name.as_deref(), Some("Ada L"));
    assert_eq!(
        mock.calls("/api/v4/user")[0].token.as_deref(),
        Some("glpat-test")
    );
}

#[tokio::test]
async fn an_address_typed_with_the_api_suffix_still_reaches_the_api() {
    let mock = Mock::builder()
        .get("/api/v4/user", Reply::json(json!({ "username": "ada" })))
        .start()
        .await;
    let mut auth = mock.auth();
    auth.base_url = format!("{}/api/v4/", mock.base);
    assert_eq!(mock.driver().test(&auth).await.unwrap().account, "ada");
}

#[tokio::test]
async fn a_refused_token_is_a_typed_401_that_names_the_scopes() {
    let mock = Mock::builder()
        .get("/api/v4/user", Reply::status(401))
        .start()
        .await;
    let err = mock.driver().test(&mock.auth()).await.unwrap_err();
    assert_eq!(kind_of(&err), Some(GitLabErrorKind::Unauthorized));
    let text = err.to_string();
    assert!(text.starts_with("GitLab 401"), "{text}");
    assert!(text.contains("read_api") && text.contains("read_repository"), "{text}");
    // A refused token is not retried: it will not get better.
    assert_eq!(mock.calls("/api/v4/user").len(), 1);
}

#[tokio::test]
async fn a_throttle_is_waited_out_as_retry_after_says() {
    let mock = Mock::builder()
        .get(
            "/api/v4/user",
            Reply::status(429).header("retry-after", "1"),
        )
        .then(Reply::json(json!({ "username": "ada" })))
        .start()
        .await;
    let started = std::time::Instant::now();
    let id = mock.driver().test(&mock.auth()).await.unwrap();
    assert_eq!(id.account, "ada");
    assert_eq!(mock.calls("/api/v4/user").len(), 2);
    // Retry-After asked for a second; the test policy caps a wait at 50 ms,
    // which is what bounds a real one at a minute.
    assert!(started.elapsed() >= std::time::Duration::from_millis(50));
}

#[tokio::test]
async fn a_server_error_is_retried_and_one_that_persists_says_so() {
    let mock = Mock::builder()
        .get("/api/v4/user", Reply::status(502))
        .then(Reply::status(503))
        .then(Reply::json(json!({ "username": "ada" })))
        .start()
        .await;
    assert_eq!(mock.driver().test(&mock.auth()).await.unwrap().account, "ada");

    let failing = Mock::builder()
        .get("/api/v4/user", Reply::status(500))
        .start()
        .await;
    let err = failing.driver().test(&failing.auth()).await.unwrap_err();
    assert_eq!(kind_of(&err), Some(GitLabErrorKind::Unavailable));
    // The first attempt and three retries.
    assert_eq!(failing.calls("/api/v4/user").len(), 4);
}

#[tokio::test]
async fn the_repository_listing_follows_link_until_it_holds_the_limit() {
    let project = |id: i64| {
        json!({
            "id": id,
            "name": format!("p{id}"),
            "path_with_namespace": format!("acme/p{id}"),
            "http_url_to_repo": format!("https://g.example/acme/p{id}.git"),
            "default_branch": "main",
            "visibility": "private",
        })
    };
    let mock = Mock::builder()
        .get_q(
            "/api/v4/projects",
            "membership=true&page=2",
            Reply::json(json!([project(3), project(4)])).next("/api/v4/projects?page=3"),
        )
        .get_q(
            "/api/v4/projects",
            "membership=true&search=pl%20at",
            Reply::json(json!([project(1), project(2)]))
                .next("/api/v4/projects?membership=true&page=2"),
        )
        .start()
        .await;
    let repos = mock
        .driver()
        .list_repositories(&mock.auth(), Some(" pl at "), 3)
        .await
        .unwrap();
    assert_eq!(
        repos.iter().map(|r| r.full_path.as_str()).collect::<Vec<_>>(),
        ["acme/p1", "acme/p2", "acme/p3"]
    );
    // Three were held after the second page: the third was never asked for.
    assert_eq!(mock.calls("/api/v4/projects").len(), 2);
}

#[tokio::test]
async fn a_next_link_to_another_host_is_not_followed() {
    let mock = Mock::builder()
        .get(
            "/api/v4/projects",
            Reply::json(json!([{
                "id": 1, "name": "a", "path_with_namespace": "acme/a",
                "http_url_to_repo": "https://g.example/acme/a.git"
            }]))
            .header("link", "<https://evil.example/steal?page=2>; rel=\"next\""),
        )
        .start()
        .await;
    let repos = mock
        .driver()
        .list_repositories(&mock.auth(), None, 50)
        .await
        .unwrap();
    assert_eq!(repos.len(), 1);
}

#[tokio::test]
async fn a_graphql_error_inside_a_200_is_an_error() {
    let mock = Mock::builder()
        .post(
            "/api/graphql",
            Reply::json(json!({ "data": null, "errors": [{ "message": "Field 'x' doesn't exist" }] })),
        )
        .start()
        .await;
    let driver = mock.driver();
    let auth = mock.auth();
    let api = driver.api(&auth);
    let err = api
        .graphql::<serde_json::Value>("query { x }", json!({}))
        .await
        .unwrap_err();
    assert_eq!(kind_of(&err), Some(GitLabErrorKind::GraphQl));
    assert!(err.to_string().contains("Field 'x' doesn't exist"), "{err}");
    // The trait's passthrough hands the reply back for the caller to read.
    let raw = driver
        .graphql(&mock.auth(), &json!({ "query": "query { x }" }))
        .await
        .unwrap();
    assert_eq!(raw["errors"][0]["message"], "Field 'x' doesn't exist");
}

/* ── Clone and read path ── */

#[test]
fn a_clone_is_the_installation_root_and_the_token_goes_as_oauth2() {
    let driver = super::GitLabDriver::new(reqwest::Client::new());
    assert_eq!(
        driver
            .clone_url("https://git.corp.example/gitlab/", "/acme/platform/app")
            .unwrap(),
        "https://git.corp.example/gitlab/acme/platform/app.git"
    );
    assert_eq!(
        driver
            .clone_url("https://gitlab.com/api/v4", "acme/app.git")
            .unwrap(),
        "https://gitlab.com/acme/app.git"
    );
    assert_eq!(driver.clone_credentials("glpat-x"), ("oauth2", "glpat-x"));
}

#[tokio::test]
async fn the_tree_walks_keyset_pages_on_the_default_branch() {
    let mock = Mock::builder()
        .get(PROJECT, Reply::json(json!({
            "id": 5, "name": "app", "path_with_namespace": "acme/platform/app",
            "http_url_to_repo": "x", "default_branch": "trunk"
        })))
        .get_q(
            &format!("{PROJECT}/repository/tree"),
            "page_token=abc",
            Reply::json(json!([
                { "id": "b2", "name": "main.rs", "type": "blob", "path": "src/main.rs" },
                { "id": "c1", "name": "vendor", "type": "commit", "path": "vendor" }
            ])),
        )
        .get_q(
            &format!("{PROJECT}/repository/tree"),
            "pagination=keyset&ref=trunk&recursive=true",
            Reply::json(json!([
                { "id": "t1", "name": "src", "type": "tree", "path": "src" },
                { "id": "b1", "name": "README.md", "type": "blob", "path": "README.md" }
            ]))
            .next(&format!(
                "{PROJECT}/repository/tree?pagination=keyset&page_token=abc&recursive=true&ref=trunk"
            )),
        )
        .start()
        .await;
    let driver = mock.driver();
    let files = driver
        .list_files(&mock.auth(), "acme/platform/app", None)
        .await
        .unwrap();
    assert!(!files.truncated);
    assert_eq!(
        files
            .files
            .iter()
            .map(|f| (f.path.as_str(), f.is_dir, f.sha.as_str()))
            .collect::<Vec<_>>(),
        [("src", true, "t1"), ("README.md", false, "b1"), ("src/main.rs", false, "b2")]
    );
    let tree = driver
        .repo_tree(&mock.auth(), "acme/platform/app", Some("trunk"))
        .await
        .unwrap();
    assert_eq!(tree.git_ref, "trunk");
    assert_eq!(tree.entries.len(), 3, "a submodule is not a file");
}

#[tokio::test]
async fn a_file_is_read_raw_with_its_blob_and_a_missing_one_is_none() {
    let mock = Mock::builder()
        .get_q(
            &format!("{PROJECT}/repository/files/docs%2Fadr%2F0001.md/raw"),
            "ref=main",
            Reply::text("# ADR").header("x-gitlab-blob-id", "abc123"),
        )
        .start()
        .await;
    let driver = mock.driver();
    let file = driver
        .read_file(&mock.auth(), "acme/platform/app", "docs/adr/0001.md", Some("main"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(file.text, "# ADR");
    assert_eq!(file.sha.as_deref(), Some("abc123"));
    assert!(
        driver
            .read_file(&mock.auth(), "acme/platform/app", "nope.md", None)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        driver
            .read_file(&mock.auth(), "acme/platform/app", "../etc/passwd", None)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn branches_resolve_and_a_missing_one_is_absent_not_an_error() {
    let mock = Mock::builder()
        .get(
            &format!("{PROJECT}/repository/branches/feature%2Fx"),
            Reply::json(json!({ "name": "feature/x", "commit": { "id": "f00" } })),
        )
        .get_q(
            &format!("{PROJECT}/repository/branches"),
            "search=%5Eproduct%2F",
            Reply::json(json!([
                { "name": "product/a", "commit": { "id": "a1" } },
                { "name": "not-product/b", "commit": { "id": "b1" } }
            ])),
        )
        .start()
        .await;
    let driver = mock.driver();
    let auth = mock.auth();
    assert_eq!(
        driver
            .branch_head(&auth, "acme/platform/app", "feature/x")
            .await
            .unwrap()
            .as_deref(),
        Some("f00")
    );
    assert_eq!(
        driver
            .branch_head(&auth, "acme/platform/app", "gone")
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        driver
            .branches_with_prefix(&auth, "acme/platform/app", "product/")
            .await
            .unwrap(),
        vec![("product/a".to_string(), "a1".to_string())]
    );
}

#[tokio::test]
async fn a_project_the_token_cannot_see_fails_the_read_loudly() {
    let mock = Mock::builder()
        .get(PROJECT, Reply::status(404))
        .start()
        .await;
    let err = mock
        .driver()
        .list_files(&mock.auth(), "acme/platform/app", None)
        .await
        .unwrap_err();
    assert_eq!(kind_of(&err), Some(GitLabErrorKind::NotFound));
    assert!(err.to_string().contains("404"), "{err}");
}
