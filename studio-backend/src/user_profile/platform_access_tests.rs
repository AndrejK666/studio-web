//! ADR-0081's rules over the in-memory store: who holds a platform role, who
//! grants and reads grants, and how published terms become pending and are
//! accepted.

use std::sync::Mutex;

use super::*;
use crate::audit::AuditRecorder;

const ORG: Uuid = Uuid::from_u128(0xc0);
const OTHER_ORG: Uuid = Uuid::from_u128(0xc1);

fn admin() -> Caller {
    Caller {
        person: Uuid::from_u128(0xad),
        administrator: true,
    }
}

fn person(n: u128) -> Caller {
    Caller {
        person: Uuid::from_u128(n),
        administrator: false,
    }
}

fn ctx() -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(0x5e))
        .subject_tenant_id(Uuid::from_u128(0x0a))
        .build()
        .unwrap()
}

#[derive(Default)]
struct Kept(Mutex<Vec<String>>);

#[async_trait]
impl AuditRecorder for Kept {
    async fn record(&self, _: &SecurityContext, events: Vec<AuditEvent>) -> Result<()> {
        self.0
            .lock()
            .unwrap()
            .extend(events.into_iter().map(|e| e.action));
        Ok(())
    }
}

fn access() -> (PlatformAccess, Arc<Kept>) {
    let kept = Arc::new(Kept::default());
    let access = PlatformAccess::new(Arc::new(MemoryStore::default()))
        .with_audit(Audit::fixed(kept.clone()));
    (access, kept)
}

fn roles(r: &[&str]) -> Vec<String> {
    r.iter().map(|s| (*s).to_owned()).collect()
}

#[tokio::test]
async fn an_administrator_holds_every_role_and_a_person_only_what_they_were_given() {
    let (access, _) = access();
    assert_eq!(
        access.roles(&admin()).await.unwrap(),
        roles(&PLATFORM_ROLES)
    );
    let manager = person(1);
    assert!(access.roles(&manager).await.unwrap().is_empty());
    assert!(!access.is_platform_staff(&manager).await.unwrap());
    access
        .set_roles(
            &ctx(),
            &admin(),
            manager.person,
            &roles(&["account_manager"]),
        )
        .await
        .unwrap();
    assert_eq!(
        access.roles(&manager).await.unwrap(),
        roles(&["account_manager"])
    );
    assert!(access.holds(&manager, ROLE_ACCOUNT_MANAGER).await.unwrap());
    assert!(!access.holds(&manager, ROLE_OPERATOR).await.unwrap());
    assert!(access.is_platform_staff(&manager).await.unwrap());
}

#[tokio::test]
async fn only_an_administrator_gives_platform_roles_and_only_known_ones() {
    let (access, kept) = access();
    let someone = person(2);
    // Even an operator does not give roles.
    access
        .set_roles(&ctx(), &admin(), someone.person, &roles(&["operator"]))
        .await
        .unwrap();
    assert!(matches!(
        access
            .set_roles(
                &ctx(),
                &someone,
                someone.person,
                &roles(&["account_manager"])
            )
            .await,
        Err(Refusal::Forbidden(PLATFORM_ADMIN_REQUIRED))
    ));
    assert!(matches!(
        access.list_roles(&someone).await,
        Err(Refusal::Forbidden(PLATFORM_ADMIN_REQUIRED))
    ));
    assert!(matches!(
        access
            .set_roles(&ctx(), &admin(), someone.person, &roles(&["owner"]))
            .await,
        Err(Refusal::Invalid(_))
    ));
    // Repeats collapse and the order is the platform's.
    let set = access
        .set_roles(
            &ctx(),
            &admin(),
            someone.person,
            &roles(&["account_manager", "operator", "operator"]),
        )
        .await
        .unwrap();
    assert_eq!(set, roles(&["operator", "account_manager"]));
    // `[]` takes every role.
    access
        .set_roles(&ctx(), &admin(), someone.person, &[])
        .await
        .unwrap();
    assert!(access.roles(&someone).await.unwrap().is_empty());
    assert_eq!(
        *kept.0.lock().unwrap(),
        [
            "platform_role.set",
            "platform_role.set",
            "platform_role.set"
        ]
    );
}

