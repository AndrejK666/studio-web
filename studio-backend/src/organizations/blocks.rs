//! The core's Overview port (ADR-0079 §4): the blocks an organization's
//! Overview shows are the kits', and the core only collects them.
//!
//! A kit's gear registers its block in its own module:
//!
//! ```ignore
//! inventory::submit! {
//!     crate::organizations::port::OverviewBlock {
//!         kit: "org-costs",
//!         gear: "studio-usage",
//!         id: "spend",
//!         order: 10,
//!         level: crate::organizations::port::Level::Organization,
//!         source: &SpendBlock,
//!     }
//! }
//! ```
//!
//! studio-organizations names no kit's gear: it reads the organization's
//! tree (workspaces, projects, members, background runs), asks every block
//! registered for the level whose kit applies to the organization, and
//! returns them in `blocks`, lowest `order` first. A block of a kit not
//! installed for the organization is not asked and not shown.
//!
//! **What a block gives back** ([`BlockAnswer`]):
//!
//! - a **tile**: a title, a figure, quieter lines and where its figures come
//!   from, in the kit's own words ([`Words`]) with the numbers as arguments
//!   the portal formats ([`LineDto`]) -- so the portal draws any kit's tile
//!   without knowing the kit;
//! - **needs**: what waits on the organization's leaders, worded the same way;
//! - **signals** the core's own rules read: spend and stuck work per project
//!   (a project's health and its workspace's place in the list), and who was
//!   seen at work (who is idle);
//! - **data**: the block's figures as JSON, for a screen that wants more
//!   than the tile.
//!
//! A block is asked in two steps, so its reads do not wait on the core's:
//! [`BlockSource::prepare`] starts with the organization alone, beside the
//! core's reads of the tree; [`BlockSource::answer`] gets the tree.

use std::any::Any;
use std::collections::{BTreeMap, BTreeSet};

use async_trait::async_trait;
use serde_json::Value;
use time::OffsetDateTime;
use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;
use uuid::Uuid;

#[cfg(test)]
pub use super::overview::windows;
pub use super::overview::{GROWTH_ALERT, Row, STUCK_DAYS, Windows, growth, median};
pub use super::status::Kits;
pub use crate::user_profile::RosterMember;

/// Where a block is drawn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    /// Organization › Overview.
    Organization,
    /// Project › Overview (not collected yet: the project's status still
    /// composes its kits' parts itself).
    #[allow(dead_code, reason = "the project overview is the port's next step")]
    Project,
}

/// A block, registered by the kit gear that computes it.
pub struct OverviewBlock {
    /// The kit it belongs to: shown only where that kit is installed.
    pub kit: &'static str,
    /// The gear that computes it (`studio-usage`), for logs.
    pub gear: &'static str,
    /// Its name inside the kit (`spend`); `kit/id` is unique.
    pub id: &'static str,
    /// Where it stands among the blocks, lowest first.
    pub order: u16,
    pub level: Level,
    pub source: &'static dyn BlockSource,
}

inventory::collect!(OverviewBlock);

/// Every registered block of `level`, lowest `order` first, then by id.
pub fn registered(level: Level) -> Vec<&'static OverviewBlock> {
    let mut out: Vec<&'static OverviewBlock> = inventory::iter::<OverviewBlock>
        .into_iter()
        .filter(|b| b.level == level)
        .filter(|b| crate::composition::contributes(b.gear) && crate::composition::kit_on(b.kit))
        .collect();
    out.sort_by(|a, b| {
        a.order
            .cmp(&b.order)
            .then(a.kit.cmp(b.kit))
            .then(a.id.cmp(b.id))
    });
    out
}

/// The blocks of `level` that apply where `kits` are installed.
pub fn applicable(level: Level, kits: &Kits) -> Vec<&'static OverviewBlock> {
    registered(level)
        .into_iter()
        .filter(|b| kits.has(Some(b.kit)))
        .collect()
}

/// What a block is asked for before the tree is read.
#[derive(Clone, Copy, Debug)]
pub struct BlockAt {
    pub organization: Uuid,
    /// The periods the overview compares.
    pub windows: Windows,
    #[allow(
        dead_code,
        reason = "part of the block contract; no block reads it yet"
    )]
    pub now: OffsetDateTime,
    /// Only the signals one project's health reads (`project-status`): no
    /// tile, no needs, and nothing read only for them.
    pub health_only: bool,
}

/// The organization as the core read it, for a block's answer.
pub struct BlockScope<'a> {
    pub at: &'a BlockAt,
    #[allow(
        dead_code,
        reason = "part of the block contract; no block reads it yet"
    )]
    pub organization_name: &'a str,
    /// The workspaces' and projects' rows; one project's alone when
    /// [`BlockAt::health_only`].
    pub rows: &'a [Row],
    /// Every tenant's name a figure can be keyed by: the organization, its
    /// workspaces and projects.
    pub places: &'a BTreeMap<String, String>,
    /// The organization's active members; `None` when they could not be read.
    pub members: Option<&'a [RosterMember]>,
    /// Person id to display name.
    pub names: &'a BTreeMap<String, String>,
}

