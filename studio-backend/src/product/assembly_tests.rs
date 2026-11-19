//! The assembly strategy: which one a product uses and why, and the settings
//! kept against PostgreSQL ([`crate::test_pg`]).

use tokio::sync::OnceCell;
use toolkit_db::migration_runner::run_migrations_for_testing;
use toolkit_db::sea_orm_migration::MigratorTrait;
use toolkit_db::{ConnectOpts, DBProvider, connect_db};
use uuid::Uuid;

use super::*;
use crate::product::migrations::Migrator;

use Strategy::{GearsMatcher, SpecMapping};

fn kits(installed: &[Strategy]) -> Available {
    Available {
        kits: Some(installed.to_vec()),
        matcher_missing: None,
    }
}

fn both() -> Available {
    kits(&[SpecMapping, GearsMatcher])
}

#[test]
fn nobody_chose_so_the_kits_default_is_used() {
    // Both kits: spec_mapping, as before ADR-0074.
    let e = resolve(None, None, both());
    assert_eq!(e.strategy, Some(SpecMapping));
    assert_eq!(e.chosen, Some(SpecMapping));
    assert_eq!(e.source, Source::Studio);
    assert_eq!(e.fallback, None);
    // Exactly one strategy kit: it is the default, nothing to choose.
    let e = resolve(None, None, kits(&[GearsMatcher]));
    assert_eq!(e.strategy, Some(GearsMatcher));
    assert_eq!(e.source, Source::Studio);
    // None: assembled by hand, and nothing falls back.
    let e = resolve(None, None, kits(&[]));
    assert_eq!(e.strategy, None);
    assert_eq!(e.chosen, None);
    assert_eq!(e.fallback, None);
    assert_eq!(wire(e.strategy), "manual");
}

#[test]
fn the_project_s_choice_wins_over_the_organization_s_default() {
    let e = resolve(Some(SpecMapping), Some(GearsMatcher), both());
    assert_eq!(e.strategy, Some(SpecMapping));
    assert_eq!(e.source, Source::Project);
    let e = resolve(None, Some(GearsMatcher), both());
    assert_eq!(e.strategy, Some(GearsMatcher));
    assert_eq!(e.source, Source::Organization);
    assert_eq!(e.fallback, None);
}

#[test]
fn a_choice_whose_kit_went_falls_back_and_says_why() {
    // The matcher kit uninstalled: spec_mapping, with the reason.
    let e = resolve(Some(GearsMatcher), None, kits(&[SpecMapping]));
    assert_eq!(e.chosen, Some(GearsMatcher));
    assert_eq!(e.strategy, Some(SpecMapping));
    assert_eq!(e.fallback.as_ref().map(|f| f.0), Some("KIT_NOT_INSTALLED"));
    assert!(e.fallback.as_ref().unwrap().1.contains("gears-matcher"));
    // The spec-mapping kit uninstalled, the matcher there: the matcher.
    let e = resolve(None, Some(SpecMapping), kits(&[GearsMatcher]));
    assert_eq!(e.strategy, Some(GearsMatcher));
    assert_eq!(e.fallback.as_ref().map(|f| f.0), Some("KIT_NOT_INSTALLED"));
    // Neither: by hand, still saying why.
    let e = resolve(Some(SpecMapping), None, kits(&[]));
    assert_eq!(e.strategy, None);
    assert_eq!(e.fallback.as_ref().map(|f| f.0), Some("KIT_NOT_INSTALLED"));
    // With the kit, but no service: the gear-match routes' own sentence.
    let e = resolve(
        None,
        Some(GearsMatcher),
        Available {
            kits: Some(vec![SpecMapping, GearsMatcher]),
            matcher_missing: Some("the gears-matcher service has no address".into()),
        },
    );
    assert_eq!(e.strategy, Some(SpecMapping));
    assert_eq!(
        e.fallback,
        Some((
            "MATCHER_NOT_CONFIGURED",
            "the gears-matcher service has no address".to_owned()
        ))
    );
    // A matcher that is not configured, alone: by hand.
    let e = resolve(
        None,
        None,
        Available {
            kits: Some(vec![GearsMatcher]),
            matcher_missing: Some("x".into()),
        },
    );
    assert_eq!(e.strategy, None);
    assert_eq!(
        e.fallback.as_ref().map(|f| f.0),
        Some("MATCHER_NOT_CONFIGURED")
    );
}

#[test]
fn unknown_kits_never_pass_the_paid_strategy_for_installed() {
    let unknown = Available {
        kits: None,
        matcher_missing: None,
    };
    let e = resolve(Some(GearsMatcher), None, unknown.clone());
    assert_eq!(e.strategy, Some(SpecMapping));
    assert_eq!(e.fallback.as_ref().map(|f| f.0), Some("KIT_UNKNOWN"));
    let e = resolve(None, None, unknown);
    assert_eq!(e.strategy, Some(SpecMapping));
    assert_eq!(e.fallback, None);
}

#[test]
fn every_strategy_has_the_built_in_kit_that_declares_it() {
    for s in Strategy::ALL {
        let provided = crate::kit_registry::port::assembly_strategies(&[s.kit().to_owned()]);
        let ids: Vec<&str> = provided.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, [s.as_str()], "{}", s.kit());
    }
    // Only kits that declare one provide one.
    assert!(
        crate::kit_registry::port::assembly_strategies(&["project-product".to_owned()]).is_empty()
    );
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
