use std::time::Duration;

use serde_json::{Value, json};

use super::*;

const CALLBACK: &str = "https://studio.example/connections/oauth/callback";

fn instant() -> Timings {
    Timings {
        desk: Duration::ZERO,
        build: Duration::ZERO,
        start: Duration::ZERO,
    }
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
}

fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Sign in as `email` the way a browser and Studio do; the code.
async fn code_for(url: &str, email: &str, verifier: &str) -> String {
    let res = http()
        .post(format!("{url}/idp/connect/authorize"))
        .form(&[
            ("response_type", "code"),
            ("client_id", "constructor-studio"),
            ("redirect_uri", CALLBACK),
            ("scope", "openid profile user platform"),
            ("state", "st-1"),
            ("code_challenge", &challenge(verifier)),
            ("code_challenge_method", "S256"),
            ("email", email),
            ("first_name", "Ann"),
            ("last_name", "Lee"),
        ])
        .send()
        .await
        .unwrap();
    assert!(res.status().is_redirection(), "{}", res.status());
    let to = reqwest::Url::parse(res.headers()["location"].to_str().unwrap()).unwrap();
    assert!(to.as_str().starts_with(CALLBACK));
    let q: std::collections::HashMap<_, _> = to.query_pairs().into_owned().collect();
    assert_eq!(q["state"], "st-1", "the state comes back");
    q["code"].clone()
}

async fn exchange(url: &str, code: &str, verifier: &str) -> reqwest::Response {
    http()
        .post(format!("{url}/idp/connect/token"))
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", CALLBACK),
            ("code_verifier", verifier),
            ("client_id", "constructor-studio"),
            ("client_secret", "s3cret"),
        ])
        .send()
        .await
        .unwrap()
}

