use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;

use super::*;

/// The platform's root tenant: a platform administrator's home.
const ROOT: Uuid = Uuid::from_u128(1);
const ORG: Uuid = Uuid::from_u128(0x0ee5);
const PROJECT: &str = "d5e76267-60e3-4153-8e60-d4d8753ed01e";

/// Build records kept per tenant, as the domain model keeps them: a read
/// sees only the tenant its context names.
#[derive(Default)]
struct PerTenant(Mutex<HashMap<(Uuid, String, String), BuildRecord>>);

impl PerTenant {
    /// What the start-up sweep does to the root's objects of a project: moved
    /// into the organization, gone from the root.
    fn rehome(&self, from: Uuid, to: Uuid) {
        let mut m = self.0.lock().unwrap();
        let moved: Vec<_> = m.keys().filter(|(t, ..)| *t == from).cloned().collect();
        for k in moved {
            let r = m.remove(&k).unwrap();
            m.insert((to, k.1, k.2), r);
        }
    }

    fn tenants_of(&self, build_id: &str) -> Vec<Uuid> {
        self.0
            .lock()
            .unwrap()
            .keys()
            .filter(|(_, _, b)| b == build_id)
            .map(|(t, ..)| *t)
            .collect()
    }
}

#[async_trait]
impl BuildRecords for PerTenant {
    async fn build(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
        build_id: &str,
    ) -> anyhow::Result<Option<BuildRecord>> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .get(&(ctx.subject_tenant_id(), project_id.into(), build_id.into()))
            .cloned())
    }

    async fn record(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
        o: &BuildOutcome,
    ) -> anyhow::Result<()> {
        self.0.lock().unwrap().insert(
            (
                ctx.subject_tenant_id(),
                project_id.into(),
                o.build_id.clone(),
            ),
            BuildRecord {
                build_id: o.build_id.clone(),
                r#where: o.r#where.clone(),
                status: o.status.clone(),
                images: o.images.clone(),
                ..BuildRecord::default()
            },
        );
        Ok(())
    }
}

fn platform_admin() -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(0xa11))
        .subject_type("user")
        .subject_tenant_id(ROOT)
        .token_scopes(vec!["*".into()])
        .build()
        .unwrap()
}

fn passed() -> BuildOutcome {
    BuildOutcome {
        build_id: "research-7a977fac4b5a".into(),
        r#where: Some("research".into()),
        status: "passed".into(),
        images: vec![(
            "api-gateway".into(),
            "research-image/7d19/gbx-api-gateway:cd9a".into(),
        )],
        ..BuildOutcome::default()
    }
}

#[tokio::test]
async fn a_research_build_a_platform_administrator_started_outlives_the_move_into_its_organization()
{
    // How research-7a977fac4b5a went (2026-11-24): recorded in the caller's
    // tenant, the root; the start-up sweep moved the project's objects into
    // the organization; the deploy route, reading the root, found no build.
    let store = Arc::new(PerTenant::default());
    let admin = platform_admin();
    store.record(&admin, PROJECT, &passed()).await.unwrap();
    store.rehome(ROOT, ORG);
    assert!(
        store
            .build(&admin, PROJECT, "research-7a977fac4b5a")
            .await
            .unwrap()
            .is_none(),
        "the cause: a read in the caller's tenant misses the moved record"
    );

    // Through the organization: written there, and found there by the same
    // caller before and after the sweep.
    let store = Arc::new(PerTenant::default());
    let builds = OrgBuilds::new(store.clone(), ORG);
    builds.record(&admin, PROJECT, &passed()).await.unwrap();
    assert_eq!(store.tenants_of("research-7a977fac4b5a"), [ORG]);
    store.rehome(ROOT, ORG);
    let found = builds
        .build(&admin, PROJECT, "research-7a977fac4b5a")
        .await
        .unwrap()
        .expect("the passed build is still there");
    assert_eq!(found.status, "passed");
    assert_eq!(found.images.len(), 1);
}

#[tokio::test]
async fn a_member_of_the_organization_reads_the_same_records() {
    let store = Arc::new(PerTenant::default());
    let builds = OrgBuilds::new(store.clone(), ORG);
    builds
        .record(&platform_admin(), PROJECT, &passed())
        .await
        .unwrap();
    let member = crate::org_scope::acting_in(&platform_admin(), ORG).unwrap();
    assert!(
        store
            .build(&member, PROJECT, "research-7a977fac4b5a")
            .await
            .unwrap()
            .is_some()
    );
}
