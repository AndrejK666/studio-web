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
    assert!(
        text.contains("read_api") && text.contains("read_repository"),
        "{text}"
    );
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
    assert_eq!(
        mock.driver().test(&mock.auth()).await.unwrap().account,
        "ada"
    );

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
        repos
            .iter()
            .map(|r| r.full_path.as_str())
            .collect::<Vec<_>>(),
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
            Reply::json(
                json!({ "data": null, "errors": [{ "message": "Field 'x' doesn't exist" }] }),
            ),
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
        [
            ("src", true, "t1"),
            ("README.md", false, "b1"),
            ("src/main.rs", false, "b2")
        ]
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
        .read_file(
            &mock.auth(),
            "acme/platform/app",
            "docs/adr/0001.md",
            Some("main"),
        )
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

/* ── What the artifact graph reads ── */

fn mr(id: i64, iid: i64, extra: serde_json::Value) -> serde_json::Value {
    let mut v = json!({
        "id": id,
        "iid": iid,
        "title": format!("MR {iid}"),
        "state": "opened",
        "author": { "username": "ada" },
        "web_url": format!("https://g.example/acme/platform/app/-/merge_requests/{iid}"),
        "source_branch": "feature",
        "target_branch": "main",
        "updated_at": "2026-11-20T10:00:00.000Z",
        "sha": "head1",
    });
    if let (Some(v), Some(extra)) = (v.as_object_mut(), extra.as_object()) {
        for (k, x) in extra {
            v.insert(k.clone(), x.clone());
        }
    }
    v
}

#[tokio::test]
async fn the_identity_brings_its_avatar() {
    let mock = Mock::builder()
        .get(
            "/api/v4/user",
            Reply::json(json!({
                "username": "ada",
                "avatar_url": "https://g.example/uploads/-/system/user/avatar/7/a.png"
            })),
        )
        .start()
        .await;
    let id = mock.driver().test(&mock.auth()).await.unwrap();
    assert_eq!(
        id.avatar_url.as_deref(),
        Some("https://g.example/uploads/-/system/user/avatar/7/a.png")
    );
}

#[tokio::test]
async fn merge_requests_read_renamed_fields_and_survive_a_deleted_author() {
    let mock = Mock::builder()
        .get_q(
            &format!("{PROJECT}/merge_requests"),
            "state=all&order_by=updated_at&updated_after=2026-11-01T00%3A00%3A00Z",
            Reply::json(json!([
                // An older GitLab: `work_in_progress`, one `assignee`, no
                // `reviewers`; the author's account was deleted.
                mr(
                    101,
                    1,
                    json!({
                        "author": null,
                        "work_in_progress": true,
                        "assignee": { "username": "bob" },
                    })
                ),
                // A current one, merged by squash.
                mr(
                    102,
                    2,
                    json!({
                        "state": "merged",
                        "draft": false,
                        "merged_at": "2026-11-19T09:00:00Z",
                        "squash_commit_sha": "sq1",
                        "reviewers": [{ "username": "carol" }, null],
                        "assignees": [{ "username": "dan" }],
                    })
                ),
            ])),
        )
        .start()
        .await;
    let prs = mock
        .driver()
        .list_pull_requests(
            &mock.auth(),
            "acme/platform/app",
            Some("2026-11-01T00:00:00Z"),
            1,
            100,
        )
        .await
        .unwrap();
    assert_eq!(prs.len(), 2);
    let old = &prs[0];
    assert_eq!((old.number, old.state.as_str()), (1, "open"));
    assert_eq!(old.author, None);
    assert_eq!(old.draft, Some(true));
    assert_eq!(old.assignees, vec!["bob".to_string()]);
    assert!(old.requested_reviewers.is_empty());
    assert_eq!(old.merge_sha, None);
    let merged = &prs[1];
    assert_eq!(merged.state, "merged");
    assert!(merged.merged);
    assert_eq!(merged.draft, Some(false));
    assert_eq!(merged.merge_sha.as_deref(), Some("sq1"));
    assert_eq!(merged.head_sha.as_deref(), Some("head1"));
    assert_eq!(merged.assignees, vec!["dan".to_string()]);
}

#[tokio::test]
async fn issues_are_read_and_a_project_without_them_has_none() {
    let mock = Mock::builder()
        .get(
            &format!("{PROJECT}/issues"),
            Reply::json(json!([{
                "id": 900, "iid": 5, "title": "Bug", "state": "opened",
                "author": { "username": "ada" }, "labels": ["bug"],
                "milestone": { "title": "Sprint 4" },
                "web_url": "https://g.example/acme/platform/app/-/issues/5"
            }])),
        )
        .get(
            "/api/v4/projects/acme%2Fno-issues/issues",
            Reply::status(403),
        )
        .start()
        .await;
    let driver = mock.driver();
    let issues = driver
        .list_issues(&mock.auth(), "acme/platform/app", None, 1, 100)
        .await
        .unwrap();
    assert_eq!(issues.len(), 1);
    let i = &issues[0];
    assert_eq!(
        (i.id.as_str(), i.number, i.state.as_str()),
        ("900", 5, "open")
    );
    assert_eq!(i.labels, vec!["bug".to_string()]);
    assert_eq!(i.iteration.as_deref(), Some("Sprint 4"));
    assert!(
        driver
            .list_issues(&mock.auth(), "acme/no-issues", None, 1, 100)
            .await
            .unwrap()
            .is_empty()
    );
}