/// A member's access key, made the way Studio makes one.
async fn key_for(url: &str, email: &str) -> String {
    let code = code_for(url, email, "v-1").await;
    let tokens: Value = exchange(url, &code, "v-1").await.json().await.unwrap();
    let made: Value = http()
        .post(format!("{url}/api/platform-account/access-keys"))
        .bearer_auth(tokens["access_token"].as_str().unwrap())
        .json(&json!({ "name": "studio", "expires_at": "2099-01-01T00:00:00Z" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    made["key"].as_str().unwrap().to_owned()
}

fn keyed(req: reqwest::RequestBuilder, key: &str) -> reqwest::RequestBuilder {
    req.header("X-Research-AccessKey", format!("Bearer {key}"))
}

#[tokio::test]
async fn the_sign_in_page_is_refused_for_an_unregistered_callback_or_without_pkce() {
    let (url, _) = spawn_for_tests(instant()).await;
    let ok = http()
        .get(format!(
            "{url}/idp/connect/authorize?response_type=code&client_id=constructor-studio&redirect_uri={}&scope=x&state=s&code_challenge=c&code_challenge_method=S256",
            urlencode(CALLBACK)
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(ok.status(), 200);
    assert!(ok.text().await.unwrap().contains("name=\"email\""));

    let elsewhere = http()
        .get(format!(
            "{url}/idp/connect/authorize?response_type=code&client_id=constructor-studio&redirect_uri=https%3A%2F%2Fevil.example%2Fcb&code_challenge=c&code_challenge_method=S256"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(elsewhere.status(), 400);

    let no_pkce = http()
        .get(format!(
            "{url}/idp/connect/authorize?response_type=code&client_id=constructor-studio&redirect_uri={}",
            urlencode(CALLBACK)
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(no_pkce.status(), 400);
}

fn urlencode(s: &str) -> String {
    let mut u = reqwest::Url::parse("http://x/").unwrap();
    u.query_pairs_mut().append_pair("v", s);
    u.query().unwrap()[2..].to_owned()
}

#[tokio::test]
async fn a_code_is_exchanged_once_and_only_with_its_verifier() {
    let (url, _) = spawn_for_tests(instant()).await;
    let code = code_for(&url, "ann@example.com", "right").await;

    let wrong = exchange(&url, &code, "wrong").await;
    assert_eq!(wrong.status(), 400);
    let body: Value = wrong.json().await.unwrap();
    assert_eq!(body["error"], "invalid_grant");

    // A refused exchange spends the code, as a one-time code should.
    let code = code_for(&url, "ann@example.com", "right").await;
    let ok: Value = exchange(&url, &code, "right").await.json().await.unwrap();
    assert!(ok["access_token"].as_str().is_some_and(|t| t.len() == 32));
    assert!(ok["refresh_token"].is_string());

    let again = exchange(&url, &code, "right").await;
    assert_eq!(again.status(), 400, "a code is used once");
}

#[tokio::test]
async fn an_access_key_is_made_with_the_sign_ins_token_and_not_with_a_key() {
    let (url, _) = spawn_for_tests(instant()).await;
    let key = key_for(&url, "ann@example.com").await;
    assert!(key.starts_with("rk-"));

    let session: Value = keyed(
        http().get(format!("{url}/api/platform-account/v1/auth/session")),
        &key,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(session["user"]["email"], "ann@example.com");
    assert_eq!(session["user"]["id"].as_str().unwrap().len(), 32);

    let by_key = keyed(
        http().post(format!("{url}/api/platform-account/access-keys")),
        &key,
    )
    .json(&json!({ "name": "x", "expires_at": "2099-01-01T00:00:00Z" }))
    .send()
    .await
    .unwrap();
    assert_eq!(by_key.status(), 403);

    let nobody = http()
        .get(format!("{url}/api/platform-account/v1/projects"))
        .send()
        .await
        .unwrap();
    assert_eq!(nobody.status(), 401);
    let refusal: Value = nobody.json().await.unwrap();
    assert!(
        refusal["detail"]["msg"].is_string(),
        "Research's refusal shape"
    );
}

#[tokio::test]
async fn a_member_sees_only_their_own_projects() {
    let (url, _) = spawn_for_tests(instant()).await;
    let ann = key_for(&url, "ann@example.com").await;
    let bob = key_for(&url, "bob@example.com").await;
    let projects = |key: String| {
        let url = url.clone();
        async move {
            let v: Value = keyed(
                http().get(format!("{url}/api/platform-account/v1/projects")),
                &key,
            )
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
            v["results"].as_array().unwrap().clone()
        }
    };
    let a = projects(ann.clone()).await;
    let b = projects(bob).await;
    assert_eq!(a.len(), 1, "the first sign-in makes a project");
    assert_ne!(a[0]["id"], b[0]["id"]);

    let foreign = keyed(
        http().get(format!(
            "{url}/api/platform-account/v1/projects/{}/desks",
            b[0]["id"].as_str().unwrap()
        )),
        &ann,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(foreign.status(), 404);
}

#[tokio::test]
async fn a_request_the_gateway_would_refuse_is_refused_and_marked() {
    let (url, emu) = spawn_for_tests(instant()).await;
    let key = key_for(&url, "ann@example.com").await;
    let propfind = keyed(
        http().request(
            reqwest::Method::from_bytes(b"PROPFIND").unwrap(),
            format!("{url}/api/platform-storage/desks/d/dav/project/x"),
        ),
        &key,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(propfind.status(), 405);
    let other = keyed(
        http().get(format!("{url}/api/platform-account/v1/users")),
        &key,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(other.status(), 404);

    let st = emu.lock();
    let off: Vec<String> = st
        .calls
        .iter()
        .filter(|c| c.off_list)
        .map(|c| format!("{} {}", c.method, c.path))
        .collect();
    assert_eq!(
        off,
        [
            "PROPFIND /api/platform-storage/desks/d/dav/project/x",
            "GET /api/platform-account/v1/users"
        ]
    );
}

#[tokio::test]
async fn a_build_reads_its_dockerfile_from_the_desk_and_streams_its_log() {
    let (url, _) = spawn_for_tests(instant()).await;
    let key = key_for(&url, "ann@example.com").await;
    let acc = format!("{url}/api/platform-account/v1");
    let projects: Value = keyed(http().get(format!("{acc}/projects")), &key)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let p = projects["results"][0]["id"].as_str().unwrap().to_owned();
    let desk: Value = keyed(http().post(format!("{acc}/projects/{p}/desks")), &key)
        .json(&json!({ "name": "studio" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let d = desk["id"].as_str().unwrap().to_owned();

    let early = keyed(
        http().put(format!(
            "{url}/api/platform-storage/desks/{d}/dav/project/Dockerfile"
        )),
        &key,
    )
    .body("FROM scratch\n")
    .send()
    .await
    .unwrap();
    assert_eq!(
        early.status(),
        409,
        "a desk's files are reachable once it runs"
    );

    keyed(http().post(format!("{acc}/desks/{d}/filesystem")), &key)
        .send()
        .await
        .unwrap();
    let put = keyed(http().put(format!("{url}/api/platform-storage/desks/{d}/dav/project/Dockerfile")), &key)
        .body("FROM rust:1.97\n# research-emulator: fail\nRUN cargo build \\\n  --release\nCMD [\"app\"]\n")
        .send()
        .await
        .unwrap();
    assert_eq!(put.status(), 201);

    let image: Value = keyed(http().post(format!("{acc}/desks/{d}/images")), &key)
        .json(&json!({ "name": "gbx-api", "dockerfile": "Dockerfile" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let i = image["id"].as_str().unwrap().to_owned();
    let now: Value = keyed(http().get(format!("{acc}/images/{i}")), &key)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(now["build_status"], "error");

    let logs = http()
        .get(format!("{url}/api/platform-keeper/image-builds/{i}/logs"))
        .header("accept", "text/event-stream")
        .send()
        .await
        .unwrap();
    assert_eq!(logs.headers()["content-type"], "text/event-stream");
    let text = logs.text().await.unwrap();
    assert!(text.contains("STEP 1/3: FROM rust:1.97"), "{text}");
    assert!(
        text.contains("RUN cargo build --release") || text.contains("error building"),
        "{text}"
    );
    assert!(text.contains("research-emulator: fail"), "{text}");
}

/* ── the identity provider as an OpenID Connect provider (oidc.rs) ── */

/// A sign-in the way a Keycloak broker makes one: `openid` scope and a nonce.
async fn broker_code_for(url: &str, email: &str, unverified: bool) -> String {
    let challenge = challenge("v-broker");
    let mut form = vec![
        ("response_type", "code"),
        ("client_id", "constructor-studio"),
        ("redirect_uri", CALLBACK),
        ("scope", "openid email profile"),
        ("state", "st-1"),
        ("nonce", "n-0S6_WzA2Mj"),
        ("code_challenge", challenge.as_str()),
        ("code_challenge_method", "S256"),
        ("email", email),
        ("first_name", "Ann"),
        ("last_name", "Lee"),
    ];
    if unverified {
        form.push(("email_unverified", "on"));
    }
    let res = http()
        .post(format!("{url}/idp/connect/authorize"))
        .form(&form)
        .send()
        .await
        .unwrap();
    assert!(res.status().is_redirection(), "{}", res.status());
    let to = reqwest::Url::parse(res.headers()["location"].to_str().unwrap()).unwrap();
    let q: std::collections::HashMap<_, _> = to.query_pairs().into_owned().collect();
    q["code"].clone()
}

/// The claims of `token`, after checking its signature against the JWKS.
async fn verified_claims(url: &str, token: &str) -> Value {
    use aws_lc_rs::signature::{ECDSA_P256_SHA256_FIXED, UnparsedPublicKey};
    let jwks: Value = http()
        .get(format!("{url}/idp/.well-known/openid-configuration/jwks"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let parts: Vec<&str> = token.split('.').collect();
    assert_eq!(parts.len(), 3, "a compact JWS");
    let header: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).unwrap()).unwrap();
    assert_eq!(header["alg"], "ES256");
    let jwk = jwks["keys"]
        .as_array()
        .unwrap()
        .iter()
        .find(|k| k["kid"] == header["kid"])
        .expect("the kid of the token is in the JWKS");
    let mut point = vec![4u8];
    point.extend(URL_SAFE_NO_PAD.decode(jwk["x"].as_str().unwrap()).unwrap());
    point.extend(URL_SAFE_NO_PAD.decode(jwk["y"].as_str().unwrap()).unwrap());
    UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, point)
        .verify(
            format!("{}.{}", parts[0], parts[1]).as_bytes(),
            &URL_SAFE_NO_PAD.decode(parts[2]).unwrap(),
        )
        .expect("the signature verifies with the published key");
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap()
}

#[tokio::test]
async fn discovery_names_the_endpoints_a_broker_reads() {
    let (url, emu) = spawn_for_tests(instant()).await;
    let d: Value = http()
        .get(format!("{url}/idp/.well-known/openid-configuration"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(d["issuer"], format!("{url}/idp"));
    assert_eq!(
        d["authorization_endpoint"],
        format!("{url}/idp/connect/authorize")
    );
    assert_eq!(d["token_endpoint"], format!("{url}/idp/connect/token"));
    assert_eq!(
        d["userinfo_endpoint"],
        format!("{url}/idp/connect/userinfo")
    );
    assert_eq!(
        d["end_session_endpoint"],
        format!("{url}/idp/connect/endsession")
    );
    // The real provider's path, so a broker configured from either reads the same.
    assert_eq!(
        d["jwks_uri"],
        format!("{url}/idp/.well-known/openid-configuration/jwks")
    );
    assert_eq!(d["code_challenge_methods_supported"], json!(["S256"]));
    assert!(
        emu.off_list_calls().is_empty(),
        "{:?}",
        emu.off_list_calls()
    );
}

#[tokio::test]
async fn an_openid_sign_in_gets_a_signed_id_token_with_the_nonce() {
    let (url, _) = spawn_for_tests(instant()).await;
    let code = broker_code_for(&url, "Ann@Example.com", false).await;
    let tokens: Value = exchange(&url, &code, "v-broker")
        .await
        .json()
        .await
        .unwrap();
    let claims = verified_claims(&url, tokens["id_token"].as_str().expect("an id_token")).await;
    assert_eq!(claims["iss"], format!("{url}/idp"));
    assert_eq!(claims["aud"], "constructor-studio");
    assert_eq!(claims["nonce"], "n-0S6_WzA2Mj");
    assert_eq!(claims["email"], "ann@example.com");
    assert_eq!(claims["email_verified"], true);
    assert_eq!(claims["given_name"], "Ann");
    assert_eq!(claims["family_name"], "Lee");
    assert!(claims["exp"].as_u64().unwrap() > claims["iat"].as_u64().unwrap());
    // No preferred_username: a broker names the account by its address.
    assert!(claims.get("preferred_username").is_none());

    let info: Value = http()
        .get(format!("{url}/idp/connect/userinfo"))
        .bearer_auth(tokens["access_token"].as_str().unwrap())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(info["sub"], claims["sub"]);
    assert_eq!(info["email"], "ann@example.com");
    assert_eq!(info["email_verified"], true);

    let anonymous = http()
        .get(format!("{url}/idp/connect/userinfo"))
        .bearer_auth("not-a-token")
        .send()
        .await
        .unwrap();
    assert_eq!(anonymous.status(), 401);
}

#[tokio::test]
async fn an_address_signed_in_as_unverified_says_so_in_the_token() {
    let (url, _) = spawn_for_tests(instant()).await;
    let code = broker_code_for(&url, "bob@example.com", true).await;
    let tokens: Value = exchange(&url, &code, "v-broker")
        .await
        .json()
        .await
        .unwrap();
    let claims = verified_claims(&url, tokens["id_token"].as_str().unwrap()).await;
    assert_eq!(claims["email_verified"], false);
}

#[tokio::test]
async fn a_sign_in_without_openid_gets_no_id_token() {
    let (url, _) = spawn_for_tests(instant()).await;
    let res = http()
        .post(format!("{url}/idp/connect/authorize"))
        .form(&[
            ("response_type", "code"),
            ("client_id", "constructor-studio"),
            ("redirect_uri", CALLBACK),
            ("scope", "profile user platform"),
            ("state", "s"),
            ("code_challenge", &challenge("v")),
            ("code_challenge_method", "S256"),
            ("email", "ann@example.com"),
        ])
        .send()
        .await
        .unwrap();
    let to = reqwest::Url::parse(res.headers()["location"].to_str().unwrap()).unwrap();
    let q: std::collections::HashMap<_, _> = to.query_pairs().into_owned().collect();
    let tokens: Value = exchange(&url, &q["code"], "v").await.json().await.unwrap();
    assert!(tokens["access_token"].is_string());
    assert!(tokens.get("id_token").is_none());
}

#[tokio::test]
async fn the_token_call_takes_the_client_secret_by_basic_auth_too() {
    let (url, _) = spawn_for_tests(instant()).await;
    for (secret, status) in [("s3cret", 200), ("wrong", 401)] {
        let code = broker_code_for(&url, "ann@example.com", false).await;
        let res = http()
            .post(format!("{url}/idp/connect/token"))
            .basic_auth("constructor-studio", Some(secret))
            .form(&[
                ("grant_type", "authorization_code"),
                ("code", code.as_str()),
                ("redirect_uri", CALLBACK),
                ("code_verifier", "v-broker"),
            ])
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), status, "secret {secret}");
    }
}

#[tokio::test]
async fn signing_out_goes_back_only_under_a_registered_callback() {
    let (url, _) = spawn_for_tests(instant()).await;
    let back = format!("{CALLBACK}/logout_response");
    let res = http()
        .get(format!(
            "{url}/idp/connect/endsession?post_logout_redirect_uri={}&state=s-9",
            urlencode(&back)
        ))
        .send()
        .await
        .unwrap();
    assert!(res.status().is_redirection());
    assert_eq!(
        res.headers()["location"],
        format!("{back}?state=s-9").as_str()
    );

    let elsewhere = http()
        .get(format!(
            "{url}/idp/connect/endsession?post_logout_redirect_uri={}",
            urlencode("https://evil.example/")
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(elsewhere.status(), 200, "a page, not a redirect");
}
