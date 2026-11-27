//! Where a sync's listings got to, kept on the repository node so the next
//! attempt goes on from there.
//!
//! ## Why
//!
//! A sync lists a repository's issues, pull requests, comments (where the
//! provider has one repository-wide listing) and commits, page by page. On a
//! repository the size of platform/alms/core -- 10,269 merge requests, 20,000
//! commits -- the listings alone ran past the fifteen minutes an attempt holds
//! its lease, and the next attempt listed everything again from page 1 before
//! it got to anything new. Now a listing stops [`LISTING_TAIL`] short of the
//! attempt's deadline, what it read is stored, and the page it got to is
//! written here; the next attempt -- a retry, a retry by hand, the next
//! scheduled sync -- asks for that page again (one page of overlap) and goes
//! on.
//!
//! ## Why on the repository node
//!
//! The same reason [`super::pr_links`] and [`super::item_comments`] keep their
//! marks on the items: the graph survives anything the run does not -- a
//! retry by hand is a new run, a scheduled sync is another run again, and a
//! run's payload is what the route queued, which an attempt cannot change. One
//! field on a node the sync writes anyway (at its start, and at its end) costs
//! nothing extra on a sync that finishes in one attempt.
//!
//! ## Why the page is a good enough place
//!
//! The listings a cursor resumes are ordered so that a page boundary stays put
//! while the repository changes under the walk: issues and pull requests by
//! when they were *created*, newest first (a creation time never moves), and
//! commits newest first. What arrives between two attempts goes in front and
//! only pushes what was read further back, so the page asked again holds the
//! last items read or ones read before them: duplicates, never a gap. Only an
//! item deleted ahead of the cursor pulls the rest forward, and the one page
//! of overlap covers a hundred of those. (Ordered by when they were last
//! *updated*, an item touched between two attempts jumped to the front, and
//! one not read yet was then never read by this walk.) What was created after
//! the walk began is read by the next sync, which starts from page 1.
//!
//! A cursor older than [`TTL`], or one taken with another `since`, is not
//! resumed: the walk starts again.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use super::graph::GtsNode;

/// The repository node's field. Declared in
/// `gts/artifact/nodes/repo.schema.json`.
pub(super) const FIELD: &str = "listing";

/// How long a stopped walk may be resumed. The attempts of one run, backoff
/// included, fit well inside it; a cursor older than this belongs to a walk
/// nobody finished, and what moved since is better read from page 1.
pub(super) const TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// How long before the attempt's deadline a listing stops asking for pages:
/// what it read is stored as it goes, and the edges, the authors and the
/// cursor written when it stops need this much.
pub(super) const LISTING_TAIL: Duration = Duration::from_secs(90);

/// How often a long listing writes its cursor (and the edges and authors of
/// what it read) while it runs, so a crash or a redeploy costs at most this
/// much of it. A listing shorter than this writes nothing extra.
pub(super) const CHECKPOINT_EVERY: Duration = Duration::from_secs(2 * 60);

/// One listing's place.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct Listing {
    /// The last page read, which the next attempt asks for again (the
    /// overlap). 0: none read.
    #[serde(default)]
    pub next: u32,
    /// Items counted before page `next`; when `done`, all of them.
    #[serde(default)]
    pub counted: usize,
    /// Read to its end.
    #[serde(default)]
    pub done: bool,
}

impl Listing {
    /// The page this attempt asks for first.
    pub fn first_page(&self) -> u32 {
        self.next.max(1)
    }

    /// Whether `page` is past the overlap: asking for it is progress.
    pub fn is_new(&self, page: u32) -> bool {
        page > self.next
    }

    /// Page `page` was read and stored, with `before` items counted before it.
    pub fn read(&mut self, page: u32, before: usize) {
        self.next = page;
        self.counted = before;
    }

    /// The listing ended, with `total` items in all.
    pub fn finish(&mut self, total: usize) {
        self.next = 0;
        self.counted = total;
        self.done = true;
    }
}

/// Where one walk of a repository's listings is.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct ListingCursor {
    /// When the walk began (RFC 3339): a cursor past [`TTL`] is not resumed.
    pub started_at: String,
    /// The `since` the walk lists with; another one starts a new walk.
    #[serde(default)]
    pub since: Option<String>,
    #[serde(default)]
    pub issues: Listing,
    #[serde(default)]
    pub pull_requests: Listing,
    /// The repository-wide comment listing; done from the start where
    /// comments are read item by item instead.
    #[serde(default)]
    pub comments: Listing,
    #[serde(default)]
    pub commits: Listing,
    /// Every listing read to its end, and the passes after them (files,
    /// links, comments item by item) still going: the attempts after that do
    /// not list again, they take the items from the graph.
    #[serde(default)]
    pub listed: bool,
}

