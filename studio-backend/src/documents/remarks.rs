//! Review remarks on one document, from every pull request that touched it,
//! and the decisions recorded on its requirements (`docs/design/studio-documents.md`,
//! "Remarks and decisions"; issue #735).
//!
//! Interview problems 2.1, 2.5, 2.6: remarks arrive in several tools and are
//! moved by hand; an unresolved remark stays behind in a closed pull request
//! once it merges; decisions taken on calls never reach the document. A
//! document's remarks are read from the repository host each time — the
//! threads of the open pull requests that change it and of the pull requests
//! its history came from — so a remark left open after a merge is still on
//! the document, marked as such. A reply goes back to the thread it answers.

use serde_json::{Value, json};

/// The one GraphQL query: the pull requests the document's last commits came
/// from, the open ones (with their files, to keep those that change it), and
/// every review thread of each.
pub const REMARKS_QUERY: &str = r#"
query($owner: String!, $name: String!, $path: String!, $ref: String!) {
  repository(owner: $owner, name: $name) {
    object(expression: $ref) {
      ... on Commit {
        history(path: $path, first: 20) {
          nodes { associatedPullRequests(first: 2) { nodes { ...pr } } }
        }
      }
    }
    pullRequests(states: OPEN, first: 30, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { ...pr files(first: 100) { nodes { path } } }
    }
  }
}
fragment pr on PullRequest {
  number title url state
  reviewThreads(first: 50) {
    nodes {
      id isResolved isOutdated path line
      comments(first: 30) { nodes { databaseId author { login } body url createdAt } }
    }
  }
}
"#;

/// The reply mutation: answers in the thread the remark was made in.
pub const REPLY_MUTATION: &str = r#"
mutation($thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $thread, body: $body}) {
    comment { databaseId url createdAt author { login } body }
  }
}
"#;

pub fn remarks_request(owner: &str, name: &str, path: &str, git_ref: &str) -> Value {
    json!({
        "query": REMARKS_QUERY,
        "variables": { "owner": owner, "name": name, "path": path, "ref": git_ref },
    })
}

pub fn reply_request(thread_id: &str, body: &str) -> Value {
    json!({ "query": REPLY_MUTATION, "variables": { "thread": thread_id, "body": body } })
}

/// One comment of a thread.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Comment {
    pub author: Option<String>,
    pub body: String,
    pub url: Option<String>,
    pub created_at: Option<String>,
}

/// One review thread on the document.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Thread {
    /// The host's node id, for a reply.
    pub id: String,
    pub pull_number: i64,
    pub pull_title: String,
    pub pull_url: Option<String>,
    /// `OPEN`, `CLOSED` or `MERGED`.
    pub pull_state: String,
    pub resolved: bool,
    /// The line it was made on no longer exists as it was.
    pub outdated: bool,
    pub line: Option<i64>,
    pub comments: Vec<Comment>,
}

impl Thread {
    /// Unresolved in a pull request that is no longer open: the remark the
    /// merge left behind.
    pub fn left_open(&self) -> bool {
        !self.resolved && self.pull_state != "OPEN"
    }
}

fn str_at<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn threads_of(
    pr: &Value,
    path: &str,
    out: &mut Vec<Thread>,
    seen: &mut std::collections::BTreeSet<String>,
) {
    let number = pr.get("number").and_then(Value::as_i64).unwrap_or_default();
    let nodes = pr
        .pointer("/reviewThreads/nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for t in nodes {
        if str_at(&t, "path") != Some(path) {
            continue;
        }
        let Some(id) = str_at(&t, "id") else {
            continue;
        };
        if !seen.insert(id.to_string()) {
            continue;
        }
        let comments = t
            .pointer("/comments/nodes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|c| Comment {
                author: c
                    .pointer("/author/login")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                body: str_at(c, "body").unwrap_or_default().to_string(),
                url: str_at(c, "url").map(str::to_string),
                created_at: str_at(c, "createdAt").map(str::to_string),
            })
            .collect();
        out.push(Thread {
            id: id.to_string(),
            pull_number: number,
            pull_title: str_at(pr, "title").unwrap_or_default().to_string(),
            pull_url: str_at(pr, "url").map(str::to_string),
            pull_state: str_at(pr, "state").unwrap_or("OPEN").to_string(),
            resolved: t
                .get("isResolved")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            outdated: t
                .get("isOutdated")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            line: t.get("line").and_then(Value::as_i64),
            comments,
        });
    }
}

/// The threads on `path` in a [`REMARKS_QUERY`] answer: unresolved first —
/// those left open after a merge before those still in review — then the
/// newest pull request first.
pub fn read_remarks(answer: &Value, path: &str) -> Result<Vec<Thread>, String> {
    if let Some(e) = answer.pointer("/errors/0/message").and_then(Value::as_str) {
        return Err(e.to_string());
    }
    let repo = answer.pointer("/data/repository").unwrap_or(&Value::Null);
    let mut out = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    let history = repo
        .pointer("/object/history/nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for commit in history {
        for pr in commit
            .pointer("/associatedPullRequests/nodes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            threads_of(&pr, path, &mut out, &mut seen);
        }
    }
    for pr in repo
        .pointer("/pullRequests/nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let changes_it = pr
            .pointer("/files/nodes")
            .and_then(Value::as_array)
            .is_some_and(|f| f.iter().any(|f| str_at(f, "path") == Some(path)));
        if changes_it {
            threads_of(&pr, path, &mut out, &mut seen);
        }
    }
    out.sort_by(|a, b| {
        let rank = |t: &Thread| match (t.resolved, t.left_open()) {
            (false, true) => 0,
            (false, false) => 1,
            _ => 2,
        };
        rank(a)
            .cmp(&rank(b))
            .then(b.pull_number.cmp(&a.pull_number))
    });
    Ok(out)
}

/// The comment a reply mutation answered with.
pub fn read_reply(answer: &Value) -> Result<Comment, String> {
    if let Some(e) = answer.pointer("/errors/0/message").and_then(Value::as_str) {
        return Err(e.to_string());
    }
    let c = answer
        .pointer("/data/addPullRequestReviewThreadReply/comment")
        .ok_or("the host did not return the reply")?;
    Ok(Comment {
        author: c
            .pointer("/author/login")
            .and_then(Value::as_str)
            .map(str::to_string),
        body: str_at(c, "body").unwrap_or_default().to_string(),
        url: str_at(c, "url").map(str::to_string),
        created_at: str_at(c, "createdAt").map(str::to_string),
    })
}

/// The labelled identifiers a text names (`cpt-…` and the like): what a
/// decision taken in a thread closes.
pub fn identifiers_in(text: &str) -> Vec<String> {
    let mut out: Vec<String> = text
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
        .map(|w| w.trim_matches('-'))
        .filter(|w| {
            let parts: Vec<&str> = w.split('-').collect();
            parts.len() >= 3
                && parts.iter().all(|p| {
                    !p.is_empty()
                        && p.chars()
                            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
                })
                && parts[0].chars().all(|c| c.is_ascii_lowercase())
        })
        .map(str::to_string)
        .collect();
    out.sort();
    out.dedup();
    out
}

#[cfg(test)]
#[path = "remarks_tests.rs"]
mod tests;
