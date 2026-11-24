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
