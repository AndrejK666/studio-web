use serde_json::json;

use super::*;

fn day(y: i32, m: u8, d: u8) -> Date {
    Date::from_calendar_date(y, Month::try_from(m).expect("month"), d).expect("date")
}

fn plan() -> Plan {
    Plan::from_json(&json!({
        "swimlanes": { "order": ["CORE", "GENAI"], "labels": { "CORE": "Core Modules" } },
        "units": {
            "Acronis": { "color": "1F3864", "teams": [
                { "tag": "a_bravo", "name": "Acronis", "color": "1F3864", "people": 1, "power": 1 },
            ] },
            "Constructor": { "color": "1E5631", "teams": [
                { "tag": "ct_studio", "name": "CT Studio", "color": "1E5631", "people": 2 },
            ] },
        },
        "users": {
            "alice": { "alias": "Alice A", "team": "a_bravo", "power": 1 },
            "bob": { "alias": "Bob B", "team": "ct_studio", "power": 0.5 },
            "carol": { "team": "ct_studio", "power": 0.5 },
        },
        "gear_projects": { "studio_web": { "name": "Studio Web" }, "vz_bss": { "name": "VZ BSS" } },
        "gear_project_dependencies": {
            "1": { "projects": { "studio_web": "Q3'26", "vz_bss": "?" } },
            "2": { "projects": { "studio_web": "no", "vz_bss": "YES" } },
        },
    }))
}

#[allow(clippy::too_many_arguments)]
fn node(
    ix: u64,
    number: u64,
    title: &str,
    assignees: &[&str],
    milestone: &str,
    implementation: &str,
    effort: f64,
    blocked_by: &[u64],
) -> Json {
    json!({
        "board": "o/projects/48",
        "ix": ix,
        "gear": true,
        "number": number,
        "title": title,
        "url": format!("https://github.com/o/r/issues/{number}"),
        "assignees": assignees,
        "sheet": {
            "type": "Feature",
            "milestone": milestone,
            "fields": {
                "Status": "In Dev",
                "Design": "Done",
                "SDK": "N/A",
                "Implemenation": implementation,
                "Commitment": "COMMITMENT",
                "Prio (A.C.V.Ag)": "1 (1.1.1)",
                "Estimated Efforts m*d": effort,
            },
            "card": { "Description": "what it does", "Is Plugin": "NO" },
            "blocked_by": blocked_by,
        },
    })
}

#[test]
fn progress_is_read_the_way_the_board_writes_it() {
    let p = |v: Json| progress(Some(&v));
    assert_eq!(p(json!("Done")), Some(1.0));
    assert_eq!(p(json!("Todo")), Some(0.0));
    assert_eq!(p(json!("80%")), Some(0.8));
    assert_eq!(p(json!("N/A")), None);
    assert_eq!(p(json!(30)), Some(0.3));
    assert_eq!(p(json!(0.5)), Some(0.5));
    assert_eq!(p(json!("-")), None);
}

#[test]
fn the_card_is_the_bold_lines_of_the_body() {
    let body = "> mirrored\n\n**Description**: stores secrets\n**Is Plugin**: NO\n**Has Extension Points**: YES (types)\n**Other**: x\nprose **not**: this";
    let card = super::super::roadmap::card_of(body);
    assert_eq!(
        card.get("Description").map(String::as_str),
        Some("stores secrets")
    );
    assert_eq!(card.get("Is Plugin").map(String::as_str), Some("NO"));
    assert_eq!(
        card.get("Has Extension Point").map(String::as_str),
        Some("YES (types)")
    );
    assert_eq!(card.len(), 3);
}

#[test]
fn milestones_read_as_months() {
    assert_eq!(milestone_month("26.09"), Some((2026, 9)));
    assert_eq!(milestone_month("Q3 2026"), Some((2026, 7)));
    assert_eq!(milestone_month("2027 Q1"), Some((2027, 1)));
    assert_eq!(milestone_month("Sep 2026"), Some((2026, 9)));
    assert_eq!(milestone_month("Backlog"), None);
    assert_eq!(yy_mm("26.10"), Some((26, 10)));
    assert_eq!(need_quarter("Q4'26"), Some((26, 12)));
    assert_eq!(need_quarter("YES"), None);
}