/// The same iid in two projects is two merge requests: each is keyed by its
/// global id, and each one's notes are asked of its own project.
#[tokio::test]
async fn the_same_iid_in_two_projects_stays_two_items() {
    let note = |id: i64, body: &str| {
        json!([{ "id": id, "body": body, "author": { "username": "ada" }, "system": false,
                  "updated_at": "2026-11-20T10:00:00Z" }])
    };
    let mock = Mock::builder()
        .get(
            "/api/v4/projects/acme%2Fone/merge_requests",
            Reply::json(json!([mr(11, 1, json!({}))])),
        )
        .get(
            "/api/v4/projects/acme%2Ftwo/merge_requests",
            Reply::json(json!([mr(22, 1, json!({}))])),
        )
        .get("/api/v4/projects/acme%2Fone/issues", Reply::json(json!([])))
        .get("/api/v4/projects/acme%2Ftwo/issues", Reply::json(json!([])))
        .get(
            "/api/v4/projects/acme%2Fone/merge_requests/1/notes",
            Reply::json(note(1001, "one")),
        )
        .get(
            "/api/v4/projects/acme%2Ftwo/merge_requests/1/notes",
            Reply::json(note(2001, "two")),
        )
        .start()
        .await;
    let driver = mock.driver();
    let auth = mock.auth();
    let a = driver
        .list_pull_requests(&auth, "acme/one", None, 1, 100)
        .await
        .unwrap();
    let b = driver
        .list_pull_requests(&auth, "acme/two", None, 1, 100)
        .await
        .unwrap();
    assert_eq!((a[0].number, a[0].id.as_str()), (1, "11"));
    assert_eq!((b[0].number, b[0].id.as_str()), (1, "22"));
    let ca = driver
        .list_comments(&auth, "acme/one", None, 1, 100)
        .await
        .unwrap();
    let cb = driver
        .list_comments(&auth, "acme/two", None, 1, 100)
        .await
        .unwrap();
    assert_eq!(ca[0].body.as_deref(), Some("one"));
    assert_eq!(cb[0].body.as_deref(), Some("two"));
}

#[tokio::test]
async fn comments_are_peoples_notes_and_say_which_kind_of_item_they_are_on() {
    let mock = Mock::builder()
        .get(
            &format!("{PROJECT}/merge_requests"),
            Reply::json(json!([mr(101, 5, json!({})), mr(102, 6, json!({}))])),
        )
        .get(
            &format!("{PROJECT}/issues"),
            Reply::json(
                json!([{ "id": 900, "iid": 5, "title": "Bug", "state": "opened",
                                  "web_url": "https://g.example/i/5" }]),
            ),
        )
        .get(
            &format!("{PROJECT}/merge_requests/5/notes"),
            Reply::json(json!([
                { "id": 1, "body": "approved this merge request", "system": true,
                  "author": { "username": "bob" } },
                { "id": 2, "body": "Looks good", "system": false, "author": { "username": "bob" },
                  "created_at": "2026-11-20T10:00:00Z", "updated_at": "2026-11-20T10:00:00Z" },
                { "id": 3, "body": "old", "system": false, "author": null,
                  "updated_at": "2026-10-01T00:00:00Z" }
            ])),
        )
        // A merge request whose notes are a feature this edition lacks:
        // skipped, not fatal.
        .get(
            &format!("{PROJECT}/merge_requests/6/notes"),
            Reply::status(402),
        )
        .get(
            &format!("{PROJECT}/issues/5/notes"),
            Reply::json(json!([{ "id": 4, "body": "Repro?", "system": false,
                                  "updated_at": "2026-11-21T00:00:00.000+01:00" }])),
        )
        .start()
        .await;
    let comments = mock
        .driver()
        .list_comments(
            &mock.auth(),
            "acme/platform/app",
            Some("2026-11-15T00:00:00Z"),
            1,
            100,
        )
        .await
        .unwrap();
    let got: Vec<(&str, i64, Option<bool>)> = comments
        .iter()
        .map(|c| (c.id.as_str(), c.target_number, c.target_is_pull_request))
        .collect();
    assert_eq!(got, vec![("2", 5, Some(true)), ("4", 5, Some(false))]);
    assert_eq!(
        comments[0].url.as_deref(),
        Some("https://g.example/acme/platform/app/-/merge_requests/5#note_2")
    );
}

#[tokio::test]
async fn a_commit_is_attributed_only_through_a_noreply_address() {
    let mock = Mock::builder()
        .get_q(
            &format!("{PROJECT}/repository/commits"),
            "since=2026-11-01T00%3A00%3A00Z",
            Reply::json(json!([
                { "id": "c1", "title": "Fix", "message": "Fix\n\nbody",
                  "author_name": "Ada", "author_email": "7-ada@users.noreply.gitlab.com",
                  "authored_date": "2026-11-02T00:00:00Z",
                  "committed_date": "2026-11-03T00:00:00Z" },
                { "id": "c2", "title": "Docs", "author_name": "Bob",
                  "author_email": "bob@corp.example" }
            ])),
        )
        .start()
        .await;
    let commits = mock
        .driver()
        .list_commits(
            &mock.auth(),
            "acme/platform/app",
            Some("2026-11-01T00:00:00Z"),
            1,
            100,
        )
        .await
        .unwrap();
    assert_eq!(commits[0].author.as_deref(), Some("ada"));
    assert_eq!(commits[0].message.as_deref(), Some("Fix\n\nbody"));
    assert_eq!(
        commits[0].committed_at.as_deref(),
        Some("2026-11-03T00:00:00Z")
    );
    assert_eq!(commits[1].author, None);
    assert_eq!(commits[1].author_name.as_deref(), Some("Bob"));
}

