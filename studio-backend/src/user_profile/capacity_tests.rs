use super::*;

#[test]
fn a_date_names_its_week_by_the_monday() {
    assert_eq!(
        monday_of("2026-10-15").as_deref(),
        Ok("2026-10-12"),
        "a Thursday"
    );
    assert_eq!(
        monday_of("2026-10-12").as_deref(),
        Ok("2026-10-12"),
        "a Monday"
    );
    assert_eq!(
        monday_of("2026-11-01").as_deref(),
        Ok("2026-10-26"),
        "a Sunday"
    );
    assert!(monday_of("2026-02-30").is_err());
    assert!(monday_of("15.10.2026").is_err());
}

#[test]
fn hours_are_bounded() {
    assert_eq!(check_hours(12.345), Ok(12.35));
    assert!(check_hours(-1.0).is_err());
    assert!(check_hours(81.0).is_err());
    assert!(check_hours(f64::NAN).is_err());
}

#[test]
fn availability_set_wins_over_the_plan_and_the_plan_over_nothing() {
    let plan = [
        PlanPerson {
            key: "github:ann".into(),
            name: "Ann".into(),
            team: Some("Core".into()),
            power: Some(0.5),
        },
        PlanPerson {
            key: "github:bob".into(),
            name: "Bob".into(),
            team: Some("Core".into()),
            power: Some(1.0),
        },
    ];
    let set = [Availability {
        person: "github:bob".into(),
        hours: 32.0,
    }];
    let allocations = [
        Allocation {
            person: "github:ann".into(),
            project_id: "p1".into(),
            hours: 16.0,
        },
        Allocation {
            person: "github:ann".into(),
            project_id: "p2".into(),
            hours: 8.0,
        },
        Allocation {
            person: "user-7".into(),
            project_id: "p1".into(),
            hours: 10.0,
        },
    ];
    let all = rows(&plan, &set, &allocations, None);
    let by = |k: &str| all.iter().find(|r| r.person == k).expect(k).clone();
    let ann = by("github:ann");
    assert_eq!(
        (
            ann.source,
            ann.available_hours,
            ann.allocated_hours,
            ann.free_hours
        ),
        ("plan", 20.0, 24.0, -4.0)
    );
    let bob = by("github:bob");
    assert_eq!((bob.source, bob.available_hours), ("set", 32.0));
    let other = by("user-7");
    assert_eq!(
        (other.source, other.available_hours, other.free_hours),
        ("none", 0.0, -10.0)
    );

    let p1: Vec<String> = rows(&plan, &set, &allocations, Some("p1"))
        .into_iter()
        .map(|r| r.person)
        .collect();
    assert_eq!(
        p1,
        ["user-7", "github:ann"],
        "no team sorts first, then by name"
    );
}
