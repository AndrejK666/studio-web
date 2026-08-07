//! SQLite-backed integration tests for [`PgValueStore`].
//!
//! These exercise the real migration, entity mapping, scope clamp and upsert
//! against a fresh in-memory database — the parts of this gear that no
//! pure-function test can reach and that a compile cannot vouch for. Postgres
//! is the production target, but the code paths under test (SeaORM entity,
//! `ON CONFLICT`, scope condition) are backend-agnostic, and running on SQLite
//! keeps the suite dependency-free.
#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use credstore_sdk::{
    CredStorePluginClientV1, OwnerId, SecretRef, SecretValue, TenantId,
};
use toolkit_db::migration_runner::run_migrations_for_testing;
use toolkit_db::sea_orm_migration::MigratorTrait;
use toolkit_db::{ConnectOpts, DBProvider, connect_db};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use crate::credstore_pg::crypto::{KEY_LEN, ValueCipher};
use crate::credstore_pg::migrations::Migrator;
use crate::credstore_pg::store::PgValueStore;

const TENANT_A: Uuid = Uuid::from_u128(0xa1);
const TENANT_B: Uuid = Uuid::from_u128(0xb2);

fn key_of(byte: u8) -> String {
    STANDARD.encode([byte; KEY_LEN])
}

/// A store on a fresh in-memory database, plus the DSN so a second store can
/// be attached to the SAME database under a different key.
async fn setup_with_key(key_byte: u8) -> (PgValueStore, String) {
    let dsn = format!(
        "sqlite:file:credstore_pg_{}?mode=memory&cache=shared",
        Uuid::new_v4()
    );
    let store = attach(&dsn, key_byte, true).await;
    (store, dsn)
}

async fn attach(dsn: &str, key_byte: u8, migrate: bool) -> PgValueStore {
    let db = connect_db(
        dsn,
        ConnectOpts {
            max_conns: Some(1),
            min_conns: Some(1),
            ..Default::default()
        },
    )
    .await
    .expect("connect sqlite");

    if migrate {
        run_migrations_for_testing(&db, Migrator::migrations())
            .await
            .expect("run migrations");
    }

    PgValueStore::new(
        Arc::new(DBProvider::<anyhow::Error>::new(db)),
        ValueCipher::from_encoded(&key_of(key_byte)).expect("valid key"),
    )
}

fn ctx() -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(0xc3))
        .subject_type("service")
        .subject_tenant_id(TENANT_A)
        .build()
        .expect("security context")
}

fn sref(s: &str) -> SecretRef {
    SecretRef::new(s).expect("valid secret ref")
}

async fn get_str(
    store: &PgValueStore,
    tenant: Uuid,
    key: &str,
    owner: Option<&OwnerId>,
) -> Option<String> {
    store
        .get(&ctx(), &TenantId(tenant), &sref(key), owner)
        .await
        .expect("get")
        .map(|v| String::from_utf8(v.as_bytes().to_vec()).expect("utf8"))
}

async fn put_str(
    store: &PgValueStore,
    tenant: Uuid,
    key: &str,
    value: &str,
    owner: Option<&OwnerId>,
) {
    store
        .put(
            &ctx(),
            &TenantId(tenant),
            &sref(key),
            SecretValue::new(value.as_bytes().to_vec()),
            owner,
        )
        .await
        .expect("put");
}

#[tokio::test]
async fn a_stored_value_reads_back() {
    let (store, _dsn) = setup_with_key(1).await;
    put_str(&store, TENANT_A, "studio-repo-7", "glpat-abc", None).await;
    assert_eq!(
        get_str(&store, TENANT_A, "studio-repo-7", None).await.as_deref(),
        Some("glpat-abc")
    );
}

#[tokio::test]
async fn a_missing_value_is_none_not_an_error() {
    let (store, _dsn) = setup_with_key(1).await;
    assert!(get_str(&store, TENANT_A, "never-written", None).await.is_none());
}

#[tokio::test]
async fn put_overwrites_in_place_instead_of_colliding() {
    // The whole point of the deterministic row id: the second write must be an
    // upsert onto the same row, not a primary-key violation.
    let (store, _dsn) = setup_with_key(1).await;
    put_str(&store, TENANT_A, "anthropic-key", "sk-ant-old", None).await;
    put_str(&store, TENANT_A, "anthropic-key", "sk-ant-new", None).await;
    assert_eq!(
        get_str(&store, TENANT_A, "anthropic-key", None).await.as_deref(),
        Some("sk-ant-new")
    );
}

#[tokio::test]
async fn delete_removes_the_value_and_a_second_delete_is_still_ok() {
    let (store, _dsn) = setup_with_key(1).await;
    put_str(&store, TENANT_A, "studio-connection-1", "token", None).await;
    let key = sref("studio-connection-1");

    store.delete(&ctx(), &TenantId(TENANT_A), &key, None).await.expect("delete");
    assert!(get_str(&store, TENANT_A, "studio-connection-1", None).await.is_none());

    // The gear treats a missing backend value as already-deleted, and its
    // deprovisioning saga retries — a second delete must not fail.
    store.delete(&ctx(), &TenantId(TENANT_A), &key, None).await.expect("idempotent delete");
}