#[tokio::test]
async fn changed_files_come_from_diffs_or_from_changes_on_an_older_gitlab() {
    let diffs = format!("{PROJECT}/merge_requests/1/diffs");
    let mock = Mock::builder()
        // The second page first: the first route that matches answers.
        .get_q(
            &diffs,
            "page=2",
            Reply::json(json!([{ "new_path": "b.rs" }])),
        )
        .get(
            &diffs,
            Reply::json(json!([{ "new_path": "a.rs" }]))
                .next(&format!("{diffs}?per_page=100&page=2")),
        )
        .get(
            &format!("{PROJECT}/merge_requests/2/changes"),
            Reply::json(json!({ "changes": [{ "new_path": "old.rs" }] })),
        )
        .start()
        .await;
    let driver = mock.driver();
    let auth = mock.auth();
    assert_eq!(
        driver
            .pull_request_files(&auth, "acme/platform/app", 1)
            .await
            .unwrap(),
        vec!["a.rs".to_string(), "b.rs".to_string()]
    );
    // No `/diffs` on this one (a GitLab before 15.7 answers 404).
    assert_eq!(
        driver
            .pull_request_files(&auth, "acme/platform/app", 2)
            .await
            .unwrap(),
        vec!["old.rs".to_string()]
    );
}

#[tokio::test]
async fn contributors_are_named_by_account_where_the_address_says_it() {
    let mock = Mock::builder()
        .get(
            &format!("{PROJECT}/repository/contributors"),
            Reply::json(json!([
                { "name": "Bob", "email": "bob@corp.example", "commits": 3 },
                { "name": "Ada", "email": "7-ada@users.noreply.gitlab.com", "commits": 9 }
            ])),
        )
        .start()
        .await;
    let people = mock
        .driver()
        .contributors(&mock.auth(), "acme/platform/app", 10)
        .await
        .unwrap();
    assert_eq!(
        people
            .iter()
            .map(|p| (p.login.as_str(), p.contributions))
            .collect::<Vec<_>>(),
        [("ada", 9), ("bob@corp.example", 3)]
    );
}

/* ── Reviews (from system notes) ── */

fn discussions_of_mr_7() -> serde_json::Value {
    json!([
        { "id": "d1", "individual_note": true, "notes": [
            { "id": 1, "system": true, "body": "requested review from @bob and @carol",
              "author": { "username": "ada" } } ] },
        { "id": "d2", "individual_note": false, "notes": [
            { "id": 2, "system": false, "body": "Please split this", "resolvable": true,
              "resolved": false, "author": { "username": "carol" } },
            { "id": 3, "system": false, "body": "Will do", "resolvable": true,
              "resolved": false, "author": { "username": "ada" } } ] },
        { "id": "d3", "individual_note": false, "notes": [
            { "id": 4, "system": false, "body": "typo", "resolvable": true,
              "resolved": true, "author": { "username": "bob" } } ] },
        { "id": "d4", "individual_note": true, "notes": [
            { "id": 5, "system": true, "body": "requested changes",
              "author": { "username": "carol" } } ] }
    ])
}

#[tokio::test]
async fn open_merge_requests_say_who_still_owes_a_review_and_what_each_said() {
    let open_mr = mr(
        700,
        7,
        json!({ "reviewers": [{ "username": "bob" }, { "username": "carol" }, { "username": "erin" }] }),
    );
    let mock = Mock::builder()
        .get_q(
            &format!("{PROJECT}/merge_requests"),
            "state=opened",
            Reply::json(json!([open_mr.clone()])),
        )
        .get_q(
            &format!("{PROJECT}/merge_requests"),
            "state=all",
            Reply::json(json!([open_mr])),
        )
        .get(
            &format!("{PROJECT}/merge_requests/7/discussions"),
            Reply::json(discussions_of_mr_7()),
        )
        // Not licensed on this edition: the extra is skipped, the notes stand.
        .get(
            &format!("{PROJECT}/merge_requests/7/approvals"),
            Reply::status(402),
        )
        .start()
        .await;
    let driver = mock.driver();
    let auth = mock.auth();

    let threads = driver
        .open_review_threads(&auth, "acme/platform/app", 50)
        .await
        .unwrap()
        .expect("GitLab can say");
    assert_eq!(threads.len(), 1);
    let t = &threads[0];
    assert_eq!((t.number, t.open, t.total), (7, 1, 2));
    assert_eq!(
        t.reviews
            .iter()
            .map(|r| (r.login.as_str(), r.state.as_str()))
            .collect::<Vec<_>>(),
        [("bob", "commented"), ("carol", "changes_requested")]
    );

    // Bob answered (a comment), Carol asked for changes; Erin never did.
    let prs = driver
        .list_pull_requests(&auth, "acme/platform/app", None, 1, 100)
        .await
        .unwrap();
    assert_eq!(prs[0].requested_reviewers, vec!["erin".to_string()]);
}

