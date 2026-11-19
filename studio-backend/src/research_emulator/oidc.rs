//! The identity provider as an OpenID Connect provider: what a Keycloak broker
//! needs beyond the authorize and token pair Studio's own connection uses.
//!
//! Constructor's identity provider publishes discovery, a JWKS, ID tokens and
//! userinfo, and Studio's Keycloak brokers it for signing in
//! (`keycloak/CONSTRUCTOR_SSO.md`). The emulator answers the same paths so a
//! local stand can sign a person in through it:
//!
//! - `GET /idp/.well-known/openid-configuration`
//! - `GET /idp/.well-known/openid-configuration/jwks`, at the path the real
//!   one uses
//! - an `id_token` beside the access token when the sign-in asked for `openid`
//! - `GET /idp/connect/userinfo`
//! - `GET /idp/connect/endsession`, which goes straight back
//!
//! The ID token is signed ES256 with a key made at start-up and published in
//! the JWKS; the real provider signs RS256, and a broker that reads its keys
//! from the JWKS takes either. A restart makes a new key under a new `kid`,
//! which a broker fetches when it sees the `kid` it does not know.

use anyhow::anyhow;
use aws_lc_rs::rand::SystemRandom;
use aws_lc_rs::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair as _};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::Config;
use super::state::User;

/// How long an ID token stands, the same as the access token.
pub const ID_TOKEN_SECONDS: u64 = 3600;

/// The key ID tokens are signed with.
pub struct Signer {
    pair: EcdsaKeyPair,
    kid: String,
}

impl Signer {
    pub fn generate() -> anyhow::Result<Self> {
        let pair = EcdsaKeyPair::generate(&ECDSA_P256_SHA256_FIXED_SIGNING)
            .map_err(|_| anyhow!("could not make the ID token signing key"))?;
        let kid = URL_SAFE_NO_PAD.encode(&Sha256::digest(pair.public_key().as_ref())[..12]);
        Ok(Self { pair, kid })
    }

    /// The public key as a JWK.
    pub fn jwk(&self) -> Value {
        // An uncompressed P-256 point: 0x04, then x and y, 32 bytes each.
        let point = self.pair.public_key().as_ref();
        json!({
            "kty": "EC",
            "crv": "P-256",
            "use": "sig",
            "alg": "ES256",
            "kid": self.kid,
            "x": URL_SAFE_NO_PAD.encode(&point[1..33]),
            "y": URL_SAFE_NO_PAD.encode(&point[33..65]),
        })
    }

    /// `claims` as a compact JWS.
    pub fn sign(&self, claims: &Value) -> anyhow::Result<String> {
        let header = json!({ "alg": "ES256", "typ": "JWT", "kid": self.kid });
        let input = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header)?),
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims)?)
        );
        let signature = self
            .pair
            .sign(&SystemRandom::new(), input.as_bytes())
            .map_err(|_| anyhow!("could not sign the ID token"))?;
        Ok(format!(
            "{input}.{}",
            URL_SAFE_NO_PAD.encode(signature.as_ref())
        ))
    }
}

/// The issuer: the public URL plus `/idp`, as Studio's research `issuer` is.
pub fn issuer(cfg: &Config) -> String {
    format!("{}/idp", cfg.public_url)
}

/// The discovery document.
pub fn discovery(cfg: &Config) -> Value {
    let iss = issuer(cfg);
    json!({
        "issuer": iss,
        "authorization_endpoint": format!("{iss}/connect/authorize"),
        "token_endpoint": format!("{iss}/connect/token"),
        "userinfo_endpoint": format!("{iss}/connect/userinfo"),
        "end_session_endpoint": format!("{iss}/connect/endsession"),
        "jwks_uri": format!("{iss}/.well-known/openid-configuration/jwks"),
        "scopes_supported": ["openid", "profile", "email", "user", "platform", "offline_access"],
        "claims_supported": ["sub", "name", "given_name", "family_name", "email", "email_verified"],
        "response_types_supported": ["code"],
        "response_modes_supported": ["query"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "token_endpoint_auth_methods_supported": ["client_secret_post", "client_secret_basic"],
        "id_token_signing_alg_values_supported": ["ES256"],
        "subject_types_supported": ["public"],
        "code_challenge_methods_supported": ["S256"],
        "frontchannel_logout_supported": false,
        "backchannel_logout_supported": false,
    })
}

/// What the provider says about a member: the userinfo answer, and the
/// person-describing part of an ID token.
///
/// No `preferred_username`: a broker then names the account by its address,
/// which is what Studio confirms as the person's alias.
pub fn claims(user: &User) -> Value {
    let mut c = json!({
        "sub": user.id,
        "email": user.email,
        "email_verified": user.email_verified,
    });
    let name = format!("{} {}", user.first_name, user.last_name)
        .trim()
        .to_owned();
    for (k, v) in [
        ("given_name", user.first_name.as_str()),
        ("family_name", user.last_name.as_str()),
        ("name", name.as_str()),
    ] {
        if !v.is_empty() {
            c[k] = json!(v);
        }
    }
    c
}

/// The ID token for a sign-in by `user` through `client_id`.
pub fn id_token(
    cfg: &Config,
    signer: &Signer,
    user: &User,
    client_id: &str,
    nonce: &str,
    now_ms: u64,
) -> anyhow::Result<String> {
    let now = now_ms / 1000;
    let mut c = claims(user);
    c["iss"] = json!(issuer(cfg));
    c["aud"] = json!(client_id);
    c["iat"] = json!(now);
    c["auth_time"] = json!(now);
    c["exp"] = json!(now + ID_TOKEN_SECONDS);
    if !nonce.is_empty() {
        c["nonce"] = json!(nonce);
    }
    signer.sign(&c)
}

/// Whether a space-separated scope asks for OpenID Connect.
pub fn wants_openid(scope: &str) -> bool {
    scope.split_whitespace().any(|s| s == "openid")
}
