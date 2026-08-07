//! The value store itself — a pure per-tenant key/value backend behind
//! [`CredStorePluginClientV1`], with values encrypted at rest.
//!
//! Deliberately as dumb as the static plugin it replaces: sharing, hierarchy,
//! authorization, lifecycle and the value fence all live in the credstore gear
//! (`gears/credstore`), which has already resolved tenant and owner by the
//! time a call lands here. The only thing this layer adds over an in-memory
//! `HashMap` is that the map is a table and the values are ciphertext.

use std::sync::Arc;

use async_trait::async_trait;
use credstore_sdk::{
    CredStoreError, CredStorePluginClientV1, OwnerId, SecretRef, SecretValue, TenantId,
};
use sea_orm::{ActiveValue, ColumnTrait, Condition, EntityTrait, QueryFilter};
use time::OffsetDateTime;
use toolkit_db::DBProvider;
use toolkit_db::secure::{
    SecureDeleteExt, SecureEntityExt, SecureInsertExt, SecureOnConflict,
};
use toolkit_security::{AccessScope, SecurityContext};
use tracing::{debug, warn};
use uuid::Uuid;

use super::crypto::ValueCipher;
use super::entity;

/// Namespace for the deterministic v5 row ids. A fixed random constant: it
/// only has to be stable across releases, never secret.
const ROW_ID_NAMESPACE: Uuid = Uuid::from_u128(0x7f3c_1d84_9b2e_4a55_8c17_6e0b_2f9d_41aa);

/// Persistent, encrypted credstore value store.
pub struct PgValueStore {
    db: Arc<DBProvider<anyhow::Error>>,
    cipher: ValueCipher,
}

impl PgValueStore {
    #[must_use]
    pub fn new(db: Arc<DBProvider<anyhow::Error>>, cipher: ValueCipher) -> Self {
        Self { db, cipher }
    }
}

/// The primary key of a key class. Deterministic, so `put` is an idempotent
/// upsert on the PK and `get`/`delete` need no secondary index.
fn row_id(tenant_id: &TenantId, key: &SecretRef, owner: Uuid) -> Uuid {
    Uuid::new_v5(
        &ROW_ID_NAMESPACE,
        class_key(tenant_id, key, owner).as_bytes(),
    )
}

/// Canonical rendering of a key class — used both for the row id and, as
/// AEAD associated data, to bind each ciphertext to the class it belongs to.
fn class_key(tenant_id: &TenantId, key: &SecretRef, owner: Uuid) -> String {
    format!("{}|{}|{}", tenant_id.0, key.as_ref(), owner)
}

/// `owner_id = None` (the tenant key class) is stored as the nil UUID, so the
/// primary key never has to reason about `NULL`.
fn owner_uuid(owner_id: Option<&OwnerId>) -> Uuid {
    owner_id.map_or_else(Uuid::nil, |o| o.0)
}

/// Storage faults are transient from the caller's point of view: credstore
/// surfaces `ServiceUnavailable` as a retryable 503 rather than turning a
/// database blip into a missing secret.
fn unavailable(op: &str, err: &dyn core::fmt::Display) -> CredStoreError {
    warn!(op, "studio-credstore-pg: storage error: {err}");
    CredStoreError::service_unavailable(format!("studio-credstore-pg: {op} failed"))
}