#[tokio::test]
async fn an_approval_only_the_approvals_endpoint_lists_is_read_where_licensed() {
    let mock = Mock::builder()
        .get_q(
            &format!("{PROJECT}/merge_requests"),
            "state=opened",
            Reply::json(json!([mr(
                800,
                8,
                json!({ "reviewers": [{ "username": "bob" }] })
            )])),
        )
        .get(
            &format!("{PROJECT}/merge_requests/8/discussions"),
            Reply::json(json!([])),
        )
        .get(
            &format!("{PROJECT}/merge_requests/8/approvals"),
            Reply::json(
                json!({ "approved_by": [{ "user": { "username": "bob" } }, { "user": null }] }),
            ),
        )
        .start()
        .await;
    let threads = mock
        .driver()
        .open_review_threads(&mock.auth(), "acme/platform/app", 50)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(threads[0].reviews.len(), 1);
    assert_eq!(threads[0].reviews[0].state, "approved");
    assert_eq!((threads[0].open, threads[0].total), (0, 0));
}

/* ── CI: pipelines and jobs through GraphQL ── */

fn pipelines_page(nodes: serde_json::Value, next: Option<&str>) -> serde_json::Value {
    json!({ "data": { "project": { "pipelines": {
        "pageInfo": { "hasNextPage": next.is_some(), "endCursor": next },
        "nodes": nodes,
    } } } })
}

#[tokio::test]
async fn pipelines_are_runs_and_a_later_page_walks_the_cursor() {
    let mock = Mock::builder()
        .post(
            "/api/graphql",
            Reply::json(pipelines_page(
                json!([{ "id": "gid://gitlab/Ci::Pipeline/10", "iid": "1", "sha": "a",
                         "ref": "main", "status": "SUCCESS", "source": "push" }]),
                Some("c1"),
            )),
        )
        .then(Reply::json(pipelines_page(
            json!([
                { "id": "gid://gitlab/Ci::Pipeline/9", "iid": "2", "sha": "b",
                  "ref": "feature", "status": "FAILED", "source": "merge_request_event",
                  "createdAt": "2026-11-20T10:00:00Z", "user": { "username": "ada" },
                  "mergeRequest": { "iid": "7" } },
                { "id": "gid://gitlab/Ci::Pipeline/8", "iid": "3", "sha": "c",
                  "ref": "main", "status": "RUNNING", "source": "schedule" }
            ]),
            None,
        )))
        .start()
        .await;
    let driver = mock.driver();
    let runs = driver
        .list_workflow_runs(&mock.auth(), "acme/platform/app", None, 2, 1)
        .await
        .unwrap();
    let calls = mock.calls("/api/graphql");
    assert_eq!(calls.len(), 2);
    assert_eq!(
        calls[0].body.as_ref().unwrap()["variables"]["cursor"],
        json!(null)
    );
    assert_eq!(calls[1].body.as_ref().unwrap()["variables"]["cursor"], "c1");
    assert_eq!(
        calls[1].body.as_ref().unwrap()["variables"]["project"],
        "acme/platform/app"
    );
    assert_eq!(runs.len(), 2);
    let failed = &runs[0];
    assert_eq!((failed.id, failed.run_number), (9, Some(2)));
    assert_eq!(failed.status.as_deref(), Some("completed"));
    assert_eq!(failed.conclusion.as_deref(), Some("failure"));
    assert_eq!(failed.event.as_deref(), Some("pull_request"));
    assert_eq!(failed.actor.as_deref(), Some("ada"));
    assert_eq!(failed.title.as_deref(), Some("Merge request !7"));
    assert_eq!(
        failed.url.as_deref(),
        Some(format!("{}/acme/platform/app/-/pipelines/9", mock.base).as_str())
    );
    assert_eq!(runs[1].status.as_deref(), Some("in_progress"));
    assert_eq!(runs[1].conclusion, None);
    assert_eq!(runs[1].event.as_deref(), Some("schedule"));
}

#[tokio::test]
async fn a_project_graphql_cannot_see_has_no_runs() {
    let mock = Mock::builder()
        .post(
            "/api/graphql",
            Reply::json(json!({ "data": { "project": null } })),
        )
        .start()
        .await;
    let runs = mock
        .driver()
        .list_workflow_runs(&mock.auth(), "acme/platform/app", None, 1, 100)
        .await
        .unwrap();
    assert!(runs.is_empty());
}

#[tokio::test]
async fn a_graphql_error_fails_the_run_listing() {
    let mock = Mock::builder()
        .post(
            "/api/graphql",
            Reply::json(json!({ "errors": [{ "message": "Internal server error" }] })),
        )
        .start()
        .await;
    let err = mock
        .driver()
        .list_workflow_runs(&mock.auth(), "acme/platform/app", None, 1, 100)
        .await
        .unwrap_err();
    assert_eq!(kind_of(&err), Some(GitLabErrorKind::GraphQl));
}

