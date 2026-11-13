//! `platform_auth` is a platform administrator's to set or change (#1094).
//!
//! A connection with it reads GitHub with the platform's credential, through
//! the GitHub mirror, so turning it on or off is not a connection editor's
//! call. Everything else about creating and editing a connection works for
//! everybody exactly as before.
#![allow(clippy::expect_used, clippy::unwrap_used)]

use async_trait::async_trait;

use super::oauth_flow_tests::{Catalogues, Secrets};
use super::*;
use crate::connectors::driver::ConnectorCategory;
use crate::user_profile::SubjectMembership;

const ORG: Uuid = Uuid::from_u128(0x0a);
const ADMIN: u128 = 0xad;
const MEMBER: u128 = 0x3e;

fn caller(n: u128) -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(n))
        .subject_type("user")
        .subject_tenant_id(ORG)
        .build()
        .unwrap()
}

/// A GitHub-shaped driver: takes `platform_auth`, accepts any credential.
struct GitHubLike;

#[async_trait]
impl ConnectorDriver for GitHubLike {
    fn provider(&self) -> &'static str {
        "github"
    }
    fn display_name(&self) -> &'static str {
        "GitHub"
    }
    fn default_base_url(&self) -> &'static str {
        "https://api.github.com"
    }
    fn category(&self) -> ConnectorCategory {
        ConnectorCategory::SourceCode
    }
    fn check_options(
        &self,
        _base_url: &str,
        options: &BTreeMap<String, String>,
    ) -> anyhow::Result<BTreeMap<String, String>> {
        Ok(options.clone())
    }
    async fn test(&self, _auth: &ConnectionAuth) -> anyhow::Result<DriverIdentity> {
        Ok(DriverIdentity {
            account: "octocat".into(),
            display_name: None,
            checks: Vec::new(),
        })
    }
}

/// studio-user's answer: who is a platform administrator.
struct Admins(Vec<String>);

#[async_trait]
impl OrganizationReader for Admins {
    async fn organizations_of(&self, _: &str) -> anyhow::Result<Vec<Uuid>> {
        Ok(Vec::new())
    }
    async fn grant_keys_of(&self, subject: &str) -> anyhow::Result<Vec<String>> {
        Ok(vec![subject.to_owned()])
    }
    async fn is_platform_admin(&self, subject: &str) -> anyhow::Result<bool> {
        Ok(self.0.iter().any(|a| a == subject))
    }
    async fn memberships_of_subject(&self, _: &str) -> anyhow::Result<Vec<SubjectMembership>> {
        Ok(Vec::new())
    }
    fn membership_generation(&self) -> u64 {
        0
    }
}

fn admins() -> Admins {
    Admins(vec![Uuid::from_u128(ADMIN).to_string()])
}

fn service() -> Arc<ConnectorService> {
    let driver: Arc<dyn ConnectorDriver> = Arc::new(GitHubLike);
    ConnectorService::new(
        Arc::new(Catalogues::default()),
        Arc::new(Secrets::default()),
        vec![("github-instance".into(), driver)],
    )
}

fn platform(on: &str) -> BTreeMap<String, String> {
    [(OPTION_PLATFORM_AUTH.to_owned(), on.to_owned())].into()
}

fn new_connection(options: BTreeMap<String, String>) -> NewConnection<'static> {
    NewConnection {
        owner_tenant: ORG,
        provider: "github",
        label: "GitHub",
        base_url: None,
        token: "ghp_example",
        scope: "workspace",
        options,
    }
}

fn refused(e: &anyhow::Error) -> bool {
    e.downcast_ref::<PlatformAuthRefused>().is_some()
}

#[test]
fn only_a_change_of_the_value_counts() {
    let none = BTreeMap::new();
    // Creating: on is a change, off or absent is not.
    assert!(changes_platform_auth(None, &platform("true")));
    assert!(!changes_platform_auth(None, &platform("false")));
    assert!(!changes_platform_auth(None, &none));
    // Editing: turning it on or off is, keeping it is not.
    assert!(changes_platform_auth(Some(&none), &platform("true")));
    assert!(changes_platform_auth(Some(&platform("true")), &none));
    assert!(changes_platform_auth(
        Some(&platform("true")),
        &platform("false")
    ));
    assert!(!changes_platform_auth(
        Some(&platform("true")),
        &platform("true")
    ));
    assert!(!changes_platform_auth(Some(&platform("false")), &none));
}

#[tokio::test]
async fn a_member_may_not_create_a_platform_auth_connection() {
    let svc = service();
    let e = svc
        .create(
            &caller(MEMBER),
            Some(&admins()),
            new_connection(platform("true")),
        )
        .await
        .unwrap_err();
    assert!(refused(&e), "{e:#}");

    // Without studio-user nobody is an administrator.
    let e = svc
        .create(&caller(ADMIN), None, new_connection(platform("true")))
        .await
        .unwrap_err();
    assert!(refused(&e), "{e:#}");
}

#[tokio::test]
async fn a_platform_administrator_may_create_one() {
    let (c, _) = service()
        .create(
            &caller(ADMIN),
            Some(&admins()),
            new_connection(platform("true")),
        )
        .await
        .unwrap();
    assert!(platform_auth(&c.options));
}

#[tokio::test]
async fn a_connection_without_platform_auth_is_anybodys_to_create() {
    let svc = service();
    for options in [BTreeMap::new(), platform("false")] {
        let (c, _) = svc
            .create(&caller(MEMBER), None, new_connection(options))
            .await
            .unwrap();
        assert!(!platform_auth(&c.options));
    }
}

#[tokio::test]
async fn a_member_may_edit_a_platform_auth_connection_but_not_switch_it() {
    let svc = service();
    let (c, _) = svc
        .create(
            &caller(ADMIN),
            Some(&admins()),
            new_connection(platform("true")),
        )
        .await
        .unwrap();
    let member = caller(MEMBER);

    // Renaming it, or sending the option back unchanged, works as before.
    for options in [None, Some(platform("true"))] {
        svc.update(
            &member,
            ORG,
            c.id,
            None,
            Some(&admins()),
            ConnectionEdit {
                label: Some("Renamed"),
                options,
                ..ConnectionEdit::default()
            },
        )
        .await
        .unwrap();
    }

    // Turning it off is a change, and refused.
    for options in [BTreeMap::new(), platform("false")] {
        let e = svc
            .update(
                &member,
                ORG,
                c.id,
                None,
                Some(&admins()),
                ConnectionEdit {
                    options: Some(options),
                    ..ConnectionEdit::default()
                },
            )
            .await
            .unwrap_err();
        assert!(refused(&e), "{e:#}");
    }
}

#[tokio::test]
async fn only_a_platform_administrator_may_turn_it_on_for_an_existing_connection() {
    let svc = service();
    let (c, _) = svc
        .create(&caller(MEMBER), None, new_connection(BTreeMap::new()))
        .await
        .unwrap();
    let turn_on = || ConnectionEdit {
        options: Some(platform("true")),
        ..ConnectionEdit::default()
    };

    let e = svc
        .update(&caller(MEMBER), ORG, c.id, None, Some(&admins()), turn_on())
        .await
        .unwrap_err();
    assert!(refused(&e), "{e:#}");

    let (c, _) = svc
        .update(&caller(ADMIN), ORG, c.id, None, Some(&admins()), turn_on())
        .await
        .unwrap();
    assert!(platform_auth(&c.options));
}
