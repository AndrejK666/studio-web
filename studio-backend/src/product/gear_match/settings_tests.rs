//! Who may change a service's run settings, and how they pass through: an
//! organization's own service is its administrator's, the deployment's shared
//! one a platform administrator's; the change is recorded as the caller's,
//! the service's refusals keep their codes, and the organization page's live
//! check asks the service again after a change.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{Value, json};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::super::GearMatches;
use super::super::client::{Matcher, MatcherError, Result};
use super::super::config::MatcherConfig;
use super::super::services::MatcherDirectory;
use super::*;

/// A service that keeps the bodies it was sent and answers `refuse` to a
/// change when set.
#[derive(Default)]
struct Service {
    puts: Mutex<Vec<Value>>,
    infos: Mutex<u32>,
    refuse: Option<MatcherError>,
}

#[async_trait]
impl Matcher for Service {
    fn missing(&self) -> Option<String> {
        None
    }
    async fn info(&self) -> Result<Value> {
        *self.infos.lock().unwrap() += 1;
        Ok(json!({"models": ["m1"]}))
    }
    async fn submit(&self, _key: &str, _body: &Value) -> Result<Value> {
        unreachable!("no run here")
    }
    async fn run(&self, _id: &str) -> Result<Value> {
        unreachable!("no run here")
    }
    async fn report(&self, _id: &str) -> Result<Value> {
        unreachable!("no run here")
    }
    async fn cancel(&self, _id: &str) -> Result<Value> {
        unreachable!("no run here")
    }
    async fn settings(&self) -> Result<Value> {
        Ok(json!({"version": 3, "effective": {"provider": "openai"}}))
    }
    async fn put_settings(&self, body: &Value) -> Result<Value> {
        if let Some(e) = &self.refuse {
            return Err(e.clone());
        }
        self.puts.lock().unwrap().push(body.clone());
        Ok(json!({"version": 4}))
    }
}

/// The organization's connection for `gears_matcher`, when it has one.
struct Directory(Option<Arc<Service>>);

#[async_trait]
impl MatcherDirectory for Directory {
    async fn connected(
        &self,
        _ctx: &SecurityContext,
        _org: Uuid,
        _strategy: &str,
    ) -> std::result::Result<Option<Arc<dyn Matcher>>, String> {
        Ok(self.0.clone().map(|s| s as Arc<dyn Matcher>))
    }
}

/// Who the caller is: an organization administrator, a platform one.
struct Caller {
    org_admin: bool,
    platform_admin: bool,
}

#[async_trait]
impl SettingsAuthority for Caller {
    async fn administers(&self, _ctx: &SecurityContext, _org: Uuid) -> bool {
        self.org_admin
    }
    async fn is_platform_admin(&self, _ctx: &SecurityContext) -> bool {
        self.platform_admin
    }
}

const MEMBER: Caller = Caller {
    org_admin: false,
    platform_admin: false,
};
const ORG_ADMIN: Caller = Caller {
    org_admin: true,
    platform_admin: false,
};
const PLATFORM_ADMIN: Caller = Caller {
    org_admin: false,
    platform_admin: true,
};

fn ctx(org: Uuid) -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(9))
        .subject_tenant_id(org)
        .build()
        .unwrap()
}

/// The deployment's service is `deployment`; the organization's connection
/// `connected`, when given.
fn matches(deployment: Arc<Service>, connected: Option<Arc<Service>>) -> GearMatches {
    GearMatches::new(
        MatcherConfig::default(),
        deployment,
        None,
        Arc::new(toolkit::client_hub::ClientHub::new()),
    )
    .with_directory(Arc::new(Directory(connected)))
}

#[tokio::test]
async fn an_organization_s_own_service_is_its_administrator_s_to_change() {
    let org = Uuid::from_u128(1);
    let ctx = ctx(org);
    let s = ServiceScope::Organization;
    assert!(may_change(&ORG_ADMIN, &ctx, org, s).await);
    assert!(!may_change(&MEMBER, &ctx, org, s).await);
}

#[tokio::test]
async fn the_deployment_s_shared_service_is_a_platform_administrator_s_only() {
    let org = Uuid::from_u128(1);
    let ctx = ctx(org);
    let s = ServiceScope::Deployment;
    assert!(may_change(&PLATFORM_ADMIN, &ctx, org, s).await);
    assert!(
        !may_change(&ORG_ADMIN, &ctx, org, s).await,
        "an organization administrator does not change what every organization shares"
    );
    assert!(!may_change(&MEMBER, &ctx, org, s).await);
}

#[tokio::test]
async fn a_read_says_whose_service_it_is_and_whether_the_caller_may_change_it() {
    let org = Uuid::from_u128(1);
    let deployment = Arc::new(Service::default());
    let shared = matches(Arc::clone(&deployment), None);
    let read = shared
        .read_settings(&ORG_ADMIN, &ctx(org), org, "gears_matcher")
        .await
        .unwrap();
    assert_eq!(read.scope, ServiceScope::Deployment);
    assert!(!read.may_change);
    assert_eq!(read.settings["version"], 3);

    let own = matches(deployment, Some(Arc::new(Service::default())));
    let read = own
        .read_settings(&ORG_ADMIN, &ctx(org), org, "gears_matcher")
        .await
        .unwrap();
    assert_eq!(read.scope, ServiceScope::Organization);
    assert!(read.may_change);
}

