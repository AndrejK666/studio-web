//! The assembly strategy: which one a product uses and why, and the settings
//! kept against PostgreSQL ([`crate::test_pg`]).

use tokio::sync::OnceCell;
use toolkit_db::migration_runner::run_migrations_for_testing;
use toolkit_db::sea_orm_migration::MigratorTrait;
use toolkit_db::{ConnectOpts, DBProvider, connect_db};
use uuid::Uuid;

use super::*;
use crate::product::migrations::Migrator;

fn sm() -> Strategy {
    Strategy::spec_mapping()
}

fn gm() -> Strategy {
    Strategy::gears_matcher()
}

fn acme() -> Strategy {
    Strategy::parse("acme_matcher").unwrap()
}

fn offer(s: Strategy) -> Offer {
    let service = !s.is_spec_mapping();
    let kit = match s.as_str() {
        "spec_mapping" => "spec-mapping",
        "gears_matcher" => "gears-matcher",
        _ => "acme-matcher",
    };
    Offer {
        strategy: s,
        kit: kit.to_owned(),
        service,
    }
}

fn kits(installed: &[Strategy]) -> Available {
    Available {
        kits: Some(installed.iter().cloned().map(offer).collect()),
        services: Default::default(),
    }
}

fn both() -> Available {
    kits(&[sm(), gm()])
}

#[test]
fn nobody_chose_so_the_kits_default_is_used() {
    // Both kits: spec_mapping, as before ADR-0074.
    let e = resolve(None, None, both());
    assert_eq!(e.strategy, Some(sm()));
    assert_eq!(e.chosen, Some(sm()));
    assert_eq!(e.source, Source::Studio);
    assert_eq!(e.fallback, None);
    // Exactly one strategy kit: it is the default, nothing to choose.
    let e = resolve(None, None, kits(&[gm()]));
    assert_eq!(e.strategy, Some(gm()));
    assert_eq!(e.source, Source::Studio);
    // None: assembled by hand, and nothing falls back.
    let e = resolve(None, None, kits(&[]));
    assert_eq!(e.strategy, None);
    assert_eq!(e.chosen, None);
    assert_eq!(e.fallback, None);
    assert_eq!(wire(e.strategy.as_ref()), "manual");
}

#[test]
fn the_project_s_choice_wins_over_the_organization_s_default() {
    let e = resolve(Some(sm()), Some(gm()), both());
    assert_eq!(e.strategy, Some(sm()));
    assert_eq!(e.source, Source::Project);
    let e = resolve(None, Some(gm()), both());
    assert_eq!(e.strategy, Some(gm()));
    assert_eq!(e.source, Source::Organization);
    assert_eq!(e.fallback, None);
}

#[test]
fn a_choice_whose_kit_went_falls_back_and_says_why() {
    // The matcher kit uninstalled: spec_mapping, with the reason.
    let e = resolve(Some(gm()), None, kits(&[sm()]));
    assert_eq!(e.chosen, Some(gm()));
    assert_eq!(e.strategy, Some(sm()));
    assert_eq!(e.fallback.as_ref().map(|f| f.0), Some("KIT_NOT_INSTALLED"));
    assert!(e.fallback.as_ref().unwrap().1.contains("gears-matcher"));
    // The spec-mapping kit uninstalled, the matcher there: the matcher.
    let e = resolve(None, Some(sm()), kits(&[gm()]));
    assert_eq!(e.strategy, Some(gm()));
    assert_eq!(e.fallback.as_ref().map(|f| f.0), Some("KIT_NOT_INSTALLED"));
    // Neither: by hand, still saying why.
    let e = resolve(Some(sm()), None, kits(&[]));
    assert_eq!(e.strategy, None);
    assert_eq!(e.fallback.as_ref().map(|f| f.0), Some("KIT_NOT_INSTALLED"));
    // With the kit, but no service: the gear-match routes' own sentence.
    let mut a = both();
    a.services.insert(
        "gears_matcher".into(),
        (
            "MATCHER_NOT_CONFIGURED",
            "the gears-matcher service has no address".into(),
        ),
    );
    let e = resolve(None, Some(gm()), a);
    assert_eq!(e.strategy, Some(sm()));
    assert_eq!(
        e.fallback,
        Some((
            "MATCHER_NOT_CONFIGURED",
            "the gears-matcher service has no address".to_owned()
        ))
    );
}

