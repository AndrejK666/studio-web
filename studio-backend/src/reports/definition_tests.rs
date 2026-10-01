use super::*;

fn table(columns: &str) -> String {
    format!("sheets:\n  - kind: table\n    all: ALL\n    columns:\n{columns}")
}

fn err(text: &str) -> String {
    Definition::from_yaml(text).expect_err("should be refused")
}

#[test]
fn the_planning_teams_workbook_is_a_built_in() {
    let d = Definition::preset("back_roadmap").expect("preset");
    assert_eq!(d.id, "back_roadmap");
    let kinds: Vec<&str> = d
        .sheets
        .iter()
        .map(|s| match s {
            SheetDef::Summary { .. } => "summary",
            SheetDef::Timeline { .. } => "timeline",
            SheetDef::Gantt { .. } => "gantt",
            SheetDef::People { .. } => "people",
            SheetDef::Table(_) => "table",
        })
        .collect();
    assert_eq!(
        kinds,
        vec!["summary", "timeline", "gantt", "people", "table"]
    );
    let t = d.table().expect("table");
    assert!(t.per_group && t.metrics);
    assert_eq!(t.all.as_deref(), Some("ALL"));
    assert_eq!(t.sort, Sort::Prio);
    assert_eq!(t.freeze, Some((2, 4)));
    // 25 columns of its own, then the plan's projects from Z on.
    assert_eq!(t.columns.len(), 26);
    assert_eq!(t.columns.last().map(|c| &c.source), Some(&Source::Projects));
    assert_eq!(t.by_id("impl"), Some(10));
    assert_eq!(t.by_id("milestone"), Some(15));
    // The summary reads the hidden copies, the red cells the visible ones.
    assert_eq!(t.role(&Key::Impl, true), Some(19));
    assert_eq!(t.role(&Key::Impl, false), Some(10));
    assert_eq!(Definition::preset_ids(), vec!["back_roadmap"]);
    assert!(Definition::preset("nope").is_none());
}

#[test]
fn a_plan_names_a_built_in_or_carries_its_own() {
    let by_id = Definition::from_plan(&Yaml::String("back_roadmap".into())).expect("by id");
    assert_eq!(by_id.id, "back_roadmap");
    let e = Definition::from_plan(&Yaml::String("weekly".into())).unwrap_err();
    assert!(e.contains("back_roadmap"), "{e}");
    let own = crate::reports::roadmap::plan::parse(&table(
        "      - { id: t, header: Title, value: title }\n",
    ))
    .unwrap();
    let d = Definition::from_plan(&own).expect("inline");
    assert_eq!(d.id, "custom");
    assert!(Definition::from_plan(&Yaml::Bool(true)).is_err());
}

#[test]
fn every_value_key_reads() {
    let keys = [
        "index",
        "number",
        "title",
        "type",
        "assignees",
        "aliases",
        "teams",
        "prio",
        "spec",
        "sdk",
        "impl",
        "overall",
        "status",
        "effort",
        "commitment",
        "milestone",
        "forecast",
        "card.Description",
        "field.Design %",
    ];
    for k in keys {
        assert!(Key::parse(k).is_ok(), "{k}");
    }
    assert_eq!(
        Key::parse("field.Design %"),
        Ok(Key::Field("Design %".into()))
    );
    assert_eq!(
        Key::parse("card. Is Plugin"),
        Ok(Key::Card("Is Plugin".into()))
    );
    let e = Key::parse("grade").unwrap_err();
    assert!(e.contains("card.<field>"), "{e}");
}

#[test]
fn a_formula_names_columns_and_the_row() {
    assert_eq!(
        refs("{effort}{row}*(1-{impl}{row})"),
        Ok(vec![
            "effort".into(),
            "row".into(),
            "impl".into(),
            "row".into()
        ])
    );
    assert_eq!(refs("SUM(A1:A2)"), Ok(Vec::new()));
    assert!(refs("{effort").is_err());
    assert!(refs("effort}").is_err());
    assert!(refs("{a b}").is_err());
    let letter = |id: &str| match id {
        "effort" => Some("M".to_string()),
        "impl" => Some("K".to_string()),
        _ => None,
    };
    assert_eq!(
        resolve("{effort}{row}*(1-{impl}{row})", 7, letter).as_deref(),
        Some("M7*(1-K7)")
    );
    assert_eq!(resolve("{gone}{row}", 7, letter), None);
}