#[tokio::test]
async fn an_account_manager_grants_and_a_member_reads_only_their_organizations_grants() {
    let (access, kept) = access();
    let manager = person(3);
    access
        .set_roles(
            &ctx(),
            &admin(),
            manager.person,
            &roles(&["account_manager"]),
        )
        .await
        .unwrap();
    let developer = person(4);
    assert!(matches!(
        access
            .grant(&ctx(), &developer, "repository", "learn-api", ORG)
            .await,
        Err(Refusal::Forbidden(ACCOUNT_MANAGER_REQUIRED))
    ));
    let g = access
        .grant(&ctx(), &manager, "repository", "learn-api", ORG)
        .await
        .unwrap();
    assert_eq!(g.id, grant_id("repository", "learn-api", ORG));
    // Granting again answers the first grant and audits nothing new.
    let again = access
        .grant(&ctx(), &admin(), "repository", "learn-api", ORG)
        .await
        .unwrap();
    assert_eq!(again.granted_by, manager.person.to_string());
    access
        .grant(&ctx(), &manager, "repository", "learn-web", OTHER_ORG)
        .await
        .unwrap();

    // The platform's people read every grant.
    assert_eq!(
        access
            .grants(&manager, &[], None, None)
            .await
            .unwrap()
            .len(),
        2
    );
    // A member reads their organization's only, and must name it.
    let mine = access
        .grants(&developer, &[ORG], Some(ORG), Some("repository"))
        .await
        .unwrap();
    assert_eq!(mine.len(), 1);
    assert_eq!(mine[0].resource, "learn-api");
    for asked in [None, Some(OTHER_ORG)] {
        assert!(matches!(
            access.grants(&developer, &[ORG], asked, None).await,
            Err(Refusal::Forbidden(ORG_MEMBER_REQUIRED))
        ));
    }
    let resources = |kind: &'static str| {
        let access = &access;
        async move {
            access
                .grants(&admin(), &[], Some(ORG), Some(kind))
                .await
                .unwrap()
                .into_iter()
                .map(|g| g.resource)
                .collect::<Vec<_>>()
        }
    };
    assert_eq!(resources("repository").await, ["learn-api"]);
    assert!(resources("staging").await.is_empty());

    access.revoke(&ctx(), &manager, g.id).await.unwrap();
    assert!(resources("repository").await.is_empty());
    assert!(matches!(
        access.revoke(&ctx(), &manager, g.id).await,
        Err(Refusal::NotFound)
    ));
    assert_eq!(
        *kept.0.lock().unwrap(),
        [
            "platform_role.set",
            "platform_grant.made",
            "platform_grant.made",
            "platform_grant.removed"
        ]
    );
}

#[tokio::test]
async fn a_grant_names_a_kind_a_resource_and_an_organization() {
    let (access, _) = access();
    for (kind, resource, org) in [
        ("Repository", "x", ORG),
        ("", "x", ORG),
        ("repository", " ", ORG),
        ("repository", "x", ROOT_TENANT),
        ("repository", "x", Uuid::nil()),
    ] {
        assert!(
            matches!(
                access.grant(&ctx(), &admin(), kind, resource, org).await,
                Err(Refusal::Invalid(_))
            ),
            "{kind:?} {resource:?} {org}"
        );
    }
}

#[tokio::test]
async fn nothing_published_nothing_pending() {
    let (access, _) = access();
    assert!(
        access
            .pending(Uuid::from_u128(5), ORG, "owner")
            .await
            .unwrap()
            .is_empty()
    );
    assert!(access.latest_terms().await.unwrap().is_empty());
}