#[tokio::test]
async fn a_change_goes_to_the_service_as_the_caller_s() {
    let org = Uuid::from_u128(1);
    let connected = Arc::new(Service::default());
    let deployment = Arc::new(Service::default());
    let m = matches(Arc::clone(&deployment), Some(Arc::clone(&connected)));
    let read = m
        .change_settings(
            &ORG_ADMIN,
            &ctx(org),
            org,
            "gears_matcher",
            3,
            json!({"provider": "anthropic", "models": null}),
        )
        .await
        .unwrap();
    assert_eq!(read.settings["version"], 4);
    assert!(read.may_change);
    let puts = connected.puts.lock().unwrap();
    assert_eq!(
        *puts,
        [json!({
            "version": 3,
            "overrides": {"provider": "anthropic", "models": null},
            "updated_by": Uuid::from_u128(9).to_string()
        })]
    );
    assert!(
        deployment.puts.lock().unwrap().is_empty(),
        "the organization's own service, not the deployment's"
    );
}

#[tokio::test]
async fn a_caller_who_may_not_is_refused_before_the_service_is_asked() {
    let org = Uuid::from_u128(1);
    let deployment = Arc::new(Service::default());
    let m = matches(Arc::clone(&deployment), None);
    let refused = m
        .change_settings(&ORG_ADMIN, &ctx(org), org, "gears_matcher", 0, json!({}))
        .await
        .unwrap_err();
    assert_eq!(refused, SettingsRefusal::Forbidden);
    assert!(deployment.puts.lock().unwrap().is_empty());
    m.change_settings(
        &PLATFORM_ADMIN,
        &ctx(org),
        org,
        "gears_matcher",
        0,
        json!({}),
    )
    .await
    .expect("a platform administrator changes the shared service");
    assert_eq!(deployment.puts.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn the_service_s_refusals_keep_their_codes() {
    let org = Uuid::from_u128(1);
    let refused = |status: u16, code: &str| {
        Arc::new(Service {
            refuse: Some(MatcherError::Upstream {
                status,
                code: Some(code.into()),
                detail: format!("{code} said"),
            }),
            ..Service::default()
        })
    };
    let change = |service: Arc<Service>| async move {
        matches(service, None)
            .change_settings(
                &PLATFORM_ADMIN,
                &ctx(org),
                org,
                "gears_matcher",
                1,
                json!({}),
            )
            .await
            .unwrap_err()
    };
    assert!(matches!(
        change(refused(409, "settings_conflict")).await,
        SettingsRefusal::Conflict(_)
    ));
    assert_eq!(
        change(refused(422, "provider_unavailable")).await,
        SettingsRefusal::Invalid {
            code: PROVIDER_UNAVAILABLE,
            why: "provider_unavailable said".into()
        }
    );
    assert_eq!(
        change(refused(422, "bad_settings")).await,
        SettingsRefusal::Invalid {
            code: BAD_SETTINGS,
            why: "bad_settings said".into()
        }
    );
    assert!(matches!(
        change(refused(503, "unavailable")).await,
        SettingsRefusal::Unavailable(_)
    ));
}

#[tokio::test]
async fn without_a_service_the_settings_are_unavailable() {
    let org = Uuid::from_u128(1);
    let config = MatcherConfig {
        base_url_env: "STUDIO_TEST_GM_SETTINGS_URL_NONE".into(),
        secret_env: "STUDIO_TEST_GM_SETTINGS_SECRET_NONE".into(),
        ..MatcherConfig::default()
    };
    let unconfigured = Arc::new(super::super::client::HttpMatcher::from_config(&config));
    let m = GearMatches::new(
        config,
        unconfigured,
        None,
        Arc::new(toolkit::client_hub::ClientHub::new()),
    )
    .with_directory(Arc::new(Directory(None)));
    assert!(matches!(
        m.read_settings(&PLATFORM_ADMIN, &ctx(org), org, "gears_matcher")
            .await,
        Err(SettingsRefusal::Unavailable(_))
    ));
    assert!(matches!(
        m.read_settings(&PLATFORM_ADMIN, &ctx(org), org, "acme_matcher")
            .await,
        Err(SettingsRefusal::Unavailable(_))
    ));
}

#[tokio::test]
async fn after_a_change_the_live_check_asks_the_service_again() {
    let org = Uuid::from_u128(1);
    let deployment = Arc::new(Service::default());
    let m = matches(Arc::clone(&deployment), None);
    let ctx = ctx(org);
    m.live_info(&ctx, org, "gears_matcher").await.unwrap();
    m.live_info(&ctx, org, "gears_matcher").await.unwrap();
    assert_eq!(*deployment.infos.lock().unwrap(), 1, "kept 30 s");
    m.change_settings(&PLATFORM_ADMIN, &ctx, org, "gears_matcher", 0, json!({}))
        .await
        .unwrap();
    m.live_info(&ctx, org, "gears_matcher").await.unwrap();
    assert_eq!(*deployment.infos.lock().unwrap(), 2);
}
