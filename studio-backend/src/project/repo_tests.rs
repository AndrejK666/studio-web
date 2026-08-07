//! SQLite-backed tests for [`ProjectRepo`].
//!
//! These cover what the pure-domain tests cannot: the migration itself, the
//! flatten/reconstruct round-trip of the source sum type, the unique index that
//! makes a name unique per workspace, and the tenant clamp.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;

use toolkit_db::migration_runner::run_migrations_for_testing;
use toolkit_db::sea_orm_migration::MigratorTrait;
use toolkit_db::{ConnectOpts, DBProvider, connect_db};
use uuid::Uuid;

use crate::project::migrations::Migrator;
use crate::project::model::{NewProject, ProjectSource, Status};
use crate::project::repo::{ProjectRepo, RepoError};

const WS_A: Uuid = Uuid::from_u128(0xa1);
const WS_B: Uuid = Uuid::from_u128(0xb2);
const ACTOR: Uuid = Uuid::from_u128(0xc3);

async fn setup() -> ProjectRepo {
    let dsn = format!(
        "sqlite:file:studio_projects_{}?mode=memory&cache=shared",
        Uuid::new_v4()
    );
    let db = connect_db(
        &dsn,
        ConnectOpts {
            max_conns: Some(1),
            min_conns: Some(1),
            ..Default::default()
        },
    )
    .await
    .expect("connect sqlite");

    run_migrations_for_testing(&db, Migrator::migrations())
        .await
        .expect("run migrations");

    ProjectRepo::new(Arc::new(DBProvider::<RepoError>::new(db)))
}

fn new_project(tenant: Uuid, name: &str, source: ProjectSource) -> NewProject {
    NewProject::build(tenant, ACTOR, name, source, &["architecture".to_owned()])
        .expect("valid project")
}

#[tokio::test]
async fn a_greenfield_project_round_trips() {
    let repo = setup().await;
    let new = new_project(
        WS_A,
        "Payments v2",
        ProjectSource::Idea { brief: Some("an idea".into()) },
    );
    let created = repo.insert(&new).await.unwrap();

    assert_eq!(created.name, "Payments v2");
    assert_eq!(created.status, Status::Draft, "projects start as drafts");
    assert_eq!(created.stages, vec!["intent".to_owned(), "architecture".to_owned()]);
    assert_eq!(created.source, ProjectSource::Idea { brief: Some("an idea".into()) });
    assert!(created.rg_group_id.is_none(), "the members group is attached afterwards");

    let found = repo.find(WS_A, created.id).await.unwrap().unwrap();
    assert_eq!(found, created);
}

#[tokio::test]
async fn a_git_modernization_round_trips() {
    let repo = setup().await;
    let new = new_project(WS_A, "Legacy CRM", ProjectSource::Git { url: "https://git/x".into() });
    let created = repo.insert(&new).await.unwrap();
    assert_eq!(created.source, ProjectSource::Git { url: "https://git/x".into() });
    let found = repo.find(WS_A, created.id).await.unwrap().unwrap();
    assert_eq!(found.source, created.source);
}

#[tokio::test]
async fn an_uploaded_modernization_keeps_only_the_file_id() {
    let repo = setup().await;
    let file_id = Uuid::from_u128(0xf11e);
    let new = new_project(WS_A, "Imported zip", ProjectSource::Upload { file_id });
    let created = repo.insert(&new).await.unwrap();
    assert_eq!(created.source, ProjectSource::Upload { file_id });
}

#[tokio::test]
async fn a_name_is_unique_inside_a_workspace_but_not_across_them() {
    let repo = setup().await;
    repo.insert(&new_project(WS_A, "Payments v2", ProjectSource::Idea { brief: None }))
        .await
        .unwrap();

    let clash = repo
        .insert(&new_project(WS_A, "Payments v2", ProjectSource::Idea { brief: None }))
        .await;
    assert!(
        matches!(clash, Err(RepoError::DuplicateName)),
        "a second project of the same name in one workspace must be rejected, got {clash:?}"
    );

    // Another workspace may well have its own "Payments v2".
    repo.insert(&new_project(WS_B, "Payments v2", ProjectSource::Idea { brief: None }))
        .await
        .expect("same name in a different workspace is fine");
}

#[tokio::test]
async fn one_workspace_cannot_read_anothers_project() {
    let repo = setup().await;
    let created = repo
        .insert(&new_project(WS_A, "Secret plan", ProjectSource::Idea { brief: None }))
        .await
        .unwrap();

    assert!(repo.find(WS_A, created.id).await.unwrap().is_some());
    assert!(
        repo.find(WS_B, created.id).await.unwrap().is_none(),
        "the tenant clamp must hide it even with the right id"
    );
    assert!(repo.list(WS_B).await.unwrap().is_empty());
}

#[tokio::test]
async fn list_returns_the_workspace_projects() {
    let repo = setup().await;
    let a = repo
        .insert(&new_project(WS_A, "One", ProjectSource::Idea { brief: None }))
        .await
        .unwrap();
    let b = repo
        .insert(&new_project(WS_A, "Two", ProjectSource::Idea { brief: None }))
        .await
        .unwrap();
    repo.insert(&new_project(WS_B, "Elsewhere", ProjectSource::Idea { brief: None }))
        .await
        .unwrap();

    let mut ids: Vec<Uuid> = repo.list(WS_A).await.unwrap().into_iter().map(|p| p.id).collect();
    ids.sort_unstable();
    let mut want = vec![a.id, b.id];
    want.sort_unstable();
    assert_eq!(ids, want);
}