fn since_of(since: Option<&str>) -> Option<String> {
    since
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

impl ListingCursor {
    /// A walk starting now.
    pub fn fresh(now: OffsetDateTime, since: Option<&str>) -> Self {
        Self {
            started_at: now.format(&Rfc3339).unwrap_or_default(),
            since: since_of(since),
            ..Default::default()
        }
    }

    /// The walk the repository node `prior` says is under way, when it may be
    /// resumed: listed with the same `since`, begun less than [`TTL`] before
    /// `now`. `None` otherwise -- no cursor, a cleared one, an unreadable or a
    /// stale one -- and the walk starts again.
    pub fn resume(prior: Option<&Value>, since: Option<&str>, now: OffsetDateTime) -> Option<Self> {
        let raw = prior?.get(FIELD)?;
        if raw.is_null() {
            return None;
        }
        let cursor: Self = serde_json::from_value(raw.clone()).ok()?;
        if cursor.since != since_of(since) {
            return None;
        }
        let started = OffsetDateTime::parse(&cursor.started_at, &Rfc3339).ok()?;
        let age = now - started;
        if age.is_negative() || age > TTL {
            return None;
        }
        Some(cursor)
    }

    /// Whether an earlier attempt got anywhere: then the items it read are in
    /// the graph and not listed again by this one.
    pub fn progressed(&self) -> bool {
        self.listed
            || [
                &self.issues,
                &self.pull_requests,
                &self.comments,
                &self.commits,
            ]
            .iter()
            .any(|l| l.done || l.next > 0)
    }

    /// Listings not read to their end yet.
    pub fn left(&self) -> usize {
        [
            &self.issues,
            &self.pull_requests,
            &self.comments,
            &self.commits,
        ]
        .iter()
        .filter(|l| !l.done)
        .count()
    }
}

/// Put `cursor` on a repository node -- or `null`, which says no walk is under
/// way and overwrites one an earlier attempt left, whether the store replaces
/// a payload or merges into it.
pub(super) fn put(node: &mut GtsNode, cursor: Option<&ListingCursor>) {
    if let Some(obj) = node.value.as_object_mut() {
        obj.insert(
            FIELD.to_owned(),
            cursor
                .and_then(|c| serde_json::to_value(c).ok())
                .unwrap_or(Value::Null),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn at(s: &str) -> OffsetDateTime {
        OffsetDateTime::parse(s, &Rfc3339).unwrap()
    }

    fn node_with(cursor: &ListingCursor) -> Value {
        json!({ "full_path": "acme/app", FIELD: cursor })
    }

    #[test]
    fn a_walk_under_way_is_resumed_with_its_pages() {
        let mut cursor = ListingCursor::fresh(at("2026-11-26T08:00:00Z"), None);
        cursor.issues.finish(120);
        cursor.pull_requests.read(53, 5_200);
        let back =
            ListingCursor::resume(Some(&node_with(&cursor)), None, at("2026-11-26T08:30:00Z"))
                .expect("resumed");
        assert_eq!(back, cursor);
        assert!(back.progressed());
        assert_eq!(back.left(), 3);
        assert_eq!(back.pull_requests.first_page(), 53);
        assert!(!back.pull_requests.is_new(53), "the overlap page");
        assert!(back.pull_requests.is_new(54));
    }

    #[test]
    fn a_stale_cleared_or_other_since_walk_starts_again() {
        let cursor = ListingCursor::fresh(at("2026-11-25T08:00:00Z"), None);
        let prior = node_with(&cursor);
        assert!(ListingCursor::resume(Some(&prior), None, at("2026-11-26T09:00:00Z")).is_none());
        assert!(
            ListingCursor::resume(
                Some(&prior),
                Some("2026-11-01T00:00:00Z"),
                at("2026-11-25T09:00:00Z")
            )
            .is_none()
        );
        let cleared = json!({ FIELD: null });
        assert!(ListingCursor::resume(Some(&cleared), None, at("2026-11-25T09:00:00Z")).is_none());
        assert!(ListingCursor::resume(None, None, at("2026-11-25T09:00:00Z")).is_none());
        assert!(
            ListingCursor::resume(
                Some(&json!({ FIELD: "garbage" })),
                None,
                at("2026-11-25T09:00:00Z")
            )
            .is_none()
        );
    }

    #[test]
    fn a_fresh_walk_has_got_nowhere_and_lists_from_page_one() {
        let cursor = ListingCursor::fresh(at("2026-11-26T08:00:00Z"), Some(" "));
        assert!(!cursor.progressed());
        assert_eq!(cursor.left(), 4);
        assert_eq!(cursor.since, None, "a blank since is none");
        assert_eq!(cursor.issues.first_page(), 1);
        assert!(cursor.issues.is_new(1));
    }

    #[test]
    fn put_writes_the_cursor_or_a_null_over_it() {
        let mut node = GtsNode {
            type_id: "t",
            instance_id: "r".into(),
            value: json!({ "full_path": "acme/app" }),
        };
        let cursor = ListingCursor::fresh(at("2026-11-26T08:00:00Z"), None);
        put(&mut node, Some(&cursor));
        assert_eq!(node.value[FIELD]["started_at"], "2026-11-26T08:00:00Z");
        put(&mut node, None);
        assert!(node.value[FIELD].is_null());
    }
}
