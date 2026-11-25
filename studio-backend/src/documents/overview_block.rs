//! The Specs block of an organization's Overview (the Specs kit's
//! contribution through the core's Overview port, ADR-0079 §4): how many of
//! every project's specs fail, and which projects to look at.
//!
//! It reads nothing of its own: the projects' rows already carry their spec
//! counts.

use async_trait::async_trait;
use serde_json::json;
use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;

use crate::organizations::port::{
    BlockAnswer, BlockScope, BlockSource, OverviewItemDto, ItemsDto, Level, LineDto, LinkDto,
    OverviewBlock, Prepared, TileDto, words,
};

/// The kit specs are.
pub const SPECS_KIT: &str = "project-specs";
/// A project's Specs screen, and its view of the failing ones.
const SPECS_ROUTE: &str = "/projects/specs";
const FAILING_VIEW: &str = "failing-specs";

inventory::submit! {
    OverviewBlock {
        kit: SPECS_KIT,
        gear: "studio-documents",
        id: "specs",
        order: 30,
        level: Level::Organization,
        source: &SpecsBlock,
    }
}

pub struct SpecsBlock;

#[async_trait]
impl BlockSource for SpecsBlock {
    async fn answer(
        &self,
        _hub: &ClientHub,
        _ctx: &SecurityContext,
        _prepared: Prepared,
        scope: &BlockScope<'_>,
    ) -> Option<BlockAnswer> {
        // A project's failing specs are already its health's (its row).
        if scope.at.health_only {
            return None;
        }
        Some(answer(scope))
    }
}

fn sum(vs: impl Iterator<Item = Option<u32>>) -> Option<u32> {
    vs.fold(None, |acc, v| match (acc, v) {
        (None, None) => None,
        (a, v) => Some(a.unwrap_or(0) + v.unwrap_or(0)),
    })
}

/// The block, from the projects' rows.
pub fn answer(scope: &BlockScope<'_>) -> BlockAnswer {
    let specs = sum(scope.projects().map(|r| r.specs));
    let failing = sum(scope.projects().map(|r| r.specs_failing));
    let findings = sum(scope.projects().map(|r| r.open_findings));
    let rows: Vec<OverviewItemDto> = scope
        .projects()
        .filter(|r| r.specs_failing.unwrap_or(0) > 0)
        .map(|r| {
            let workspace = r.workspace.map(|w| w.to_string());
            let place = match workspace.as_ref().and_then(|w| scope.places.get(w)) {
                Some(ws) => format!("{ws} / {}", r.name),
                None => r.name.clone(),
            };
            OverviewItemDto {
                text: LineDto::new(words(
                    "{place} · {count} failing specs",
                    "{place} · Спецификаций с ошибками: {count}",
                ))
                .text("place", place)
                .count("count", r.specs_failing.map(f64::from)),
                link: LinkDto {
                    view: Some(FAILING_VIEW.into()),
                    workspace_id: workspace,
                    project_id: Some(r.id.to_string()),
                    ..LinkDto::to(SPECS_ROUTE, words("Specs", "Спеки"))
                },
            }
        })
        .collect();
    BlockAnswer {
        tile: Some(TileDto {
            title: words("Specs, every project", "Спеки всех проектов"),
            value: Some(
                LineDto::new(words(
                    "{failing} of {specs} failing",
                    "{failing} из {specs} не проходят",
                ))
                .count("failing", failing.map(f64::from))
                .count("specs", specs.map(f64::from)),
            ),
            lines: vec![
                LineDto::new(words(
                    "{findings} open findings · a spec is a document with a settled type",
                    "открытых замечаний: {findings} · спека — документ с утверждённым типом",
                ))
                .count("findings", findings.map(f64::from)),
            ],
            link: None,
            items: (!rows.is_empty()).then(|| ItemsDto {
                label: words("Find failing specs", "Найти спецификации с ошибками"),
                rows,
            }),
        }),
        data: json!({ "specs": specs, "failing": failing, "open_findings": findings }),
        ..BlockAnswer::default()
    }
}
