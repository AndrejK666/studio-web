//! The assembly strategy: which one a product uses and why, and the settings
//! kept against PostgreSQL ([`crate::test_pg`]).

use tokio::sync::OnceCell;
use toolkit_db::migration_runner::run_migrations_for_testing;
use toolkit_db::sea_orm_migration::MigratorTrait;
use toolkit_db::{ConnectOpts, DBProvider, connect_db};
use uuid::Uuid;

use super::*;
use crate::product::migrations::Migrator;

fn ready() -> MatcherState {
    MatcherState {
        kit: Some(true),
        missing: None,
    }
}

#[test]
fn nobody_chose_so_studio_s_default_is_used() {
    let e = resolve(None, None, ready());
    assert_eq!(e.strategy, Strategy::SpecMapping);
    assert_eq!(e.chosen, Strategy::SpecMapping);
    assert_eq!(e.source, Source::Studio);
    assert_eq!(e.fallback, None);
}

#[test]
fn the_project_s_choice_wins_over_the_organization_s_default() {
    let e = resolve(
        Some(Strategy::SpecMapping),
        Some(Strategy::GearsMatcher),
        ready(),
    );
    assert_eq!(e.strategy, Strategy::SpecMapping);
    assert_eq!(e.source, Source::Project);
    let e = resolve(None, Some(Strategy::GearsMatcher), ready());
    assert_eq!(e.strategy, Strategy::GearsMatcher);
    assert_eq!(e.source, Source::Organization);
    assert_eq!(e.fallback, None);
}

#[test]
fn the_matcher_falls_back_to_spec_mapping_and_says_why() {
    // Without the kit.
    let e = resolve(
        Some(Strategy::GearsMatcher),
        None,
        MatcherState {
            kit: Some(false),
            missing: None,
        },
    );
    assert_eq!(e.chosen, Strategy::GearsMatcher);
    assert_eq!(e.strategy, Strategy::SpecMapping);
    assert_eq!(e.fallback.as_ref().map(|f| f.0), Some("KIT_NOT_INSTALLED"));
    // With the kit, but no service: the gear-match routes' own sentence.
    let e = resolve(
        None,
        Some(Strategy::GearsMatcher),
        MatcherState {
            kit: Some(true),
            missing: Some("the gears-matcher service has no address".into()),
        },
    );
    assert_eq!(e.strategy, Strategy::SpecMapping);
    assert_eq!(
        e.fallback,
        Some((
            "MATCHER_NOT_CONFIGURED",
            "the gears-matcher service has no address".to_owned()
        ))
    );
    // Unknown kits never pass for installed.
    let e = resolve(
        Some(Strategy::GearsMatcher),
        None,
        MatcherState {
            kit: None,
            missing: None,
        },
    );
    assert_eq!(e.strategy, Strategy::SpecMapping);
    assert_eq!(e.fallback.as_ref().map(|f| f.0), Some("KIT_UNKNOWN"));
    // spec_mapping never needs the matcher.
    let e = resolve(
        Some(Strategy::SpecMapping),
        None,
        MatcherState {
            kit: Some(false),
            missing: Some("x".into()),
        },
    );
    assert_eq!(e.fallback, None);
}

#[test]
fn a_strategy_reads_by_its_wire_name_only() {
    assert_eq!(
        Strategy::parse("gears_matcher"),
        Some(Strategy::GearsMatcher)
    );
    assert_eq!(
        Strategy::parse(" spec_mapping "),
        Some(Strategy::SpecMapping)
    );
    assert_eq!(Strategy::parse("matcher"), None);
    assert_eq!(Strategy::parse(""), None);
}

static DSN: OnceCell<String> = OnceCell::const_new();

async fn store() -> StrategyStore {
    let dsn = DSN
        .get_or_init(|| async {
            let dsn = crate::test_pg::fresh_database("product_assembly").await;
            let conn = connect_db(&dsn, ConnectOpts::default())
                .await
                .unwrap_or_else(|e| panic!("connect to {dsn} failed: {e}"));
            run_migrations_for_testing(&conn, Migrator::migrations())
                .await
                .expect("run migrations");
            dsn
        })
        .await;
    let conn = connect_db(dsn, ConnectOpts::default())
        .await
        .expect("connect");
    StrategyStore::new(DBProvider::<anyhow::Error>::new(conn).db())
}

#[tokio::test]
async fn an_organization_default_and_a_project_choice_are_kept_apart() {
    let store = store().await;
    let (org, project) = (Uuid::new_v4(), Uuid::new_v4());
    assert_eq!(store.get(org, org).await.unwrap(), None);
    store
        .put(org, org, Some(Strategy::GearsMatcher), "admin")
        .await
        .unwrap();
    store
        .put(org, project, Some(Strategy::SpecMapping), "member")
        .await
        .unwrap();
    assert_eq!(
        store.get(org, org).await.unwrap(),
        Some(Strategy::GearsMatcher)
    );
    assert_eq!(
        store.get(org, project).await.unwrap(),
        Some(Strategy::SpecMapping)
    );
    // Replaced, then forgotten: the project follows the organization again.
    store
        .put(org, project, Some(Strategy::GearsMatcher), "member")
        .await
        .unwrap();
    assert_eq!(
        store.get(org, project).await.unwrap(),
        Some(Strategy::GearsMatcher)
    );
    store.put(org, project, None, "member").await.unwrap();
    assert_eq!(store.get(org, project).await.unwrap(), None);
    // Another organization reads none of it.
    assert_eq!(store.get(Uuid::new_v4(), org).await.unwrap(), None);
}