#[tokio::test]
async fn one_tenant_cannot_read_anothers_value() {
    let (store, _dsn) = setup_with_key(1).await;
    put_str(&store, TENANT_A, "shared-name", "tenant-a-secret", None).await;
    put_str(&store, TENANT_B, "shared-name", "tenant-b-secret", None).await;

    assert_eq!(
        get_str(&store, TENANT_A, "shared-name", None).await.as_deref(),
        Some("tenant-a-secret")
    );
    assert_eq!(
        get_str(&store, TENANT_B, "shared-name", None).await.as_deref(),
        Some("tenant-b-secret")
    );
}

#[tokio::test]
async fn the_private_and_tenant_key_classes_are_separate() {
    let (store, _dsn) = setup_with_key(1).await;
    let owner = OwnerId(Uuid::from_u128(0xd4));

    put_str(&store, TENANT_A, "pat", "owned-by-user", Some(&owner)).await;
    assert_eq!(
        get_str(&store, TENANT_A, "pat", Some(&owner)).await.as_deref(),
        Some("owned-by-user")
    );
    // owner_id = None selects the tenant class, which nobody has written.
    assert!(get_str(&store, TENANT_A, "pat", None).await.is_none());

    // And a different owner does not see it either.
    let other = OwnerId(Uuid::from_u128(0xe5));
    assert!(get_str(&store, TENANT_A, "pat", Some(&other)).await.is_none());
}

#[tokio::test]
async fn deleting_the_private_class_leaves_the_tenant_class_alone() {
    let (store, _dsn) = setup_with_key(1).await;
    let owner = OwnerId(Uuid::from_u128(0xd4));
    put_str(&store, TENANT_A, "pat", "private", Some(&owner)).await;
    put_str(&store, TENANT_A, "pat", "tenant-wide", None).await;

    store
        .delete(&ctx(), &TenantId(TENANT_A), &sref("pat"), Some(&owner))
        .await
        .expect("delete private");

    assert!(get_str(&store, TENANT_A, "pat", Some(&owner)).await.is_none());
    assert_eq!(
        get_str(&store, TENANT_A, "pat", None).await.as_deref(),
        Some("tenant-wide")
    );
}

#[tokio::test]
async fn a_changed_key_makes_old_rows_read_as_absent_and_a_rewrite_heals_them() {
    // The STUDIO_CREDSTORE_KEY rotation story: values written under the old key
    // must fail closed (Ok(None), not an error the caller can only spin on),
    // and the next write must make the reference usable again.
    let (store, dsn) = setup_with_key(1).await;
    put_str(&store, TENANT_A, "openai-key", "sk-under-old-key", None).await;

    let rotated = attach(&dsn, 2, false).await;
    assert!(
        get_str(&rotated, TENANT_A, "openai-key", None).await.is_none(),
        "a value sealed under a different key must not decrypt"
    );

    // This is what studio-secrets-bootstrap does on the next boot.
    put_str(&rotated, TENANT_A, "openai-key", "sk-under-new-key", None).await;
    assert_eq!(
        get_str(&rotated, TENANT_A, "openai-key", None).await.as_deref(),
        Some("sk-under-new-key")
    );
}

#[tokio::test]
async fn the_fence_key_reference_round_trips_under_the_nil_tenant() {
    // credstore stores its value-fingerprint fence key in the value store
    // itself, under the nil tenant and no metadata row. Persisting THAT is
    // what stops the fence from being regenerated on every boot, so the nil
    // tenant must not be a special case anywhere in this gear.
    let (store, _dsn) = setup_with_key(1).await;
    put_str(&store, Uuid::nil(), "cfs-internal-fence-key", "32-bytes-of-key", None).await;
    assert_eq!(
        get_str(&store, Uuid::nil(), "cfs-internal-fence-key", None).await.as_deref(),
        Some("32-bytes-of-key")
    );
}

#[tokio::test]
async fn values_are_not_stored_in_plaintext() {
    // A read of the raw column must not reveal the secret: the point of the
    // gear is that a database dump is not a secret dump.
    use sea_orm::EntityTrait;
    use toolkit_db::secure::SecureEntityExt;
    use toolkit_security::AccessScope;

    let (store, dsn) = setup_with_key(1).await;
    put_str(&store, TENANT_A, "openai-key", "sk-super-secret", None).await;

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
    let provider = DBProvider::<anyhow::Error>::new(db);
    let conn = provider.conn().expect("conn");
    let rows = crate::credstore_pg::entity::Entity::find()
        .secure()
        .scope_with(&AccessScope::allow_all())
        .all(&conn)
        .await
        .expect("select");

    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_eq!(row.reference, "openai-key");
    assert_eq!(row.nonce.len(), 12, "96-bit GCM nonce");
    assert!(
        !row.ciphertext
            .windows(b"sk-super-secret".len())
            .any(|w| w == b"sk-super-secret"),
        "plaintext must not appear in the stored ciphertext"
    );
    // 15 bytes of plaintext + the 16-byte GCM tag.
    assert_eq!(row.ciphertext.len(), b"sk-super-secret".len() + 16);
}