#[tokio::test]
async fn jobs_are_the_latest_attempt_and_an_allowed_failure_is_neutral() {
    let mock = Mock::builder()
        .get(
            &format!("{PROJECT}/pipelines/9"),
            Reply::json(json!({ "id": 9, "iid": 2 })),
        )
        .post(
            "/api/graphql",
            Reply::json(json!({ "data": { "project": { "pipeline": { "jobs": {
                "pageInfo": { "hasNextPage": false, "endCursor": null },
                "nodes": [
                    { "id": "gid://gitlab/Ci::Build/1", "name": "test", "status": "FAILED",
                      "retried": true, "stage": { "name": "test" } },
                    { "id": "gid://gitlab/Ci::Build/2", "name": "test", "status": "FAILED",
                      "retried": false, "stage": { "name": "test" },
                      "finishedAt": "2026-11-20T10:05:00Z" },
                    { "id": "gid://gitlab/Ci::Build/3", "name": "lint", "status": "FAILED",
                      "allowFailure": true, "stage": { "name": "test" } },
                    { "id": "gid://gitlab/Ci::Bridge/4", "name": "deploy", "status": "MANUAL",
                      "stage": { "name": "deploy" } }
                ]
            } } } } })),
        )
        .start()
        .await;
    let jobs = mock
        .driver()
        .list_workflow_jobs(&mock.auth(), "acme/platform/app", 9)
        .await
        .unwrap();
    let got: Vec<(i64, &str, Option<&str>, Option<&str>)> = jobs
        .iter()
        .map(|j| {
            (
                j.id,
                j.name.as_str(),
                j.conclusion.as_deref(),
                j.failed_step.as_deref(),
            )
        })
        .collect();
    assert_eq!(
        got,
        vec![
            (2, "test", Some("failure"), Some("test")),
            (3, "lint", Some("neutral"), None),
            (4, "deploy", None, None),
        ]
    );
    assert_eq!(
        mock.calls("/api/graphql")[0].body.as_ref().unwrap()["variables"]["iid"],
        "2"
    );
}

#[tokio::test]
async fn a_pipeline_gone_before_its_jobs_are_read_has_none() {
    let mock = Mock::builder()
        .get(&format!("{PROJECT}/pipelines/9"), Reply::status(404))
        .start()
        .await;
    let jobs = mock
        .driver()
        .list_workflow_jobs(&mock.auth(), "acme/platform/app", 9)
        .await
        .unwrap();
    assert!(jobs.is_empty());
    assert!(mock.calls("/api/graphql").is_empty());
}

/* ── Writes ── */

fn file(path: &str, content: &str) -> super::super::driver::FileToWrite {
    super::super::driver::FileToWrite {
        path: path.into(),
        content: content.into(),
    }
}

#[tokio::test]
async fn a_commit_onto_a_new_branch_is_one_call_with_create_and_update_actions() {
    let mock = Mock::builder()
        // `docs/a.md` is on the base already, `docs/b.md` is new.
        .get_q(
            &format!("{PROJECT}/repository/files/docs%2Fa.md"),
            "ref=main",
            Reply::json(json!({ "blob_id": "b1", "last_commit_id": "c0" })),
        )
        .route(
            axum::http::Method::POST,
            &format!("{PROJECT}/repository/commits"),
            "",
            Reply::json(json!({ "id": "c1" })),
        )
        .start()
        .await;
    let sha = mock
        .driver()
        .commit_changes(
            &mock.auth(),
            "acme/platform/app",
            "main",
            "product/x",
            &[file("docs/a.md", "A"), file("docs/b.md", "B")],
            &["old.md".to_string()],
            "Describe the product",
        )
        .await
        .unwrap();
    assert_eq!(sha, "c1");
    let posted = mock.calls(&format!("{PROJECT}/repository/commits"));
    assert_eq!(posted.len(), 1);
    let body = posted[0].body.clone().unwrap();
    assert_eq!(body["branch"], "product/x");
    assert_eq!(body["start_branch"], "main");
    let actions: Vec<(&str, &str)> = body["actions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| {
            (
                a["action"].as_str().unwrap(),
                a["file_path"].as_str().unwrap(),
            )
        })
        .collect();
    // `old.md` is not on the base: nothing to delete.
    assert_eq!(actions, [("update", "docs/a.md"), ("create", "docs/b.md")]);
}

#[tokio::test]
async fn committing_the_same_files_again_answers_the_branch_it_already_has() {
    let mock = Mock::builder()
        .get(
            &format!("{PROJECT}/repository/branches/product%2Fx"),
            Reply::json(json!({ "name": "product/x", "commit": { "id": "c1" } })),
        )
        .get_q(
            &format!("{PROJECT}/repository/files/docs%2Fa.md/raw"),
            "ref=product%2Fx",
            Reply::text("A"),
        )
        .start()
        .await;
    let driver = mock.driver();
    let auth = mock.auth();
    let again = driver
        .commit_files(
            &auth,
            "acme/platform/app",
            "main",
            "product/x",
            &[file("docs/a.md", "A")],
            "m",
        )
        .await
        .unwrap();
    assert_eq!(again, "c1");
    let other = driver
        .commit_files(
            &auth,
            "acme/platform/app",
            "main",
            "product/x",
            &[file("docs/a.md", "Z")],
            "m",
        )
        .await
        .unwrap_err();
    assert!(other.to_string().contains("different content"), "{other}");
    assert!(
        mock.calls(&format!("{PROJECT}/repository/commits"))
            .is_empty()
    );
}

#[tokio::test]
async fn a_write_is_not_resent_after_a_server_error() {
    let mock = Mock::builder()
        .route(
            axum::http::Method::POST,
            &format!("{PROJECT}/repository/commits"),
            "",
            Reply::status(502),
        )
        .start()
        .await;
    let err = mock
        .driver()
        .commit_files(
            &mock.auth(),
            "acme/platform/app",
            "main",
            "main",
            &[file("a", "A")],
            "m",
        )
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("502"), "{err:#}");
    assert_eq!(
        mock.calls(&format!("{PROJECT}/repository/commits")).len(),
        1
    );
}

