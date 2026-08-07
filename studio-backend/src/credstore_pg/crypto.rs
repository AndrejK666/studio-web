//! Envelope encryption for stored secret values.
//!
//! AES-256-GCM with a random 96-bit nonce per write, backed by AWS-LC
//! (`aws-lc-rs`) — the same crypto library the rest of the platform uses for
//! TLS and for credstore's own value fence, so a `--features fips` build runs
//! this through the validated module too.
//!
//! The associated data binds every ciphertext to the exact key class it was
//! written for (`tenant | reference | owner`). A row copied to another
//! tenant, renamed, or moved between the tenant and private key classes
//! therefore fails to open rather than decrypting into the wrong caller's
//! hands — the same fail-closed posture as credstore's fingerprint fence, one
//! layer down.

use aws_lc_rs::aead::{AES_256_GCM, Aad, LessSafeKey, NONCE_LEN, Nonce, UnboundKey};
use base64::Engine;

/// AES-256 key length in bytes.
pub const KEY_LEN: usize = 32;

/// AES-256-GCM cipher over a single deployment key.
pub struct ValueCipher {
    key: LessSafeKey,
}

impl ValueCipher {
    /// Build a cipher from a base64-encoded 32-byte key.
    ///
    /// Accepts standard and URL-safe base64, padded or not, so a key produced
    /// by `openssl rand -base64 32`, `head -c32 /dev/urandom | base64` or a
    /// secrets manager all work without the operator having to know which.
    ///
    /// # Errors
    ///
    /// Returns an error if the input is not base64 or does not decode to
    /// exactly [`KEY_LEN`] bytes.
    pub fn from_encoded(raw: &str) -> anyhow::Result<Self> {
        let bytes = decode_key(raw.trim())?;
        if bytes.len() != KEY_LEN {
            anyhow::bail!(
                "expected a {KEY_LEN}-byte key, got {} bytes after base64 decoding",
                bytes.len()
            );
        }
        let unbound = UnboundKey::new(&AES_256_GCM, &bytes)
            .map_err(|_| anyhow::anyhow!("AES-256-GCM rejected the key material"))?;
        Ok(Self {
            key: LessSafeKey::new(unbound),
        })
    }

    /// Encrypt `plaintext`, returning `(nonce, ciphertext_with_tag)`.
    ///
    /// # Errors
    ///
    /// Returns an error if the system RNG fails or the AEAD seal fails.
    pub fn seal(&self, aad: &[u8], plaintext: &[u8]) -> anyhow::Result<(Vec<u8>, Vec<u8>)> {
        let mut nonce_bytes = [0u8; NONCE_LEN];
        aws_lc_rs::rand::fill(&mut nonce_bytes)
            .map_err(|_| anyhow::anyhow!("system RNG failed to generate a nonce"))?;
        let mut buf = plaintext.to_vec();
        self.key
            .seal_in_place_append_tag(
                Nonce::assume_unique_for_key(nonce_bytes),
                Aad::from(aad),
                &mut buf,
            )
            .map_err(|_| anyhow::anyhow!("AES-256-GCM seal failed"))?;
        Ok((nonce_bytes.to_vec(), buf))
    }

    /// Decrypt a stored `(nonce, ciphertext)` pair.
    ///
    /// Returns `None` on any failure — wrong key, tampered ciphertext, or
    /// associated data that does not match the row's key class. The caller
    /// treats that as "no value", which is what makes a rotated key
    /// self-healing rather than fatal.
    #[must_use]
    pub fn open(&self, aad: &[u8], nonce: &[u8], ciphertext: &[u8]) -> Option<Vec<u8>> {
        let nonce: [u8; NONCE_LEN] = nonce.try_into().ok()?;
        let mut buf = ciphertext.to_vec();
        let plaintext = self
            .key
            .open_in_place(
                Nonce::assume_unique_for_key(nonce),
                Aad::from(aad),
                &mut buf,
            )
            .ok()?;
        Some(plaintext.to_vec())
    }
}

fn decode_key(raw: &str) -> anyhow::Result<Vec<u8>> {
    use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};

    STANDARD
        .decode(raw)
        .or_else(|_| STANDARD_NO_PAD.decode(raw))
        .or_else(|_| URL_SAFE.decode(raw))
        .or_else(|_| URL_SAFE_NO_PAD.decode(raw))
        .map_err(|_| anyhow::anyhow!("value is not valid base64"))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::{KEY_LEN, ValueCipher};
    use base64::Engine;
    use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};

    fn key_b64() -> String {
        STANDARD.encode([7u8; KEY_LEN])
    }

    #[test]
    fn round_trips_a_value() {
        let cipher = ValueCipher::from_encoded(&key_b64()).unwrap();
        let (nonce, ct) = cipher.seal(b"aad", b"glpat-secret").unwrap();
        assert_eq!(
            cipher.open(b"aad", &nonce, &ct).as_deref(),
            Some(&b"glpat-secret"[..])
        );
    }

    #[test]
    fn ciphertext_is_bound_to_its_associated_data() {
        let cipher = ValueCipher::from_encoded(&key_b64()).unwrap();
        let (nonce, ct) = cipher.seal(b"tenant-a|pat|owner", b"secret").unwrap();
        // Same key, same row bytes, different key class -> no plaintext.
        assert!(cipher.open(b"tenant-b|pat|owner", &nonce, &ct).is_none());
    }

    #[test]
    fn a_different_key_does_not_open_the_row() {
        let a = ValueCipher::from_encoded(&key_b64()).unwrap();
        let b = ValueCipher::from_encoded(&STANDARD.encode([9u8; KEY_LEN])).unwrap();
        let (nonce, ct) = a.seal(b"aad", b"secret").unwrap();
        assert!(b.open(b"aad", &nonce, &ct).is_none());
    }

    #[test]
    fn tampered_ciphertext_is_rejected() {
        let cipher = ValueCipher::from_encoded(&key_b64()).unwrap();
        let (nonce, mut ct) = cipher.seal(b"aad", b"secret").unwrap();
        ct[0] ^= 0xff;
        assert!(cipher.open(b"aad", &nonce, &ct).is_none());
    }

    #[test]
    fn accepts_every_base64_flavour_an_operator_might_paste() {
        let raw = [3u8; KEY_LEN];
        for encoded in [
            STANDARD.encode(raw),
            URL_SAFE_NO_PAD.encode(raw),
            format!("  {}  \n", STANDARD.encode(raw)),
        ] {
            assert!(ValueCipher::from_encoded(&encoded).is_ok(), "{encoded}");
        }
    }

    #[test]
    fn rejects_wrong_length_and_non_base64() {
        // 16 bytes is a valid base64 string but the wrong key size.
        assert!(ValueCipher::from_encoded(&STANDARD.encode([1u8; 16])).is_err());
        assert!(ValueCipher::from_encoded("not base64 at all!!").is_err());
        assert!(ValueCipher::from_encoded("").is_err());
    }
}
