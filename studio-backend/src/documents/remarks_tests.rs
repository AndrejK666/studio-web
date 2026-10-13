use super::*;

fn pr(number: i64, state: &str, threads: Value) -> Value {
    json!({ "number": number, "title": format!("PR {number}"), "url": format!("https://x/{number}"),
            "state": state, "reviewThreads": { "nodes": threads } })
}

fn thread(id: &str, path: &str, resolved: bool, body: &str) -> Value {
    json!({ "id": id, "isResolved": resolved, "isOutdated": false, "path": path, "line": 12,
            "comments": { "nodes": [ { "databaseId": 1, "author": { "login": "ann" }, "body": body,
                                        "url": "https://x/c", "createdAt": "2026-10-01T10:00:00Z" } ] } })
}

#[test]
fn threads_on_the_document_come_from_its_history_and_its_open_pull_requests() {
    let merged = pr(
        3,
        "MERGED",
        json!([
            thread(
                "t1",
                "docs/prd.md",
                false,
                "Should this be 50 MB? cpt-app-fr-limit"
            ),
            thread("t2", "docs/prd.md", true, "typo"),
            thread("t3", "src/lib.rs", false, "not ours"),
        ]),
    );
    let mut open = pr(
        9,
        "OPEN",
        json!([thread("t4", "docs/prd.md", false, "rename the role")]),
    );
    open["files"] = json!({ "nodes": [ { "path": "docs/prd.md" } ] });
    let mut elsewhere = pr(10, "OPEN", json!([thread("t5", "docs/prd.md", false, "x")]));
    elsewhere["files"] = json!({ "nodes": [ { "path": "README.md" } ] });
    let answer = json!({ "data": { "repository": {
        "object": { "history": { "nodes": [
            { "associatedPullRequests": { "nodes": [ merged.clone() ] } },
            { "associatedPullRequests": { "nodes": [ merged ] } }
        ] } },
        "pullRequests": { "nodes": [ open, elsewhere ] }
    } } });
    let threads = read_remarks(&answer, "docs/prd.md").expect("read");
    let ids: Vec<&str> = threads.iter().map(|t| t.id.as_str()).collect();
    // Left open after the merge first, then still in review, then resolved;
    // a pull request that does not change the document is not read; a pull
    // request seen twice in the history is read once.
    assert_eq!(ids, ["t1", "t4", "t2"]);
    assert!(threads[0].left_open());
    assert!(!threads[1].left_open());
    assert_eq!(threads[0].comments[0].author.as_deref(), Some("ann"));
    assert_eq!(threads[0].line, Some(12));
}

#[test]
fn a_host_error_is_said() {
    let answer = json!({ "errors": [ { "message": "Could not resolve to a Repository" } ] });
    assert!(read_remarks(&answer, "x").is_err());
}

#[test]
fn a_reply_is_read_back() {
    let answer = json!({ "data": { "addPullRequestReviewThreadReply": { "comment": {
        "databaseId": 5, "url": "https://x/r", "createdAt": "2026-10-14T09:00:00Z",
        "author": { "login": "me" }, "body": "done" } } } });
    let c = read_reply(&answer).expect("reply");
    assert_eq!(c.body, "done");
    assert_eq!(c.author.as_deref(), Some("me"));
}

#[test]
fn identifiers_are_found_in_a_thread() {
    assert_eq!(
        identifiers_in("See cpt-app-fr-limit and (cpt-app-nfr-2); not this-one or Cpt-X-y."),
        ["cpt-app-fr-limit", "cpt-app-nfr-2"]
    );
}