#[tokio::test]
async fn a_file_is_created_replaced_or_left_when_it_already_says_that() {
    let path = format!("{PROJECT}/repository/files/notes.md");
    let mock = Mock::builder()
        .get_q(&format!("{path}/raw"), "ref=trunk", Reply::status(404))
        .then(Reply::text("same"))
        .route(
            axum::http::Method::POST,
            &path,
            "",
            Reply::json(json!({ "file_path": "notes.md" })),
        )
        .get_q(
            &path,
            "ref=trunk",
            Reply::json(json!({ "blob_id": "blob9", "last_commit_id": "c9" })),
        )
        .start()
        .await;
    let driver = mock.driver();
    let auth = mock.auth();
    let created = driver
        .put_file(
            &auth,
            "acme/platform/app",
            Some("trunk"),
            "notes.md",
            "same",
            "m",
        )
        .await
        .unwrap();
    assert!(!created.updated);
    assert_eq!(created.sha, "blob9");
    assert_eq!(created.commit.as_deref(), Some("c9"));
    assert_eq!(created.branch.as_deref(), Some("trunk"));
    // Now it holds "same": asking again writes nothing.
    let again = driver
        .put_file(
            &auth,
            "acme/platform/app",
            Some("trunk"),
            "notes.md",
            "same",
            "m",
        )
        .await
        .unwrap();
    assert!(again.updated);
    let writes = mock
        .calls(&path)
        .into_iter()
        .filter(|c| c.method != axum::http::Method::GET)
        .count();
    assert_eq!(writes, 1);
}

#[tokio::test]
async fn a_protected_branch_is_a_typed_403_that_says_so() {
    let path = format!("{PROJECT}/repository/files/notes.md");
    let mock = Mock::builder()
        .get(&format!("{path}/raw"), Reply::text("old"))
        .route(
            axum::http::Method::PUT,
            &path,
            "",
            Reply::error(403, "You are not allowed to push into this branch"),
        )
        .start()
        .await;
    let err = mock
        .driver()
        .put_file(
            &mock.auth(),
            "acme/platform/app",
            Some("main"),
            "notes.md",
            "new",
            "m",
        )
        .await
        .unwrap_err();
    assert_eq!(kind_of(&err), Some(GitLabErrorKind::Forbidden));
    let text = format!("{err:#}");
    assert!(text.contains("protected branch"), "{text}");
    assert!(text.contains("not allowed to push"), "{text}");
}

#[tokio::test]
async fn a_merge_request_already_open_is_reused() {
    let mrs = format!("{PROJECT}/merge_requests");
    let mock = Mock::builder()
        .route(
            axum::http::Method::POST,
            &mrs,
            "",
            Reply::error(
                409,
                "Another open merge request already exists for this source branch: !4",
            ),
        )
        .get_q(
            &mrs,
            "state=opened&source_branch=product%2Fx&target_branch=main",
            Reply::json(json!([{ "iid": 4, "web_url": "https://g.example/mr/4" }])),
        )
        .start()
        .await;
    let driver = mock.driver();
    assert!(driver.supports_pull_requests());
    let mr = driver
        .open_pull_request(
            &mock.auth(),
            "acme/platform/app",
            "product/x",
            "main",
            "T",
            Some("B"),
        )
        .await
        .unwrap();
    assert_eq!((mr.number, mr.created), (4, false));
    let sent = mock
        .calls(&mrs)
        .into_iter()
        .find(|c| c.method == axum::http::Method::POST)
        .unwrap();
    assert_eq!(sent.body.unwrap()["description"], "B");
}

#[tokio::test]
async fn a_tag_already_at_the_commit_is_the_answer_and_one_elsewhere_is_refused() {
    let mock = Mock::builder()
        .route(
            axum::http::Method::POST,
            &format!("{PROJECT}/repository/tags"),
            "",
            Reply::error(400, "Tag v1 already exists"),
        )
        .get(
            &format!("{PROJECT}/repository/tags/v1"),
            Reply::json(json!({ "name": "v1", "commit": { "id": "c1" } })),
        )
        .start()
        .await;
    let driver = mock.driver();
    let auth = mock.auth();
    driver
        .create_tag(&auth, "acme/platform/app", "v1", "c1")
        .await
        .unwrap();
    let err = driver
        .create_tag(&auth, "acme/platform/app", "v1", "c2")
        .await
        .unwrap_err();
    assert!(err.to_string().contains("already points at c1"), "{err}");
}

#[tokio::test]
async fn a_status_maps_its_state_and_a_repeated_one_is_not_an_error() {
    let mock = Mock::builder()
        .route(
            axum::http::Method::POST,
            &format!("{PROJECT}/statuses/abc"),
            "",
            Reply::json(json!({ "id": 1 })),
        )
        .then(Reply::error(
            400,
            "Cannot transition status via :drop from :failed",
        ))
        .start()
        .await;
    let driver = mock.driver();
    let status = super::super::driver::CommitStatus {
        state: "failure".into(),
        context: "studio/build".into(),
        description: "x".repeat(300),
        target_url: Some("https://studio.example/b/1".into()),
    };
    let auth = mock.auth();
    driver
        .set_commit_status(&auth, "acme/platform/app", "abc", &status)
        .await
        .unwrap();
    driver
        .set_commit_status(&auth, "acme/platform/app", "abc", &status)
        .await
        .unwrap();
    let body = mock.calls(&format!("{PROJECT}/statuses/abc"))[0]
        .body
        .clone()
        .unwrap();
    assert_eq!(body["state"], "failed");
    assert_eq!(body["name"], "studio/build");
    assert_eq!(body["description"].as_str().unwrap().len(), 140);
}

