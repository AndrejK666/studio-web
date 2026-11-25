//! The Decisions block of an organization's Overview (the Components kit's
//! contribution through the core's Overview port, ADR-0079 §4): the
//! registry's components that wait for the organization to decide.
//!
//! It draws no tile of its own; what it says is a need of the leaders.

use async_trait::async_trait;
use serde_json::json;
use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;

use super::port::Registry;
use crate::organizations::port::{
    BlockAnswer, BlockAt, BlockNeedDto, BlockScope, BlockSource, Level, LineDto, LinkDto,
    OverviewBlock, Prepared, english,
};

/// The kit the registry is.
pub const COMPONENTS_KIT: &str = "components";
/// The Components screen, and its view of what waits for a decision.
const COMPONENTS_ROUTE: &str = "/components";
const NEEDS_DECISION_VIEW: &str = "needs-decision";

inventory::submit! {
    OverviewBlock {
        kit: COMPONENTS_KIT,
        gear: "studio-components-catalog",
        id: "decisions",
        order: 40,
        level: Level::Organization,
        source: &DecisionsBlock,
    }
}

pub struct DecisionsBlock;

/// The registry entries' states; `None` when the registry could not be read.
type States = Option<Vec<String>>;

#[async_trait]
impl BlockSource for DecisionsBlock {
    async fn prepare(&self, hub: &ClientHub, ctx: &SecurityContext, at: &BlockAt) -> Prepared {
        if at.health_only {
            return Box::new(None::<Vec<String>>);
        }
        let states: States = match hub.get::<dyn Registry>() {
            Ok(registry) => registry
                .entries(ctx, at.organization)
                .await
                .ok()
                .map(|es| es.into_iter().map(|e| e.entry.state).collect()),
            Err(_) => None,
        };
        Box::new(states)
    }

    async fn answer(
        &self,
        _hub: &ClientHub,
        _ctx: &SecurityContext,
        prepared: Prepared,
        _scope: &BlockScope<'_>,
    ) -> Option<BlockAnswer> {
        let states = (*prepared.downcast::<States>().ok()?)?;
        Some(answer(&states))
    }
}

/// The block, from the registry entries' states.
pub fn answer(states: &[String]) -> BlockAnswer {
    let count =
        |s: &str| u32::try_from(states.iter().filter(|x| *x == s).count()).unwrap_or(u32::MAX);
    let undecided = count("candidate");
    let mut needs = Vec::new();
    if undecided > 0 {
        let what = if undecided == 1 {
            "component waits"
        } else {
            "components wait"
        };
        needs.push(BlockNeedDto {
            key: "components".into(),
            tone: "warn".into(),
            sentence: LineDto::new(english("{components} for a decision"))
                .text("components", format!("{undecided} {what}")),
            detail: Some(LineDto::new(english(
                "make it a gear of the organization, or leave it in its project",
            ))),
            action: Some(LinkDto {
                view: Some(NEEDS_DECISION_VIEW.into()),
                ..LinkDto::to(COMPONENTS_ROUTE, english("Decide"))
            }),
            details: None,
        });
    }
    BlockAnswer {
        tile: None,
        needs,
        data: json!({
            "undecided": undecided,
            "candidates": count("candidate"),
            "registered": count("registered"),
            "published": count("published"),
        }),
        ..BlockAnswer::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_candidate_waits_for_a_decision_and_nothing_else_does() {
        let a = answer(&["candidate".into(), "declared".into(), "registered".into()]);
        assert!(a.tile.is_none());
        assert_eq!(a.needs.len(), 1);
        assert_eq!(a.needs[0].action.as_ref().unwrap().route, COMPONENTS_ROUTE);
        assert_eq!(a.data["undecided"], 1);
        assert_eq!(a.data["registered"], 1);
        assert!(answer(&["registered".into()]).needs.is_empty());
    }
}