impl BlockScope<'_> {
    /// The project rows (not the workspaces').
    pub fn projects(&self) -> impl Iterator<Item = &Row> {
        self.rows.iter().filter(|r| r.workspace.is_some())
    }
}

/// What a block read before the tree was in, handed back to its answer.
pub type Prepared = Box<dyn Any + Send + Sync>;

#[async_trait]
pub trait BlockSource: Send + Sync {
    /// Reads that need only the organization, started beside the core's.
    async fn prepare(&self, _hub: &ClientHub, _ctx: &SecurityContext, _at: &BlockAt) -> Prepared {
        Box::new(())
    }

    /// The block, from what [`Self::prepare`] read and the tree. `None`
    /// leaves the block out (its source is not in this assembly).
    async fn answer(
        &self,
        hub: &ClientHub,
        ctx: &SecurityContext,
        prepared: Prepared,
        scope: &BlockScope<'_>,
    ) -> Option<BlockAnswer>;
}

/// Who a block saw at work in the period, for the idle-people rule.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum Activity {
    /// The block says nothing about people.
    #[default]
    Silent,
    /// It would, but could not tell (its source could not be read or is
    /// not the caller's to see): nobody can be called idle.
    Unknown,
    /// These people (person ids).
    Seen(BTreeSet<String>),
}

/// What the core's own rules read off a block.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Signals {
    /// Spend per tenant (id) over the period and the one before; `None`
    /// when this block does not say, or it is unknown.
    pub spend: Option<BTreeMap<String, f64>>,
    pub previous: Option<BTreeMap<String, f64>>,
    /// The currency spend is in.
    pub currency: Option<String>,
    /// Stuck work per project (id); `None` when this block does not say.
    pub stuck: Option<BTreeMap<String, u32>>,
    pub activity: Activity,
}

/// One block's answer.
#[derive(Clone, Debug, Default)]
pub struct BlockAnswer {
    pub tile: Option<TileDto>,
    pub needs: Vec<BlockNeedDto>,
    pub signals: Signals,
    pub data: Value,
}

/// Every block's signals, merged: the first block to say spend says it,
/// stuck work adds up, and anyone unknown makes idleness unknown.
pub fn merge(signals: impl IntoIterator<Item = Signals>) -> Signals {
    let mut out = Signals::default();
    for s in signals {
        if out.spend.is_none() {
            out.spend = s.spend;
            out.previous = s.previous;
            out.currency = s.currency;
        }
        if let Some(stuck) = s.stuck {
            let into = out.stuck.get_or_insert_with(BTreeMap::new);
            for (k, n) in stuck {
                *into.entry(k).or_default() += n;
            }
        }
        out.activity = match (out.activity, s.activity) {
            (Activity::Unknown, _) | (_, Activity::Unknown) => Activity::Unknown,
            (Activity::Silent, other) | (other, Activity::Silent) => other,
            (Activity::Seen(mut a), Activity::Seen(b)) => {
                a.extend(b);
                Activity::Seen(a)
            }
        };
    }
    out
}