#[tokio::test]
async fn update_changes_only_what_it_is_given() {
    let repo = setup().await;
    let created = repo
        .insert(&new_project(WS_A, "Before", ProjectSource::Idea { brief: Some("keep me".into()) }))
        .await
        .unwrap();

    let renamed = repo
        .update(WS_A, created.id, Some("After"), None, None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(renamed.name, "After");
    assert_eq!(renamed.stages, created.stages, "stages untouched");
    assert_eq!(renamed.source, created.source, "brief untouched");
    assert_eq!(renamed.status, Status::Draft);

    let restaged = repo
        .update(WS_A, created.id, None, Some(&["intent".to_owned(), "testing".to_owned()]), None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(restaged.stages, vec!["intent".to_owned(), "testing".to_owned()]);
    assert_eq!(restaged.name, "After", "name untouched");

    let activated = repo
        .update(WS_A, created.id, None, None, Some(Status::Active))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(activated.status, Status::Active);
}

#[tokio::test]
async fn an_empty_update_is_a_read() {
    let repo = setup().await;
    let created = repo
        .insert(&new_project(WS_A, "Untouched", ProjectSource::Idea { brief: None }))
        .await
        .unwrap();
    let same = repo.update(WS_A, created.id, None, None, None).await.unwrap().unwrap();
    assert_eq!(same, created);
}

#[tokio::test]
async fn updating_a_missing_project_reports_it_rather_than_inventing_one() {
    let repo = setup().await;
    assert!(
        repo.update(WS_A, Uuid::new_v4(), Some("ghost"), None, None)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn a_rename_onto_an_existing_name_is_a_conflict() {
    let repo = setup().await;
    repo.insert(&new_project(WS_A, "Taken", ProjectSource::Idea { brief: None }))
        .await
        .unwrap();
    let other = repo
        .insert(&new_project(WS_A, "Free", ProjectSource::Idea { brief: None }))
        .await
        .unwrap();

    let clash = repo.update(WS_A, other.id, Some("Taken"), None, None).await;
    assert!(matches!(clash, Err(RepoError::DuplicateName)), "got {clash:?}");
}

#[tokio::test]
async fn the_members_group_is_recorded_after_the_fact() {
    let repo = setup().await;
    let created = repo
        .insert(&new_project(WS_A, "With members", ProjectSource::Idea { brief: None }))
        .await
        .unwrap();
    let group = Uuid::from_u128(0x9909);

    repo.set_rg_group(WS_A, created.id, group).await.unwrap();
    let found = repo.find(WS_A, created.id).await.unwrap().unwrap();
    assert_eq!(found.rg_group_id, Some(group));
}

#[tokio::test]
async fn delete_removes_once_and_reports_the_second_attempt() {
    let repo = setup().await;
    let created = repo
        .insert(&new_project(WS_A, "Doomed", ProjectSource::Idea { brief: None }))
        .await
        .unwrap();

    assert!(repo.delete(WS_A, created.id).await.unwrap());
    assert!(repo.find(WS_A, created.id).await.unwrap().is_none());
    assert!(!repo.delete(WS_A, created.id).await.unwrap());
}

#[tokio::test]
async fn one_workspace_cannot_delete_anothers_project() {
    let repo = setup().await;
    let created = repo
        .insert(&new_project(WS_A, "Mine", ProjectSource::Idea { brief: None }))
        .await
        .unwrap();
    assert!(!repo.delete(WS_B, created.id).await.unwrap());
    assert!(repo.find(WS_A, created.id).await.unwrap().is_some());
}

#[tokio::test]
async fn the_database_refuses_a_modernization_with_nothing_to_modernize() {
    // The CHECK constraint is the last line of defence. This bypasses the domain
    // entirely — it builds the row by hand and inserts it through the same secure
    // path the repository uses — so what is under test is the schema, not our
    // validation.
    use sea_orm::{ActiveValue, EntityTrait};
    use time::OffsetDateTime;
    use toolkit_db::secure::SecureInsertExt;
    use toolkit_security::AccessScope;

    use crate::project::entity;

    let dsn = format!("sqlite:file:shape_{}?mode=memory&cache=shared", Uuid::new_v4());
    let db = connect_db(
        &dsn,
        ConnectOpts { max_conns: Some(1), min_conns: Some(1), ..Default::default() },
    )
    .await
    .unwrap();
    run_migrations_for_testing(&db, Migrator::migrations()).await.unwrap();
    let provider = DBProvider::<RepoError>::new(db);
    let conn = provider.conn().unwrap();

    let now = OffsetDateTime::now_utc();
    let am = entity::ActiveModel {
        id: ActiveValue::Set(Uuid::new_v4()),
        tenant_id: ActiveValue::Set(WS_A),
        name: ActiveValue::Set("modernize nothing".to_owned()),
        // mode 2 = modernize, but every source column is empty.
        mode: ActiveValue::Set(2),
        status: ActiveValue::Set(1),
        stages: ActiveValue::Set("[\"intent\"]".to_owned()),
        brief: ActiveValue::Set(None),
        source_kind: ActiveValue::Set(None),
        source_git_url: ActiveValue::Set(None),
        source_file_id: ActiveValue::Set(None),
        rg_group_id: ActiveValue::Set(None),
        created_by: ActiveValue::Set(ACTOR),
        created_at: ActiveValue::Set(now),
        updated_at: ActiveValue::Set(now),
    };

    let res = entity::Entity::insert(am)
        .secure()
        .scope_unchecked(&AccessScope::for_tenant(WS_A))
        .unwrap()
        .exec(&conn)
        .await;
    assert!(
        res.is_err(),
        "mode=2 with no source must violate the CHECK constraint, but the row was accepted"
    );
}