#[tokio::test]
async fn a_dispatch_is_a_pipeline_on_the_ref_naming_the_workflow() {
    let mock = Mock::builder()
        .route(
            axum::http::Method::POST,
            &format!("{PROJECT}/pipeline"),
            "",
            Reply::json(json!({ "id": 5 })),
        )
        .start()
        .await;
    mock.driver()
        .dispatch_workflow(&mock.auth(), "acme/platform/app", "build.yml", "main")
        .await
        .unwrap();
    let body = mock.calls(&format!("{PROJECT}/pipeline"))[0]
        .body
        .clone()
        .unwrap();
    assert_eq!(body["ref"], "main");
    assert_eq!(body["variables"][0]["key"], "STUDIO_WORKFLOW");
    assert_eq!(body["variables"][0]["value"], "build.yml");
}

#[tokio::test]
async fn an_issue_is_assigned_to_the_accounts_its_logins_name() {
    let mock = Mock::builder()
        .get_q(
            "/api/v4/users",
            "username=ada",
            Reply::json(json!([{ "id": 7, "username": "ada" }])),
        )
        .get("/api/v4/users", Reply::json(json!([])))
        .route(
            axum::http::Method::POST,
            &format!("{PROJECT}/issues"),
            "",
            Reply::json(json!({ "iid": 12, "web_url": "https://g.example/i/12" })),
        )
        .start()
        .await;
    let issue = mock
        .driver()
        .create_issue(
            &mock.auth(),
            "acme/platform/app",
            "Gap",
            "Body",
            &["ada".to_string(), "ghost".to_string()],
        )
        .await
        .unwrap();
    assert_eq!(issue.number, 12);
    let body = mock.calls(&format!("{PROJECT}/issues"))[0]
        .body
        .clone()
        .unwrap();
    assert_eq!(body["assignee_ids"], json!([7]));
}

/* ── Releases, artifacts and downloads ── */

#[tokio::test]
async fn a_release_is_keyed_by_its_tag_and_its_links_are_its_files() {
    let mock = Mock::builder()
        .get(
            &format!("{PROJECT}/releases"),
            Reply::json(json!([{
                "tag_name": "v1.2.0", "name": "1.2", "released_at": "2026-11-20T00:00:00Z",
                "upcoming_release": false,
                "_links": { "self": "https://g.example/acme/platform/app/-/releases/v1.2.0" },
                "assets": { "links": [
                    { "id": 31, "name": "app.tgz", "url": "https://files.example/app.tgz",
                      "link_type": "package" }
                ] }
            }])),
        )
        .start()
        .await;
    let driver = mock.driver();
    let releases = driver
        .list_releases(&mock.auth(), "acme/platform/app", 1, 100)
        .await
        .unwrap();
    let r = &releases[0];
    assert_eq!(r.id, super::outputs::release_id("v1.2.0"));
    assert_eq!(r.tag, "v1.2.0");
    assert_eq!(r.assets[0].id, 31);
    // A link outside the installation is the file's own address.
    let link = driver
        .download_link(
            &mock.auth(),
            "acme/platform/app",
            super::super::driver::DownloadTarget::ReleaseAsset(31),
        )
        .await
        .unwrap();
    assert_eq!(link, "https://files.example/app.tgz");
}