/// Every block's [`BlockSource::prepare`], side by side, in the blocks' order.
pub async fn prepare_all(
    blocks: &[&'static OverviewBlock],
    hub: &ClientHub,
    ctx: &SecurityContext,
    at: &BlockAt,
) -> Vec<Prepared> {
    futures_util::future::join_all(blocks.iter().map(|b| b.source.prepare(hub, ctx, at))).await
}

/// Every block's [`BlockSource::answer`], side by side, in the blocks'
/// order; a block that answers `None` is left out.
pub async fn answer_all(
    blocks: &[&'static OverviewBlock],
    prepared: Vec<Prepared>,
    hub: &ClientHub,
    ctx: &SecurityContext,
    scope: &BlockScope<'_>,
) -> Vec<(&'static OverviewBlock, BlockAnswer)> {
    let answers =
        futures_util::future::join_all(blocks.iter().zip(prepared).map(|(b, p)| async move {
            b.source.answer(hub, ctx, p, scope).await.map(|a| (*b, a))
        }))
        .await;
    answers.into_iter().flatten().collect()
}

// ── What the portal draws ────────────────────────────────────────────────────

/// Words in each language the portal speaks, by language tag (`en`, `ru`).
/// `en` is always there; the portal falls back to it. A `{name}` is an
/// argument of the line ([`LineDto::args`]).
pub type Words = BTreeMap<String, String>;

/// Words in English and Russian.
pub fn words(en: &str, ru: &str) -> Words {
    BTreeMap::from([
        ("en".to_owned(), en.to_owned()),
        ("ru".to_owned(), ru.to_owned()),
    ])
}

/// Words in English only.
pub fn english(en: &str) -> Words {
    BTreeMap::from([("en".to_owned(), en.to_owned())])
}

/// One line of words with its arguments, formatted by the portal in the
/// reader's language.
#[derive(Debug, Clone, Default)]
#[toolkit_macros::api_dto(response)]
pub struct LineDto {
    pub text: Words,
    pub args: BTreeMap<String, ArgDto>,
}

/// One argument: `money` (`value` in `currency`), `count` (`value`, null
/// for unknown), `share` (`value`, a share, `+23%`), or `text` (`text`).
#[derive(Debug, Clone, Default, PartialEq)]
#[toolkit_macros::api_dto(response)]
pub struct ArgDto {
    pub kind: String,
    pub value: Option<f64>,
    pub currency: Option<String>,
    pub text: Option<String>,
}

impl LineDto {
    pub fn new(text: Words) -> Self {
        Self {
            text,
            args: BTreeMap::new(),
        }
    }

    pub fn money(mut self, name: &str, value: f64, currency: &str) -> Self {
        self.args.insert(
            name.to_owned(),
            ArgDto {
                kind: "money".into(),
                value: Some(value),
                currency: Some(currency.to_owned()),
                text: None,
            },
        );
        self
    }

    /// A number; `None` is said as unknown, never as zero.
    pub fn count(mut self, name: &str, value: Option<f64>) -> Self {
        self.args.insert(
            name.to_owned(),
            ArgDto {
                kind: "count".into(),
                value,
                ..ArgDto::default()
            },
        );
        self
    }

    pub fn text(mut self, name: &str, text: impl Into<String>) -> Self {
        self.args.insert(
            name.to_owned(),
            ArgDto {
                kind: "text".into(),
                text: Some(text.into()),
                ..ArgDto::default()
            },
        );
        self
    }
}

/// Where something leads: a screen at `route` (with `view` in it), or, with
/// `project_id`, that screen inside the project. The portal offers it only
/// where the screen shows.
#[derive(Debug, Clone, Default)]
#[toolkit_macros::api_dto(response)]
pub struct LinkDto {
    pub route: String,
    pub view: Option<String>,
    pub label: Words,
    pub workspace_id: Option<String>,
    pub project_id: Option<String>,
}

impl LinkDto {
    pub fn to(route: &str, label: Words) -> Self {
        Self {
            route: route.to_owned(),
            label,
            ..Self::default()
        }
    }
}

/// A list a tile folds out, each row leading somewhere.
#[derive(Debug, Clone, Default)]
#[toolkit_macros::api_dto(response)]
pub struct ItemsDto {
    /// The button that folds it out.
    pub label: Words,
    pub rows: Vec<OverviewItemDto>,
}

#[derive(Debug, Clone, Default)]
#[toolkit_macros::api_dto(response)]
pub struct OverviewItemDto {
    pub text: LineDto,
    pub link: LinkDto,
}

/// A tile: a title, its figure, quieter lines under it, where its figures
/// come from, and a list it folds out.
#[derive(Debug, Clone, Default)]
#[toolkit_macros::api_dto(response)]
pub struct TileDto {
    pub title: Words,
    pub value: Option<LineDto>,
    pub lines: Vec<LineDto>,
    pub link: Option<LinkDto>,
    pub items: Option<ItemsDto>,
}

/// Something that waits on the organization's leaders, in the kit's words.
#[derive(Debug, Clone, Default)]
#[toolkit_macros::api_dto(response)]
pub struct BlockNeedDto {
    /// Stable within the block (`queue:<person>`).
    pub key: String,
    /// `danger`, `warn` or `info`.
    pub tone: String,
    pub sentence: LineDto,
    pub detail: Option<LineDto>,
    /// Where it is answered.
    pub action: Option<LinkDto>,
    /// What it is about, folded out instead of the action.
    pub details: Option<DetailsDto>,
}

#[derive(Debug, Clone, Default)]
#[toolkit_macros::api_dto(response)]
pub struct DetailsDto {
    /// The button that folds them out.
    pub label: Words,
    pub rows: Vec<DetailRowDto>,
}

#[derive(Debug, Clone, Default)]
#[toolkit_macros::api_dto(response)]
pub struct DetailRowDto {
    pub text: String,
    /// An `http(s)` address it opens, in a new tab.
    pub href: Option<String>,
    /// What follows it, quieter.
    pub note: Vec<LineDto>,
}

/// One block of the overview, as the portal reads it.
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(response)]
pub struct OverviewBlockDto {
    pub kit: String,
    pub id: String,
    pub order: u16,
    /// Null for a block with nothing to draw on its own (its needs still are).
    pub tile: Option<TileDto>,
    pub needs: Vec<BlockNeedDto>,
    /// The block's figures, the kit's own shape.
    pub data: Value,
}

impl OverviewBlockDto {
    pub fn of(block: &OverviewBlock, answer: BlockAnswer) -> Self {
        Self {
            kit: block.kit.to_owned(),
            id: block.id.to_owned(),
            order: block.order,
            tile: answer.tile,
            needs: answer.needs,
            data: answer.data,
        }
    }
}

#[cfg(test)]
#[path = "blocks_tests.rs"]
mod tests;