#[test]
fn a_bar_waits_for_free_capacity() {
    // Two people: a third bar waits for the first to end.
    let busy = [(0, 4), (0, 2)];
    assert_eq!(earliest_capacity_slot(&busy, 0, 2, 2), 2);
    assert_eq!(earliest_capacity_slot(&busy, 0, 2, 3), 0);
    // One person: the first gap wide enough.
    assert_eq!(earliest_capacity_slot(&[(0, 2), (5, 6)], 0, 3, 1), 2);
    assert_eq!(earliest_capacity_slot(&[(0, 2), (4, 6)], 0, 3, 1), 6);
}

#[test]
fn a_blocked_gear_is_scheduled_after_its_blocker() {
    let plan = plan();
    // #2 is due sooner but blocked by #1: #1 goes first on the one-person lane.
    let planned = vec![
        node(
            0,
            2,
            "CORE - Second",
            &["alice"],
            "26.10",
            "Todo",
            22.0,
            &[1],
        ),
        node(1, 1, "CORE - First", &["alice"], "26.12", "Todo", 22.0, &[]),
    ];
    let mut rows = rows_of(&planned);
    let cx = Context {
        plan: &plan,
        today: day(2026, 10, 1),
    };
    let lanes = cx.lanes(&rows);
    assert_eq!(lanes.len(), 1);
    let start_of = |n: u64| {
        lanes[0]
            .items
            .iter()
            .find(|i| rows[i.row].number == Some(n))
            .map(|i| (i.start, i.span))
            .expect("scheduled")
    };
    // 22 person-days at power 1, one person: 22 days, two slots.
    assert_eq!(start_of(1), (0, 2));
    assert_eq!(start_of(2), (2, 2));
    cx.forecasts(&mut rows);
    let forecast = |n: u64| {
        rows.iter()
            .find(|r| r.number == Some(n))
            .map(|r| r.forecast.clone())
    };
    // Finish slot 2 → 22 days after Oct 1; slot 4 → 44 days.
    assert_eq!(forecast(1).as_deref(), Some("26.10"));
    assert_eq!(forecast(2).as_deref(), Some("26.11"));
}

#[test]
fn backlog_gears_take_what_capacity_is_left() {
    let plan = plan();
    let planned = vec![
        node(
            0,
            1,
            "CORE - Later",
            &["alice"],
            "Backlog",
            "Todo",
            22.0,
            &[],
        ),
        node(
            1,
            2,
            "CORE - Sooner",
            &["alice"],
            "27.06",
            "Todo",
            22.0,
            &[],
        ),
    ];
    let rows = rows_of(&planned);
    let cx = Context {
        plan: &plan,
        today: day(2026, 10, 1),
    };
    let lanes = cx.lanes(&rows);
    let item = |n: u64| {
        lanes[0]
            .items
            .iter()
            .find(|i| rows[i.row].number == Some(n))
            .expect("item")
    };
    assert_eq!(item(2).start, 0);
    assert_eq!(item(1).start, 2);
}

#[test]
fn finished_gears_are_not_scheduled_and_the_unassigned_get_a_lane() {
    let plan = plan();
    let planned = vec![
        node(0, 1, "CORE - Done", &["alice"], "26.09", "Done", 30.0, &[]),
        node(1, 2, "CORE - Nobody", &[], "26.11", "50%", 10.0, &[]),
    ];
    let rows = rows_of(&planned);
    let cx = Context {
        plan: &plan,
        today: day(2026, 10, 1),
    };
    let lanes = cx.lanes(&rows);
    assert_eq!(lanes.len(), 1);
    assert_eq!(lanes[0].tag, UNASSIGNED);
    assert!((lanes[0].items[0].remaining - 5.0).abs() < 1e-9);
}