#[tokio::test]
async fn published_terms_are_pending_for_whom_they_apply_until_accepted() {
    let (access, kept) = access();
    let operator = person(6);
    access
        .set_roles(&ctx(), &admin(), operator.person, &roles(&["operator"]))
        .await
        .unwrap();
    assert!(matches!(
        access
            .publish_terms(&ctx(), &person(7), AUDIENCE_MEMBER, "Terms of use", "…")
            .await,
        Err(Refusal::Forbidden(OPERATOR_REQUIRED))
    ));
    let member_terms = access
        .publish_terms(
            &ctx(),
            &operator,
            AUDIENCE_MEMBER,
            "Terms of use",
            "Be kind.",
        )
        .await
        .unwrap();
    assert_eq!(member_terms.version, 1);
    access
        .publish_terms(
            &ctx(),
            &operator,
            AUDIENCE_ORGANIZATION_ADMIN,
            "Terms and conditions",
            "The company agrees.",
        )
        .await
        .unwrap();

    let developer = Uuid::from_u128(8);
    let company_admin = Uuid::from_u128(9);
    let pending = |p, role: &'static str| {
        let access = &access;
        async move {
            access
                .pending(p, ORG, role)
                .await
                .unwrap()
                .into_iter()
                .map(|t| (t.audience, t.version))
                .collect::<Vec<_>>()
        }
    };
    assert_eq!(
        pending(developer, "member").await,
        [("member".to_owned(), 1)]
    );
    assert_eq!(
        pending(company_admin, "admin").await,
        [
            ("organization_admin".to_owned(), 1),
            ("member".to_owned(), 1)
        ]
    );

    // A developer may not accept the company's terms.
    assert!(matches!(
        access
            .accept(
                &ctx(),
                developer,
                ORG,
                "member",
                AUDIENCE_ORGANIZATION_ADMIN,
                1
            )
            .await,
        Err(Refusal::Invalid(_))
    ));
    access
        .accept(&ctx(), developer, ORG, "member", AUDIENCE_MEMBER, 1)
        .await
        .unwrap();
    assert!(pending(developer, "member").await.is_empty());
    // Accepted in one organization, still pending in another.
    assert_eq!(
        access
            .pending(developer, OTHER_ORG, "member")
            .await
            .unwrap()
            .len(),
        1
    );

    // A new version is pending again, and only the latest is accepted.
    access
        .publish_terms(
            &ctx(),
            &admin(),
            AUDIENCE_MEMBER,
            "Terms of use",
            "Be kinder.",
        )
        .await
        .unwrap();
    assert_eq!(
        pending(developer, "member").await,
        [("member".to_owned(), 2)]
    );
    assert!(matches!(
        access
            .accept(&ctx(), developer, ORG, "member", AUDIENCE_MEMBER, 1)
            .await,
        Err(Refusal::Stale(2))
    ));
    access
        .accept(&ctx(), developer, ORG, "member", AUDIENCE_MEMBER, 2)
        .await
        .unwrap();
    assert!(pending(developer, "member").await.is_empty());
    assert_eq!(
        access
            .latest_terms()
            .await
            .unwrap()
            .into_iter()
            .map(|t| (t.audience, t.version))
            .collect::<Vec<_>>(),
        [
            ("organization_admin".to_owned(), 1),
            ("member".to_owned(), 2)
        ]
    );
    let actions = kept.0.lock().unwrap().clone();
    assert_eq!(
        actions.iter().filter(|a| *a == "terms.published").count(),
        3
    );
    assert_eq!(actions.iter().filter(|a| *a == "terms.accepted").count(), 2);
}

#[tokio::test]
async fn terms_name_a_known_audience_a_title_and_a_text() {
    let (access, _) = access();
    for (audience, title, body) in [
        ("developers", "t", "b"),
        ("member", " ", "b"),
        ("member", "t", "  "),
    ] {
        assert!(matches!(
            access
                .publish_terms(&ctx(), &admin(), audience, title, body)
                .await,
            Err(Refusal::Invalid(_))
        ));
    }
}