#[async_trait]
impl CredStorePluginClientV1 for PgValueStore {
    async fn get(
        &self,
        _ctx: &SecurityContext,
        tenant_id: &TenantId,
        key: &SecretRef,
        owner_id: Option<&OwnerId>,
    ) -> Result<Option<SecretValue>, CredStoreError> {
        let owner = owner_uuid(owner_id);
        let id = row_id(tenant_id, key, owner);
        let conn = self
            .db
            .conn()
            .map_err(|e| unavailable("get (connect)", &e))?;

        let row = entity::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant_id.0))
            .filter(Condition::all().add(entity::Column::Id.eq(id)))
            .one(&conn)
            .await
            .map_err(|e| unavailable("get", &e))?;

        let Some(row) = row else {
            debug!(reference = key.as_ref(), "studio-credstore-pg: no stored value");
            return Ok(None);
        };

        match self.cipher.open(
            class_key(tenant_id, key, owner).as_bytes(),
            &row.nonce,
            &row.ciphertext,
        ) {
            Some(plaintext) => Ok(Some(SecretValue::new(plaintext))),
            None => {
                // Almost always a rotated/replaced STUDIO_CREDSTORE_KEY. Fail
                // closed like the value fence does: the reference reads as
                // missing, and the next write (studio-secrets-bootstrap at
                // boot, or the user re-entering a token) re-seals it under the
                // current key. Returning an error instead would leave
                // consumers spinning on something no retry can fix.
                warn!(
                    reference = key.as_ref(),
                    tenant_id = %tenant_id,
                    "studio-credstore-pg: stored value did not decrypt — treating as absent. \
                     Did STUDIO_CREDSTORE_KEY change? The value must be written again."
                );
                Ok(None)
            }
        }
    }

    async fn put(
        &self,
        _ctx: &SecurityContext,
        tenant_id: &TenantId,
        key: &SecretRef,
        value: SecretValue,
        owner_id: Option<&OwnerId>,
    ) -> Result<(), CredStoreError> {
        let owner = owner_uuid(owner_id);
        let id = row_id(tenant_id, key, owner);
        let (nonce, ciphertext) = self
            .cipher
            .seal(
                class_key(tenant_id, key, owner).as_bytes(),
                value.as_bytes(),
            )
            .map_err(|e| {
                warn!("studio-credstore-pg: encryption failed: {e}");
                CredStoreError::internal("studio-credstore-pg: encryption failed")
            })?;

        let conn = self
            .db
            .conn()
            .map_err(|e| unavailable("put (connect)", &e))?;
        let now = OffsetDateTime::now_utc();
        let am = entity::ActiveModel {
            id: ActiveValue::Set(id),
            tenant_id: ActiveValue::Set(tenant_id.0),
            reference: ActiveValue::Set(key.as_ref().to_owned()),
            owner_id: ActiveValue::Set(owner),
            nonce: ActiveValue::Set(nonce),
            ciphertext: ActiveValue::Set(ciphertext),
            created_at: ActiveValue::Set(now),
            updated_at: ActiveValue::Set(now),
        };

        // Overwrite in place: credstore's write saga owns generations and
        // preconditions, so a plugin-level put is a last-writer-wins upsert.
        // `created_at` is deliberately absent from the update list — it records
        // when the class first got a value, which is useful when reading the
        // table by hand during an incident.
        let on_conflict = SecureOnConflict::<entity::Entity>::columns([entity::Column::Id])
            .update_columns([
                entity::Column::Nonce,
                entity::Column::Ciphertext,
                entity::Column::UpdatedAt,
            ])
            .map_err(|e| unavailable("put (on_conflict)", &e))?;

        entity::Entity::insert(am)
            .secure()
            // scope_unchecked: the row does not exist yet, so there is nothing
            // to clamp against; `tenant_id` is set from the argument the gear
            // already authorized. Same call shape as credstore's own insert.
            .scope_unchecked(&AccessScope::for_tenant(tenant_id.0))
            .map_err(|e| unavailable("put (scope)", &e))?
            .on_conflict(on_conflict)
            .exec(&conn)
            .await
            .map_err(|e| unavailable("put", &e))?;

        debug!(reference = key.as_ref(), tenant_id = %tenant_id, "studio-credstore-pg: value stored");
        Ok(())
    }

    async fn delete(
        &self,
        _ctx: &SecurityContext,
        tenant_id: &TenantId,
        key: &SecretRef,
        owner_id: Option<&OwnerId>,
    ) -> Result<(), CredStoreError> {
        let owner = owner_uuid(owner_id);
        let id = row_id(tenant_id, key, owner);
        let conn = self
            .db
            .conn()
            .map_err(|e| unavailable("delete (connect)", &e))?;

        // A miss is success: the gear treats a missing backend value as
        // already-deleted, and its deprovisioning saga retries.
        entity::Entity::delete_many()
            .filter(Condition::all().add(entity::Column::Id.eq(id)))
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant_id.0))
            .exec(&conn)
            .await
            .map_err(|e| unavailable("delete", &e))?;

        debug!(reference = key.as_ref(), tenant_id = %tenant_id, "studio-credstore-pg: value deleted");
        Ok(())
    }
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod store_tests;

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::{class_key, owner_uuid, row_id};
    use credstore_sdk::{OwnerId, SecretRef, TenantId};
    use uuid::Uuid;

    fn tenant() -> TenantId {
        TenantId(Uuid::from_u128(1))
    }

    #[test]
    fn row_id_is_stable_for_the_same_key_class() {
        let key = SecretRef::new("studio-repo-42").unwrap();
        assert_eq!(
            row_id(&tenant(), &key, Uuid::nil()),
            row_id(&tenant(), &key, Uuid::nil()),
            "put must be able to upsert onto the row a previous put created"
        );
    }

    #[test]
    fn row_id_separates_every_dimension_of_the_key_class() {
        let key = SecretRef::new("studio-repo-42").unwrap();
        let other_key = SecretRef::new("studio-repo-43").unwrap();
        let other_tenant = TenantId(Uuid::from_u128(2));
        let owner = Uuid::from_u128(9);

        let base = row_id(&tenant(), &key, Uuid::nil());
        assert_ne!(base, row_id(&other_tenant, &key, Uuid::nil()));
        assert_ne!(base, row_id(&tenant(), &other_key, Uuid::nil()));
        // The private key class must never collide with the tenant class.
        assert_ne!(base, row_id(&tenant(), &key, owner));
    }

    #[test]
    fn class_key_is_unambiguous_across_field_boundaries() {
        // Without a separator, ("a", "bc") and ("ab", "c") would collide; the
        // reference alphabet excludes '|', so the delimiter cannot be forged.
        let a = SecretRef::new("a-b").unwrap();
        let b = SecretRef::new("a").unwrap();
        assert_ne!(
            class_key(&tenant(), &a, Uuid::nil()),
            class_key(&tenant(), &b, Uuid::nil())
        );
    }

    #[test]
    fn tenant_key_class_stores_the_nil_owner() {
        assert!(owner_uuid(None).is_nil());
        let owner = OwnerId(Uuid::from_u128(5));
        assert_eq!(owner_uuid(Some(&owner)), owner.0);
    }
}