#[test]
fn the_workbook_has_the_planning_teams_sheets() {
    let plan = plan();
    let planned = vec![
        node(
            0,
            1,
            "CORE - Credentials Store",
            &["alice"],
            "26.09",
            "Done",
            30.0,
            &[],
        ),
        node(
            1,
            2,
            "GENAI - LLM Gateway",
            &["bob", "carol"],
            "26.11",
            "20%",
            30.0,
            &[],
        ),
        node(
            2,
            3,
            "OSS - Monitoring",
            &["stranger"],
            "Backlog",
            "Todo",
            20.0,
            &[],
        ),
        // A pinned plan that is not one of the board's gears is left out.
        json!({ "board": "o/projects/48", "ix": 9, "gear": false, "title": "CORE - Pinned" }),
    ];
    let sheets = sheets(&planned, &plan, day(2026, 10, 1));
    let names: Vec<&str> = sheets.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(
        names,
        vec![
            "Summary", "Roadmap", "Gantt", "People", "CORE", "GENAI", "OSS", "ALL"
        ]
    );

    let core = &sheets[4];
    assert_eq!(core.value(1, 26), Some(&Value::Text("Studio Web".into())));
    assert_eq!(
        core.value(2, 3),
        Some(&Value::Text("CORE - Credentials Store".into()))
    );
    assert_eq!(core.value(2, 6), Some(&Value::Text("Alice A".into())));
    assert_eq!(core.value(2, 7), Some(&Value::Text("Acronis".into())));
    assert_eq!(core.value(2, 11), Some(&Value::Number(1.0)));
    assert_eq!(core.value(2, 14), Some(&Value::Formula("M2*(1-K2)".into())));
    assert_eq!(core.value(2, 16), Some(&Value::Date(day(2026, 9, 1))));
    assert_eq!(core.value(2, 25), Some(&Value::Text("what it does".into())));
    assert_eq!(core.value(2, 26), Some(&Value::Text("Q3'26".into())));
    // The metrics under the table: one row, a blank one, then the block.
    assert_eq!(core.value(4, 3), Some(&Value::Text("Metric".into())));
    assert_eq!(
        core.value(5, 4),
        Some(&Value::Formula("COUNTA(C2:C2)".into()))
    );

    let genai = &sheets[5];
    assert_eq!(genai.value(2, 7), Some(&Value::Text("CT Studio".into())));
    // A forecast is a month.
    assert!(matches!(genai.value(2, 17), Some(Value::Date(_))));

    let summary = &sheets[0];
    assert_eq!(
        summary.value(2, 2),
        Some(&Value::Text("Core Modules".into()))
    );
    assert_eq!(
        summary.value(2, 3),
        Some(&Value::Formula("COUNTA('CORE'!C2:C2)".into()))
    );
    assert_eq!(summary.value(4, 2), Some(&Value::Text("OSS".into())));

    let all = &sheets[7];
    assert_eq!(
        all.value(4, 3),
        Some(&Value::Text("OSS - Monitoring".into()))
    );
    assert_eq!(all.value(5, 3), None);

    let people = &sheets[3];
    assert_eq!(people.value(3, 4), Some(&Value::Text("CT Studio".into())));
    assert_eq!(people.value(3, 5), Some(&Value::Text("1E5631".into())));

    // The Roadmap draws a box per unfinished gear and the past section for
    // the finished one; the Gantt one bar per team a gear is split across.
    let roadmap = &sheets[1];
    let texts: Vec<&str> = roadmap.shapes().iter().map(|s| s.text.as_str()).collect();
    assert!(texts.contains(&"\u{25C6} GENAI - LLM Gateway"), "{texts:?}");
    assert!(texts.contains(&"\u{25C6} OSS - Monitoring"), "{texts:?}");
    assert!(
        texts.contains(&"\u{25C6} CORE - Credentials Store"),
        "{texts:?}"
    );
    let gantt = &sheets[2];
    let bars: Vec<&str> = gantt.shapes().iter().map(|s| s.text.as_str()).collect();
    assert_eq!(bars, vec!["LLM Gateway (4.8 m*w)", "Monitoring (4 m*w)"]);

    let bytes = build(&planned, &plan, day(2026, 10, 1));
    assert_eq!(&bytes[..2], b"PK");
}

#[test]
fn a_workbook_without_a_plan_still_lists_every_gear() {
    let planned = vec![node(
        0,
        1,
        "CORE - X",
        &["alice"],
        "26.11",
        "Todo",
        10.0,
        &[],
    )];
    let sheets = sheets(&planned, &Plan::default(), day(2026, 10, 1));
    let core = &sheets[4];
    assert_eq!(core.value(2, 6), Some(&Value::Text("alice".into())));
    assert_eq!(core.value(1, 26), None);
    let gantt = &sheets[2];
    assert_eq!(gantt.shapes().len(), 1);
}