#[tokio::test]
async fn jobs_with_an_archive_are_the_build_artifacts_all_on_the_first_page() {
    let mock = Mock::builder()
        .get(
            &format!("{PROJECT}/jobs"),
            Reply::json(json!([
                { "id": 1, "name": "lint", "artifacts": [{ "file_type": "trace", "size": 1 }] },
                { "id": 2, "name": "studio-build", "ref": "main",
                  "artifacts": [{ "file_type": "archive", "size": 512 }],
                  "pipeline": { "id": 70, "sha": "s1" } }
            ])),
        )
        .start()
        .await;
    let driver = mock.driver();
    let auth = mock.auth();
    let first = driver
        .list_build_artifacts(&auth, "acme/platform/app", 1, 100)
        .await
        .unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!((first[0].id, first[0].run_id), (2, Some(70)));
    assert!(
        driver
            .list_build_artifacts(&auth, "acme/platform/app", 2, 100)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(mock.calls(&format!("{PROJECT}/jobs")).len(), 1);
}

#[tokio::test]
async fn an_artifact_on_object_storage_is_its_signed_link_and_one_served_locally_is_streamed() {
    use super::super::driver::{DownloadNeedsProxy, DownloadTarget};
    let mock = Mock::builder()
        .get(
            &format!("{PROJECT}/jobs/2/artifacts"),
            Reply::status(302).header("location", "{base}/storage/signed?sig=1"),
        )
        .get("/storage/signed", Reply::text("zip-bytes"))
        .get(
            &format!("{PROJECT}/jobs/3/artifacts"),
            Reply::text("local-zip"),
        )
        .start()
        .await;
    let driver = mock.driver();
    let auth = mock.auth();
    let link = driver
        .download_link(&auth, "acme/platform/app", DownloadTarget::BuildArtifact(2))
        .await
        .unwrap();
    assert_eq!(link, format!("{}/storage/signed?sig=1", mock.base));
    let err = driver
        .download_link(&auth, "acme/platform/app", DownloadTarget::BuildArtifact(3))
        .await
        .unwrap_err();
    assert!(err.downcast_ref::<DownloadNeedsProxy>().is_some(), "{err}");

    let local = driver
        .download(&auth, "acme/platform/app", DownloadTarget::BuildArtifact(3))
        .await
        .unwrap();
    assert_eq!(local.text().await.unwrap(), "local-zip");
    let signed = driver
        .download(&auth, "acme/platform/app", DownloadTarget::BuildArtifact(2))
        .await
        .unwrap();
    assert_eq!(signed.text().await.unwrap(), "zip-bytes");
    // The token went to GitLab's API, never to the signed link.
    assert!(
        mock.calls("/storage/signed")
            .iter()
            .all(|c| c.token.is_none())
    );
    assert!(
        mock.calls(&format!("{PROJECT}/jobs/3/artifacts"))
            .iter()
            .all(|c| c.token.as_deref() == Some("glpat-test"))
    );
}

/* ── Reads several at a time: one throttle, the listing's order ── */

/// A driver whose throttle waits are long enough to measure.
fn patient_driver() -> super::GitLabDriver {
    super::GitLabDriver::with_retry(
        reqwest::Client::new(),
        super::client::Retry {
            attempts: 3,
            backoff: std::time::Duration::from_millis(5),
            max_wait: std::time::Duration::from_millis(200),
        },
    )
}

#[tokio::test]
async fn a_throttle_one_read_meets_holds_the_reads_beside_it() {
    let mock = Mock::builder()
        .get(
            &format!("{PROJECT}/merge_requests/1/diffs"),
            Reply::status(429).header("retry-after", "5"),
        )
        .then(Reply::json(json!([{ "new_path": "a.rs" }])))
        .get(
            &format!("{PROJECT}/merge_requests/2/diffs"),
            Reply::json(json!([{ "new_path": "b.rs" }])),
        )
        .start()
        .await;
    let driver = patient_driver();
    let auth = mock.auth();
    let started = std::time::Instant::now();
    let (first, (second, second_done)) = tokio::join!(
        driver.pull_request_files(&auth, "acme/platform/app", 1),
        async {
            // Sent once the first one has been told to wait.
            tokio::time::sleep(std::time::Duration::from_millis(40)).await;
            let files = driver
                .pull_request_files(&auth, "acme/platform/app", 2)
                .await;
            (files, started.elapsed())
        }
    );
    assert_eq!(first.unwrap(), vec!["a.rs".to_string()]);
    assert_eq!(second.unwrap(), vec!["b.rs".to_string()]);
    // The second read was never throttled itself, but it waited out the
    // first one's 429 (capped at 200 ms here) instead of racing into it.
    assert!(
        second_done >= std::time::Duration::from_millis(150),
        "{second_done:?}"
    );
    assert_eq!(
        mock.calls(&format!("{PROJECT}/merge_requests/2/diffs"))
            .len(),
        1
    );
}

#[tokio::test]
async fn a_spent_rate_limit_budget_holds_the_next_request_until_it_resets() {
    let reset = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 30;
    let mock = Mock::builder()
        .get(
            &format!("{PROJECT}/merge_requests/1/diffs"),
            Reply::json(json!([{ "new_path": "a.rs" }]))
                .header("ratelimit-remaining", "0")
                .header("ratelimit-reset", &reset.to_string()),
        )
        .get(
            &format!("{PROJECT}/merge_requests/2/diffs"),
            Reply::json(json!([{ "new_path": "b.rs" }])),
        )
        .start()
        .await;
    let driver = patient_driver();
    let auth = mock.auth();
    // The first answer is good: it is not retried, only the next one waits.
    assert_eq!(
        driver
            .pull_request_files(&auth, "acme/platform/app", 1)
            .await
            .unwrap(),
        vec!["a.rs".to_string()]
    );
    let started = std::time::Instant::now();
    assert_eq!(
        driver
            .pull_request_files(&auth, "acme/platform/app", 2)
            .await
            .unwrap(),
        vec!["b.rs".to_string()]
    );
    assert!(
        started.elapsed() >= std::time::Duration::from_millis(150),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(
        mock.calls(&format!("{PROJECT}/merge_requests/1/diffs"))
            .len(),
        1
    );
}

#[tokio::test]
async fn merge_requests_read_several_at_once_keep_the_listing_order() {
    // More open merge requests with reviewers than are read at once, so the
    // discussions go out in overlapping waves.
    let iids: Vec<i64> = (1..=15).collect();
    let listing: Vec<serde_json::Value> = iids
        .iter()
        .map(|&iid| {
            mr(
                1000 + iid,
                iid,
                json!({ "reviewers": [{ "username": format!("rev{iid}") }] }),
            )
        })
        .collect();
    let mut builder = Mock::builder().get_q(
        &format!("{PROJECT}/merge_requests"),
        "state=all",
        Reply::json(json!(listing)),
    );
    for iid in &iids {
        builder = builder.get(
            &format!("{PROJECT}/merge_requests/{iid}/discussions"),
            Reply::json(json!([])),
        );
    }
    let mock = builder.start().await;
    let prs = mock
        .driver()
        .list_pull_requests(&mock.auth(), "acme/platform/app", None, 1, 100)
        .await
        .unwrap();
    assert_eq!(prs.iter().map(|p| p.number).collect::<Vec<_>>(), iids);
    for p in &prs {
        // Nobody has said anything: each still owes their own review, and
        // no answer ended up on another merge request.
        assert_eq!(p.requested_reviewers, vec![format!("rev{}", p.number)]);
    }
    assert_eq!(
        mock.seen()
            .iter()
            .filter(|s| s.path.ends_with("/discussions"))
            .count(),
        iids.len()
    );
}
