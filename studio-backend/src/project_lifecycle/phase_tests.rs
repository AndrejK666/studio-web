use std::sync::Arc;

use super::*;
use crate::kit_registry::installed::{KitInstaller, PLATFORM_TENANT};
use crate::kit_registry::testing::{
    ADMIN, ORG, PLATFORM_ADMIN, PROJECT, anyone, caller, installer_over, runtime_of,
};

fn setup() -> (Arc<KitInstaller>, ProjectLifecycle) {
    let installer = installer_over(crate::domain_model::port::in_memory());
    let lifecycle = ProjectLifecycle::new(runtime_of(&installer));
    (installer, lifecycle)
}

#[test]
fn the_phase_lifecycle_is_the_kit_s() {
    let l = lifecycle();
    assert_eq!(l.states, ["idea", "discovery", "build", "run"]);
    assert_eq!(l.initial.as_deref(), Some("idea"));
    // No phase yet: any starts it.
    assert!(l.allows(None, "build"));
    assert!(l.allows(Some("idea"), "discovery"));
    assert!(l.allows(Some("build"), "build"), "staying is not a move");
    assert!(l.allows(Some("build"), "idea"));
    assert!(!l.allows(Some("idea"), "run"));
    assert!(!l.allows(Some("idea"), "nowhere"));
    assert_eq!(
        l.next(Some("discovery")),
        [
            ("build".to_owned(), "build".to_owned()),
            ("rethink".to_owned(), "idea".to_owned())
        ]
    );
}

#[tokio::test]
async fn a_project_s_phase_moves_along_the_lifecycle_only() {
    let (installer, lifecycle) = setup();
    let admin = caller(ADMIN, ORG);

    // A built-in kit is a base kit by default: it applies, with no phase yet.
    let none = lifecycle.project_phase(&admin, PROJECT).await.unwrap();
    assert!(none.installed);
    assert_eq!(none.phase, None);
    let set = lifecycle
        .set_project_phase(&admin, PROJECT, "idea", None)
        .await
        .unwrap();
    assert_eq!(set.phase.as_deref(), Some("idea"));
    assert_eq!(set.owner, Some(ADMIN.to_string()), "the caller owns it");
    assert!(set.since.is_some());
    assert!(matches!(
        lifecycle
            .set_project_phase(&admin, PROJECT, "run", None)
            .await,
        Err(Refusal::Precondition("phase", _, NO_SUCH_TRANSITION))
    ));
    assert!(matches!(
        lifecycle
            .set_project_phase(&admin, PROJECT, "nowhere", None)
            .await,
        Err(Refusal::Invalid(_))
    ));
    let moved = lifecycle
        .set_project_phase(&admin, PROJECT, "discovery", Some("someone"))
        .await
        .unwrap();
    assert_eq!(moved.owner.as_deref(), Some("someone"));
    let (applies, rows) = lifecycle.project_phases(&admin, ORG).await.unwrap();
    assert!(applies);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0, PROJECT.to_string());
    assert_eq!(rows[0].1, "discovery");
    let by_project = lifecycle.phases_in(&admin, ORG).await.unwrap().unwrap();
    assert_eq!(
        by_project.get(&PROJECT).map(String::as_str),
        Some("discovery")
    );

    // The platform takes the base kit away: no phase is read or written.
    let platform = caller(PLATFORM_ADMIN, PLATFORM_TENANT);
    installer.uninstall_base(&platform, SLUG).await.unwrap();
    installer.reconcile_models(ORG).await.unwrap();
    let gone = lifecycle.project_phase(&admin, PROJECT).await.unwrap();
    assert!(!gone.installed);
    assert!(matches!(
        lifecycle
            .set_project_phase(&admin, PROJECT, "build", None)
            .await,
        Err(Refusal::KitNotInstalled(_))
    ));
    let (applies, rows) = lifecycle.project_phases(&admin, ORG).await.unwrap();
    assert!(!applies && rows.is_empty());
    assert_eq!(lifecycle.phases_in(&admin, ORG).await.unwrap(), None);
}

/// Every route the kit's function serves is one its kit.json claims: the
/// claimed-route gate studio-kits mounts it through lets it in.
#[test]
fn the_kit_s_routes_pass_the_claimed_route_gate() {
    let (_, lifecycle) = setup();
    let routes = super::super::Routes {
        lifecycle: Arc::new(lifecycle),
        access: anyone(),
    };
    let openapi = toolkit::api::OpenApiRegistryImpl::new();
    crate::kit_registry::runtime::mount(SLUG, &routes, axum::Router::new(), &openapi)
        .expect("every route of Project lifecycle is claimed");
}
