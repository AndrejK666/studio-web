#![allow(clippy::expect_used, clippy::unwrap_used)]

use super::*;

static SPEC: ViewSpec = ViewSpec {
    gear: "test-gear",
    view: "test-view",
    task_type: "test.view",
    item_entity: "test-view-row",
    item_name: "Test View Row",
    item_description: "A row of the test view.",
    item_fields: &[("name", "string")],
    state_entity: "test-view-state",
    state_name: "Test View State",
};

fn ctx() -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(1))
        .subject_tenant_id(Uuid::from_u128(7))
        .token_scopes(vec!["*".to_string()])
        .build()
        .expect("test security context")
}

fn row(name: &str) -> (String, Value) {
    (name.to_owned(), json!({ "name": name }))
}

#[tokio::test]
async fn a_view_keeps_its_rows_and_what_they_were_computed_from() {
    let port = crate::domain_model::port::in_memory();
    let project = Uuid::from_u128(42);
    ensure_types(port.as_ref(), &ctx(), &SPEC).await.unwrap();

    // Nothing asked for yet: no state, no rows.
    let (state, rows) = SPEC.read(port.as_ref(), &ctx(), project).await.unwrap();
    assert!(state.is_none() && rows.is_empty());

    let asked = SPEC
        .mark_computing(port.as_ref(), &ctx(), project)
        .await
        .unwrap();
    assert_eq!(asked.status, ViewStatus::Computing);
    assert!(asked.computed_at.is_none());

    let input = ViewInput {
        source: "org/repo".into(),
        commit: Some("abc".into()),
        ..ViewInput::default()
    };
    SPEC.store(
        port.as_ref(),
        &ctx(),
        project,
        Derived {
            inputs: vec![input.clone()],
            items: vec![row("a"), row("b")],
            detail: json!({"repos": 1}),
        },
    )
    .await
    .unwrap();
    let (state, rows) = SPEC.read(port.as_ref(), &ctx(), project).await.unwrap();
    let state = state.unwrap();
    assert_eq!(state.status, ViewStatus::Ready);
    assert_eq!(state.inputs, vec![input]);
    assert_eq!(state.items, 2);
    assert!(state.computed_at.is_some());
    assert_eq!(state.detail["repos"], 1);
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|r| r["project_id"] == project.to_string()));

    // A second computation that no longer finds `a` drops it.
    SPEC.store(
        port.as_ref(),
        &ctx(),
        project,
        Derived {
            items: vec![row("b"), row("c")],
            ..Derived::default()
        },
    )
    .await
    .unwrap();
    let (_, rows) = SPEC.read(port.as_ref(), &ctx(), project).await.unwrap();
    let mut names: Vec<&str> = rows.iter().filter_map(|r| r["name"].as_str()).collect();
    names.sort_unstable();
    assert_eq!(names, vec!["b", "c"]);

    // A failure keeps the rows and says why.
    SPEC.fail(port.as_ref(), &ctx(), project, "no clone".into())
        .await
        .unwrap();
    let (state, rows) = SPEC.read(port.as_ref(), &ctx(), project).await.unwrap();
    let state = state.unwrap();
    assert_eq!(state.status, ViewStatus::Failed);
    assert_eq!(state.error.as_deref(), Some("no clone"));
    assert_eq!(rows.len(), 2);
}

#[tokio::test]
async fn one_projects_view_is_not_anothers() {
    let port = crate::domain_model::port::in_memory();
    ensure_types(port.as_ref(), &ctx(), &SPEC).await.unwrap();
    let (a, b) = (Uuid::from_u128(1), Uuid::from_u128(2));
    for (p, name) in [(a, "x"), (b, "y")] {
        SPEC.store(
            port.as_ref(),
            &ctx(),
            p,
            Derived {
                items: vec![row(name)],
                ..Derived::default()
            },
        )
        .await
        .unwrap();
    }
    let (_, rows) = SPEC.read(port.as_ref(), &ctx(), a).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["name"], "x");
}

#[test]
fn a_computation_that_never_finished_is_taken_for_lost() {
    let now = time::OffsetDateTime::now_utc();
    let at = |ago: time::Duration| {
        (now - ago)
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap()
    };
    let state = |requested: Option<String>, status| ViewState {
        status,
        requested_at: requested,
        ..ViewState::default()
    };
    assert!(!state(Some(at(time::Duration::minutes(1))), ViewStatus::Computing).lost(now));
    assert!(state(Some(at(time::Duration::hours(1))), ViewStatus::Computing).lost(now));
    assert!(state(None, ViewStatus::Computing).lost(now));
    assert!(!state(Some(at(time::Duration::hours(1))), ViewStatus::Ready).lost(now));
}

#[test]
fn both_types_are_held_by_the_gear() {
    let needs = SPEC.needs();
    assert_eq!(needs.len(), 2);
    for n in &needs {
        assert_eq!(n.held_by.as_deref(), Some("test-gear"));
        assert!(n.fields.iter().any(|f| f.0 == "project_id"));
    }
}