#[test]
fn a_cell_is_letters_then_a_row() {
    assert_eq!(cell("D2"), Ok((2, 4)));
    assert_eq!(cell("aa10"), Ok((10, 27)));
    for bad in ["2", "D", "D0", "2D", "D-2"] {
        assert!(cell(bad).is_err(), "{bad}");
    }
}

#[test]
fn a_column_is_checked_where_it_is_written() {
    assert!(err(&table("      - { header: Title, value: title }\n")).contains("has no `id`"));
    assert!(err(&table("      - { id: t }\n")).contains("neither"));
    assert!(err(&table("      - { id: t, value: title, formula: x }\n")).contains("more than one"));
    assert!(err(&table("      - { id: t, value: grade }\n")).contains("not a value"));
    assert!(
        err(&table("      - { id: t, value: title, format: '#,##0' }\n")).contains("not a format")
    );
    assert!(err(&table("      - { id: t, value: spec, bar: green }\n")).contains("not a colour"));
    assert!(err(&table("      - { id: t, value: title, late: soon }\n")).contains("not a rule"));
    assert!(err(&table("      - { id: t, value: title, width: 0 }\n")).contains("width"));
    assert!(
        err(&table(
            "      - { id: t, value: title, link: yes please }\n"
        ))
        .contains("true or false")
    );
}

#[test]
fn a_table_refers_only_to_columns_it_has() {
    let two = "      - { id: t, value: title }\n      - { id: t, value: type }\n";
    assert!(err(&table(two)).contains("two columns"));
    assert!(
        err(&table("      - { id: r, formula: '{effort}{row}' }\n")).contains("names no column")
    );
    assert!(
        err(&table("      - { id: r, formula: '{r}{row}' }\n")).contains("names no column")
            || err(&table("      - { id: r, formula: '{r}{row}' }\n")).contains("itself")
    );
    assert!(
        err(&table("      - { id: r, value: title, when: effort }\n")).contains("names no column")
    );
    assert!(
        err(&table(
            "      - { id: f, value: forecast, late: forecast_late }\n"
        ))
        .contains("milestone")
    );
    let projects_first = "      - { id: p, projects: true }\n      - { id: t, value: title }\n";
    assert!(err(&table(projects_first)).contains("last one"));
    let ok = "      - { id: e, value: effort }\n      - { id: i, value: impl }\n      - { id: r, formula: '{e}{row}*(1-{i}{row})', when: e }\n";
    let d = Definition::from_yaml(&table(ok)).expect("valid");
    assert_eq!(d.table().and_then(|t| t.by_id("r")), Some(2));
}

#[test]
fn the_sheets_hold_together() {
    assert!(err("sheets: []\n").contains("no sheets"));
    assert!(err("title: x\n").contains("no `sheets`"));
    assert!(err("sheets:\n  - kind: chart\n").contains("not a kind"));
    assert!(err("sheets:\n  - { name: x }\n").contains("no `kind`"));
    assert!(err("sheets:\n  - kind: people\n  - kind: people\n").contains("two sheets"));
    assert!(err("sheets:\n  - kind: summary\n").contains("per_group"));
    assert!(err("sheets:\n  - kind: table\n    columns: []\n").contains("lists nothing"));
    assert!(err("sheets:\n  - kind: table\n    all: A\n").contains("no `columns`"));
    assert!(err("group_by: owner\nsheets:\n  - kind: people\n").contains("grouping"));
    let two_tables = format!(
        "{}\n  - kind: table\n    all: B\n    columns: []\n",
        table("      - { id: t, value: title }")
    );
    assert!(err(&two_tables).contains("one table"));
    let sort = "sheets:\n  - kind: table\n    all: A\n    sort: name\n    columns: []\n";
    assert!(err(sort).contains("not a sort"));
}

#[test]
fn a_minimal_report_is_one_sheet() {
    let d = Definition::from_yaml("id: people\nsheets:\n  - kind: people\n    name: Team\n")
        .expect("valid");
    assert_eq!(
        d.sheets,
        vec![SheetDef::People {
            name: "Team".into()
        }]
    );
    assert!(d.table().is_none());
    // Names and titles have defaults.
    let d = Definition::from_yaml("sheets:\n  - kind: gantt\n  - kind: timeline\n").expect("valid");
    assert_eq!(
        d.sheets[0],
        SheetDef::Gantt {
            name: "Gantt".into(),
            title: "Gantt".into()
        }
    );
    assert_eq!(
        d.sheets[1],
        SheetDef::Timeline {
            name: "Roadmap".into(),
            title: "Roadmap".into()
        }
    );
}