#[test]
fn an_organization_kit_s_strategy_is_offered_and_falls_back_until_connected() {
    // ADR-0074, amendment: an organization's kit brings `acme_matcher`.
    let mut a = kits(&[sm(), gm(), acme()]);
    assert_eq!(a.provided(), vec![sm(), gm(), acme()]);
    let e = resolve(None, Some(acme()), a.clone());
    assert_eq!(e.strategy, Some(acme()));
    // Not connected: falls back, saying so.
    a.services.insert(
        "acme_matcher".into(),
        ("STRATEGY_NOT_CONNECTED", "no service is connected".into()),
    );
    let e = resolve(None, Some(acme()), a);
    assert_eq!(e.strategy, Some(sm()));
    assert_eq!(
        e.fallback.as_ref().map(|f| f.0),
        Some("STRATEGY_NOT_CONNECTED")
    );
    // Its kit uninstalled: KIT_NOT_INSTALLED, without a built-in kit to name.
    let e = resolve(Some(acme()), None, both());
    assert_eq!(e.fallback.as_ref().map(|f| f.0), Some("KIT_NOT_INSTALLED"));
    assert!(e.fallback.unwrap().1.contains("acme_matcher"));
}

#[test]
fn unknown_kits_never_pass_a_paid_strategy_for_installed() {
    let unknown = Available::default();
    let e = resolve(Some(gm()), None, unknown.clone());
    assert_eq!(e.strategy, Some(sm()));
    assert_eq!(e.fallback.as_ref().map(|f| f.0), Some("KIT_UNKNOWN"));
    let e = resolve(None, None, unknown);
    assert_eq!(e.strategy, Some(sm()));
    assert_eq!(e.fallback, None);
}

#[test]
fn every_shipped_strategy_has_the_built_in_kit_that_declares_it() {
    for s in [sm(), gm()] {
        let (kit, _) = s.builtin_kit().unwrap();
        let provided = crate::kit_registry::port::assembly_strategies(&[kit.to_owned()]);
        let ids: Vec<&str> = provided.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, [s.as_str()], "{kit}");
        // The matcher is a service strategy too, the first of them.
        assert_eq!(provided[0].service.is_some(), !s.is_spec_mapping());
    }
    // Only kits that declare one provide one.
    assert!(
        crate::kit_registry::port::assembly_strategies(&["project-product".to_owned()]).is_empty()
    );
}

#[test]
fn a_strategy_reads_by_its_id_as_a_kit_writes_it() {
    assert_eq!(Strategy::parse("gears_matcher"), Some(gm()));
    assert_eq!(Strategy::parse(" spec_mapping "), Some(sm()));
    assert_eq!(Strategy::parse("acme_matcher"), Some(acme()));
    assert_eq!(Strategy::parse("Acme"), None);
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
    store.put(org, org, Some(gm()), "admin").await.unwrap();
    store.put(org, project, Some(sm()), "member").await.unwrap();
    assert_eq!(store.get(org, org).await.unwrap(), Some(gm()));
    assert_eq!(store.get(org, project).await.unwrap(), Some(sm()));
    // Replaced, then forgotten: the project follows the organization again.
    store.put(org, project, Some(gm()), "member").await.unwrap();
    assert_eq!(store.get(org, project).await.unwrap(), Some(gm()));
    store.put(org, project, None, "member").await.unwrap();
    assert_eq!(store.get(org, project).await.unwrap(), None);
    // Another organization reads none of it.
    assert_eq!(store.get(Uuid::new_v4(), org).await.unwrap(), None);
}
