//! An organization's logo: the picture the portal shows beside its name, in
//! the path bar, the organization switcher and on its overview, so one
//! organization is told from another at a glance.
//!
//! Kept as one account-management metadata row on the organization. Read as
//! the caller, so a person sees the logos of the organizations they reach.
//! Written only by this gear, as the service, after asking studio-user whether
//! the caller administers the organization: the PDP refuses anybody else's
//! write of the row (`studio_authz_plugin::GEAR_HELD_METADATA`), which keeps
//! that check the only way to change it.

use std::sync::Arc;

use account_management_sdk::{AccountManagementClient, UpsertMetadataRequest};
use anyhow::anyhow;
use base64::Engine;
use gts::GtsTypeId;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use toolkit_canonical_errors::CanonicalError;
use toolkit_security::SecurityContext;
use uuid::Uuid;

/// The metadata type the logo is kept under, on the organization's tenant.
pub const LOGO_METADATA_TYPE: &str =
    "gts.cf.core.am.tenant_metadata.v1~cf.studio.organization.logo.v1~";

/// Who may change it: whoever administers the organization's access.
pub const LOGO_PRIVILEGE: &str = "access.manage";

/// A logo is a small mark, not a banner: kept inline in a metadata row.
pub const MAX_LOGO_BYTES: usize = 256 * 1024;

/// The subject this gear writes as. Fixed, so an audit of account-management
/// says which gear changed the row.
pub const SERVICE_SUBJECT_ID: Uuid = Uuid::from_u128(0x0a90_1090_7c3e_4d1f_b6a2_5e8c_91d4_17f3);

/// The stored logo.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Logo {
    /// `image/png`, `image/jpeg`, `image/webp` or `image/gif`, as the bytes are.
    pub content_type: String,
    /// The image, base64.
    pub data: String,
    /// SHA-256 of the bytes, hex: changes with every new logo.
    pub digest: String,
}

/// Check a logo before it is kept: an image of a known kind, the kind it
/// says it is, and small.
pub fn checked(declared: &str, data: &str) -> Result<Logo, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|_| "the logo is not valid base64".to_string())?;
    if bytes.len() > MAX_LOGO_BYTES {
        return Err(format!(
            "the logo is {} KiB; at most {} KiB is kept",
            bytes.len().div_ceil(1024),
            MAX_LOGO_BYTES / 1024
        ));
    }
    let content_type = crate::user_profile::check_avatar(declared, &bytes)?;
    Ok(Logo {
        content_type: content_type.to_string(),
        data: base64::engine::general_purpose::STANDARD.encode(&bytes),
        digest: hex::encode(Sha256::digest(&bytes)),
    })
}

fn service_context(tenant: Uuid) -> anyhow::Result<SecurityContext> {
    SecurityContext::builder()
        .subject_id(SERVICE_SUBJECT_ID)
        .subject_type("service")
        .subject_tenant_id(tenant)
        .token_scopes(vec!["*".to_owned()])
        .build()
        .map_err(|e| anyhow!("studio-organizations: cannot build a service context: {e}"))
}

/// The organization's logo, read as the caller; `None` when it has none.
pub async fn read(
    am: &Arc<dyn AccountManagementClient>,
    ctx: &SecurityContext,
    org: Uuid,
) -> anyhow::Result<Option<(Logo, i64)>> {
    match am
        .get_metadata(ctx, org, GtsTypeId::new(LOGO_METADATA_TYPE))
        .await
    {
        Ok(entry) => {
            let logo: Logo = serde_json::from_value(entry.value)
                .map_err(|e| anyhow!("the stored logo is unreadable: {e}"))?;
            // An emptied row (the logo was removed) reads as none.
            Ok((!logo.data.is_empty()).then_some((logo, entry.version)))
        }
        Err(CanonicalError::NotFound { .. }) => Ok(None),
        Err(e) => Err(anyhow!("cannot read the logo: {e}")),
    }
}

/// Keep `logo` as the organization's, or remove it with `None`. Written as
/// the service; the caller's right to it is checked before.
pub async fn write(
    am: &Arc<dyn AccountManagementClient>,
    org: Uuid,
    logo: Option<&Logo>,
) -> anyhow::Result<()> {
    let ctx = service_context(org)?;
    let value = serde_json::to_value(logo.cloned().unwrap_or_default())?;
    let version = read(am, &ctx, org).await?.map(|(_, v)| v);
    // Removing a logo that is not there is done already.
    if logo.is_none() && version.is_none() {
        return Ok(());
    }
    let mut request = UpsertMetadataRequest::new(GtsTypeId::new(LOGO_METADATA_TYPE), value);
    if let Some(version) = version {
        request = request.with_expected_version(version);
    }
    am.upsert_metadata(&ctx, org, request)
        .await
        .map(|_| ())
        .map_err(|e| anyhow!("cannot keep the logo: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    #[test]
    fn a_logo_is_kept_as_the_image_it_is_with_its_digest() {
        let data = base64::engine::general_purpose::STANDARD.encode(PNG);
        let logo = checked("image/png", &data).unwrap();
        assert_eq!(logo.content_type, "image/png");
        assert_eq!(logo.digest, hex::encode(Sha256::digest(PNG)));
        assert_eq!(logo.data, data);
    }

    #[test]
    fn a_logo_that_is_not_an_image_of_its_kind_or_too_big_is_refused() {
        let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
        assert!(checked("image/png", "not base64 !").is_err());
        assert!(checked("image/png", &b64(b"<svg/>")).is_err());
        assert!(checked("image/jpeg", &b64(PNG)).is_err());
        let mut big = PNG.to_vec();
        big.resize(MAX_LOGO_BYTES + 1, 0);
        assert!(
            checked("image/png", &b64(&big))
                .unwrap_err()
                .contains("KiB")
        );
    }
}
