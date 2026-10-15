use super::*;

fn scope(title: &str) -> ScopeFields {
    ScopeFields {
        title: title.into(),
        ..ScopeFields::default()
    }
}

#[test]
fn a_scope_is_tidied_and_checked() {
    let s = check_scope(ScopeFields {
        title: "  Exports  ".into(),
        target_date: Some("2026-12-01".into()),
        requirements: vec!["cpt-b".into(), " cpt-a ".into(), "cpt-b".into(), "".into()],
        owner: Some("  ".into()),
        ..ScopeFields::default()
    })
    .expect("a scope");
    assert_eq!(s.title, "Exports");
    assert_eq!(s.state, "planned");
    assert_eq!(s.requirements, ["cpt-a", "cpt-b"]);
    assert_eq!(s.owner, None);
    assert!(check_scope(scope("")).is_err());
    assert!(
        check_scope(ScopeFields {
            state: "done".into(),
            ..scope("x")
        })
        .is_err()
    );
    assert!(
        check_scope(ScopeFields {
            target_date: Some("2026-13-01".into()),
            ..scope("x")
        })
        .is_err()
    );
    assert!(
        check_scope(ScopeFields {
            target_date: Some("1 Dec".into()),
            ..scope("x")
        })
        .is_err()
    );
    assert_eq!(
        check_scope(ScopeFields {
            target_date: Some(" ".into()),
            ..scope("x")
        })
        .expect("blank date is none")
        .target_date,
        None
    );
}

#[test]
fn a_dependency_names_what_it_depends_on() {
    let dep = LimitFields {
        kind: "dependency".into(),
        text: "needs the audit gear".into(),
        blocking: true,
        depends_on: None,
    };
    assert!(check_limit(dep.clone()).is_err());
    assert!(
        check_limit(LimitFields {
            depends_on: Some("ADR-0012".into()),
            ..dep
        })
        .is_ok()
    );
    assert!(
        check_limit(LimitFields {
            kind: "risk".into(),
            text: "x".into(),
            ..LimitFields::default()
        })
        .is_err()
    );
}

#[test]
fn a_scope_is_blocked_while_a_blocking_limit_holds() {
    let open = LimitState {
        blocking: true,
        resolution: None,
        depends_on_state: None,
    };
    let resolved = LimitState {
        blocking: true,
        resolution: Some("agreed 50 MB"),
        depends_on_state: None,
    };
    let soft = LimitState {
        blocking: false,
        resolution: None,
        depends_on_state: None,
    };
    let dep_done = LimitState {
        blocking: true,
        resolution: None,
        depends_on_state: Some("delivered"),
    };
    let dep_open = LimitState {
        blocking: true,
        resolution: None,
        depends_on_state: Some("in_progress"),
    };
    assert!(blocked(&[open]));
    assert!(!blocked(&[resolved, soft]));
    assert!(!blocked(&[dep_done]));
    assert!(blocked(&[dep_open]));
}
