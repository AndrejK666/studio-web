use super::*;
use serde_json::json;

fn values(v: Value) -> Map<String, Value> {
    serde_json::from_value(v).unwrap()
}

fn planned(
    stage: &str,
    at: u32,
    due: Option<&str>,
    committed: bool,
    plan: (&str, &str, &str),
    demand: &[(&str, u64)],
) -> Map<String, Value> {
    let (brief, lamp, why) = plan;
    let milestone = match due {
        Some(d) => json!({ "b": format!("{}.{}", &d[2..4], &d[5..7]), "u": d }),
        None => json!({ "b": "Backlog" }),
    };
    values(json!({
        "stage": { "b": stage, "v": format!("{stage} ({at} of 6)") },
        "milestone": milestone,
        "commitment": { "b": if committed { "committed" } else { "not committed" } },
        "convergence": { "b": brief, "s": lamp, "v": why },
        "demand": { "b": "", "parts": demand.iter().map(|(c, p)| json!({ "consumer": c, "priority": p })).collect::<Vec<_>>() },
        "roadmap_item": { "b": format!("#1 {stage}"), "l": "https://github.com/o/r/issues/1" },
        "roadmap_owner": { "b": "@someone" },
        "effort": { "b": "40" },
    }))
}

#[test]
fn the_report_lists_what_the_board_plans_and_counts_the_rest() {
    let broker = planned(
        "In Dev",
        3,
        Some("2026-10-31"),
        true,
        ("on track", "good", "on track"),
        &[("Acronis", 1), ("Virtuozzo", 3)],
    );
    let files = planned(
        "In Dev",
        3,
        Some("2026-07-31"),
        true,
        ("at risk", "bad", "overdue: due 2026-07-31 and still In Dev"),
        &[("Acronis", 1)],
    );
    let approval = planned(
        "Todo",
        1,
        None,
        false,
        (
            "at risk",
            "bad",
            "P1 for Constructor, but no dated milestone",
        ),
        &[("Constructor", 1)],
    );
    let shipped = planned(
        "In Prod",
        6,
        Some("2026-04-30"),
        true,
        ("delivered", "good", "delivered"),
        &[("Acronis", 2)],
    );
    let lone = values(json!({ "description": { "b": "not on the board" } }));
    let all = [
        ComponentValues {
            name: "cf-gears-event-broker",
            category: "core",
            values: &broker,
        },
        ComponentValues {
            name: "cf-gears-file-storage",
            category: "core",
            values: &files,
        },
        ComponentValues {
            name: "cf-gears-approval-service",
            category: "",
            values: &approval,
        },
        ComponentValues {
            name: "cf-gears-account-management",
            category: "oss",
            values: &shipped,
        },
        ComponentValues {
            name: "cf-gears-lonely",
            category: "",
            values: &lone,
        },
    ];
    let r = build(&all);

    assert_eq!(r.total, 4);
    assert_eq!(r.not_on_board, 1);
    // Soonest due first, undated last.
    let order: Vec<&str> = r.items.iter().map(|i| i.name.as_str()).collect();
    assert_eq!(
        order,
        [
            "cf-gears-account-management",
            "cf-gears-file-storage",
            "cf-gears-event-broker",
            "cf-gears-approval-service"
        ]
    );
    let broker_row = &r.items[2];
    assert_eq!(broker_row.assignees.as_deref(), Some("@someone"));
    assert_eq!(broker_row.effort.as_deref(), Some("40"));
    assert_eq!(broker_row.category.as_deref(), Some("core"));
    assert_eq!(r.items[3].category, None);

    let s = &r.summary;
    // Pipeline order, not alphabetical.
    let stages: Vec<(&str, u32)> = s
        .by_stage
        .iter()
        .map(|c| (c.label.as_str(), c.count))
        .collect();
    assert_eq!(stages, [("Todo", 1), ("In Dev", 2), ("In Prod", 1)]);
    // Dated by due date, then undated.
    let ms: Vec<(&str, u32, u32, u32)> = s
        .by_milestone
        .iter()
        .map(|m| (m.milestone.as_str(), m.total, m.committed, m.at_risk))
        .collect();
    assert_eq!(
        ms,
        [
            ("26.04", 1, 1, 0),
            ("26.07", 1, 1, 1),
            ("26.10", 1, 1, 0),
            ("Backlog", 1, 0, 1)
        ]
    );
    let acronis = s
        .by_consumer
        .iter()
        .find(|c| c.consumer == "Acronis")
        .unwrap();
    assert_eq!(
        (acronis.p1, acronis.p2, acronis.p3, acronis.p1_not_on_track),
        (2, 1, 0, 1)
    );
    let constructor = s
        .by_consumer
        .iter()
        .find(|c| c.consumer == "Constructor")
        .unwrap();
    assert_eq!((constructor.p1, constructor.p1_not_on_track), (1, 1));
    let plans: Vec<(&str, u32)> = s
        .by_plan
        .iter()
        .map(|c| (c.label.as_str(), c.count))
        .collect();
    assert_eq!(plans, [("at risk", 2), ("delivered", 1), ("on track", 1)]);
    assert_eq!(s.overdue, ["cf-gears-file-storage"]);
}

#[test]
fn an_empty_catalogue_is_an_empty_report() {
    let r = build(&[]);
    assert_eq!((r.total, r.not_on_board), (0, 0));
    assert!(r.summary.by_stage.is_empty() && r.summary.overdue.is_empty());
}
