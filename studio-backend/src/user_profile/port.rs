//! The core's Inbox port (ADR-0079 §4): what waits on a person is read from
//! the kits' sources, and studio-user only collects them.
//!
//! Two registrations, one per reader:
//!
//! - [`InboxSource`] — a source of `GET /studio-user/v1/me/inbox` a kit's
//!   gear reads itself, per workspace, as the person (`review-requests`,
//!   `pull-requests`). Its kit lists it in its `kit.json` as a `studio`
//!   source with the same id; the Inbox reads it only while that kit applies
//!   to the organization.
//! - [`InboxToolSource`] — a kind of item of the MCP `inbox` tool (`deploy`,
//!   `review`, `pull`), with the tool to call to act on it.
//!
//! A kit's gear submits either in its own module:
//!
//! ```ignore
//! inventory::submit! {
//!     crate::user_profile::port::InboxSource {
//!         id: "review-requests",
//!         gear: "studio-documents",
//!         order: 10,
//!         first_at_equal_due: true,
//!         read: read_reviews,
//!         items: review_items,
//!     }
//! }
//! ```
//!
//! The kits' declarative sources (`query`, `endpoint` in `kit.json`) need no
//! code and are not registered here.

use std::future::Future;
use std::pin::Pin;

use serde_json::Value;
use time::OffsetDateTime;

pub use super::inbox::Item;
pub use crate::mcp::sdk::{Api, ToolError};

/// What a source read in one workspace.
pub struct WorkspaceRows {
    /// Its records, as its route answers them.
    pub rows: Vec<Value>,
    /// Why it could not be read (all or part of it), for the Inbox to name.
    pub failed: Option<String>,
    /// Whether every account in its records was matched to the
    /// organization's members: when not, "nothing waits on you" may mean
    /// "your account is not known".
    pub members_known: bool,
}

impl WorkspaceRows {
    /// Nothing, read or not.
    pub fn none() -> Self {
        Self {
            rows: Vec::new(),
            failed: None,
            members_known: true,
        }
    }
}

pub type RowsFuture = Pin<Box<dyn Future<Output = WorkspaceRows> + Send>>;

/// A source of a person's Inbox that its kit's gear reads per workspace.
pub struct InboxSource {
    /// Its id, as its items' `source` and its kit's `studio` source name it.
    pub id: &'static str,
    /// The gear that reads it, for readers of the registry.
    #[allow(dead_code, reason = "named for readers of the registry")]
    pub gear: &'static str,
    /// Where its items stand among the sources' (every workspace's of one
    /// source before the next source's), lowest first.
    pub order: u16,
    /// Whether, at an equal due date, its items come before every other
    /// source's (a review asked of the person before a pull request).
    pub first_at_equal_due: bool,
    /// Its records in one workspace (the id), read as the person.
    pub read: fn(Api, String) -> RowsFuture,
    /// The records as items of the workspace `(id, name)`, in the order the
    /// person answers them.
    pub items: fn(&str, &str, Vec<Value>) -> Vec<Item>,
}

inventory::collect!(InboxSource);

/// Every registered source, lowest `order` first, then by id.
pub fn sources() -> Vec<&'static InboxSource> {
    let mut out: Vec<&'static InboxSource> = inventory::iter::<InboxSource>.into_iter().collect();
    out.sort_by_key(|s| (s.order, s.id));
    out
}

/// Whether an item of `source` comes first at an equal due date.
pub fn first_at_equal_due(source: &str) -> bool {
    inventory::iter::<InboxSource>
        .into_iter()
        .any(|s| s.id == source && s.first_at_equal_due)
}

/// Who asks the MCP `inbox` tool, and where.
#[derive(Clone)]
pub struct InboxScope {
    pub organization_id: String,
    /// The organization's workspaces.
    pub workspaces: Vec<String>,
    /// The ids the person is known by: their sign-in subject, their Studio
    /// profile.
    pub me: Vec<String>,
    pub now: OffsetDateTime,
}

pub type ToolItemsFuture = Pin<Box<dyn Future<Output = Result<Vec<Value>, ToolError>> + Send>>;

/// One kind of item of the MCP `inbox` tool: each item says how to act on it
/// (`act`).
pub struct InboxToolSource {
    /// Each item's `source`: `deploy`, `review`, `pull`.
    pub kind: &'static str,
    /// Where its items are listed when nothing else orders them, lowest first.
    pub order: u16,
    pub read: fn(Api, InboxScope) -> ToolItemsFuture,
}

inventory::collect!(InboxToolSource);

/// Every registered kind, lowest `order` first, then by kind.
pub fn tool_sources() -> Vec<&'static InboxToolSource> {
    let mut out: Vec<&'static InboxToolSource> =
        inventory::iter::<InboxToolSource>.into_iter().collect();
    out.sort_by_key(|s| (s.order, s.kind));
    out
}

/// `GET path` with `query` as the person; a route this deployment does not
/// have (404) is a source with nothing to say.
pub async fn list_or_none(
    api: &Api,
    path: &str,
    query: &[(String, String)],
) -> Result<Value, ToolError> {
    let answer = api.get_answer(path, query).await?;
    match answer.status {
        404 => Ok(serde_json::json!({ "items": [] })),
        _ if answer.ok() => Ok(answer.body),
        _ => Err(answer.refusal()),
    }
}

/// A field's text, `""` when it has none.
pub fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or_default()
}
