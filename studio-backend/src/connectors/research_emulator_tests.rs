//! Studio's own Research client against the Research emulator
//! (`studio-backend research-emulator`): the sign-in, an access key, a build
//! and a deploy, end to end, and not one request the restricted gateway in
//! front of a real stand would refuse.

use std::time::Duration;

use futures_util::future::BoxFuture;

use super::super::oauth::{OAuthClient, Pkce};
use super::*;
use crate::research_emulator::{Timings, spawn_for_tests};

const CALLBACK: &str = "https://studio.example/connections/oauth/callback";

const FAST: Pace = Pace {
    poll: Duration::from_millis(5),
    desk_for: Duration::from_secs(10),
    build_for: Duration::from_secs(10),
    start_for: Duration::from_secs(10),
    settle: Duration::ZERO,
    ready_for: Duration::ZERO,
};

fn instant() -> Timings {
    Timings {
        desk: Duration::ZERO,
        build: Duration::ZERO,
        start: Duration::ZERO,
    }
}

fn quiet<'a>(_: String) -> BoxFuture<'a, ()> {
    Box::pin(async {})
}

fn never() -> bool {
    false
}

/// Sign in the way a member does (Studio's authorize URL, the emulator's
/// form, Studio's code exchange), then make the access key Studio keeps.
async fn signed_in(url: &str) -> ResearchApi {
    let oauth = OAuthClient {
        authorize_url: format!("{url}/idp/connect/authorize"),
        token_url: format!("{url}/idp/connect/token"),
        client_id: "constructor-studio".into(),
        client_secret: "s3cret".into(),
        scope: "openid profile user platform".into(),
        redirect_uris: vec![CALLBACK.into()],
    };
    let pkce = Pkce::new();
    let authorize = oauth.authorize("st-9", &pkce, CALLBACK).unwrap();

    // The browser: the sign-in page, then its form.
    let browser = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let page = browser.get(&authorize).send().await.unwrap();
    assert_eq!(page.status(), 200);
    let mut form: Vec<(String, String)> = reqwest::Url::parse(&authorize)
        .unwrap()
        .query_pairs()
        .into_owned()
        .collect();
    form.push(("email".into(), "ann@example.com".into()));
    form.push(("first_name".into(), "Ann".into()));
    form.push(("last_name".into(), "Lee".into()));
    let back = browser
        .post(&oauth.authorize_url)
        .form(&form)
        .send()
        .await
        .unwrap();
    let to = reqwest::Url::parse(back.headers()["location"].to_str().unwrap()).unwrap();
    let code = to
        .query_pairs()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v.into_owned())
        .unwrap();

    let api_url = format!("{url}/api/platform-account/v1");
    let tokens = oauth
        .exchange_code(&reqwest::Client::new(), &code, &pkce.verifier, CALLBACK)
        .await
        .unwrap();
    let made = ResearchApi::new(reqwest::Client::new(), &api_url, tokens.access_token)
        .create_access_key("studio", "2099-01-01T00:00:00Z")
        .await
        .unwrap();
    ResearchApi::new(reqwest::Client::new(), &api_url, made.key)
}

fn tree(dockerfile: &str) -> std::path::PathBuf {
    let work = std::env::temp_dir().join(format!("research-emu-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(work.join("repo/src")).unwrap();
    std::fs::write(work.join("repo/Dockerfile.studio-api"), dockerfile).unwrap();
    std::fs::write(work.join("repo/src/main.rs"), "fn main() {}\n").unwrap();
    work
}

fn api_image() -> [ImageBuild; 1] {
    [ImageBuild {
        key: "api".into(),
        name: "gbx-api".into(),
        dockerfile: "repo/Dockerfile.studio-api".into(),
    }]
}

#[tokio::test]
async fn studio_signs_in_builds_and_deploys_on_the_emulator() {
    let (url, emu) = spawn_for_tests(instant()).await;
    let api = signed_in(&url).await;

    let me = api.me().await.unwrap();
    assert_eq!(me.display_name().as_deref(), Some("Ann Lee"));
    let projects = api.projects().await.unwrap();
    assert_eq!(projects.len(), 1);
    let p = &projects[0].id;
    let hardware = api.hardware(p).await.unwrap();
    let small = smallest(&hardware).unwrap().clone();
    assert!(!small.gpu);

    let work = tree("FROM rust:1.97\nRUN cargo build --release\nCMD [\"api\"]\n");
    let built = api
        .build_in_desk(p, &work, "research-b1", &api_image(), FAST, &quiet, &never)
        .await
        .unwrap();
    let _ = std::fs::remove_dir_all(&work);
    assert_eq!(built.len(), 1);
    assert_eq!(built[0].id.len(), 32, "an id as Research makes one");

    let body = |value: &str| ServiceBody {
        name: "api".into(),
        image_id: built[0].id.clone(),
        hardware_configuration_id: small.id.clone(),
        volumes: vec![],
        ports: vec![PortBody {
            number: 8080,
            expose_to_internet: true,
        }],
        environment_variables: vec![EnvBody {
            name: "MODE".into(),
            value: value.into(),
        }],
    };
    let app = api
        .put_application(p, "env-dev", &[body("one")], FAST, &quiet)
        .await
        .unwrap();
    let links = app.links();
    assert_eq!(links.len(), 1);
    assert!(links[0].starts_with(&format!("{url}/_apps/")), "{links:?}");
    let page = reqwest::get(&links[0]).await.unwrap().text().await.unwrap();
    assert!(page.contains("MODE") && page.contains("running"), "{page}");

    // A second deploy changes the service in place and restarts it.
    let again = api
        .put_application(p, "env-dev", &[body("two")], FAST, &quiet)
        .await
        .unwrap();
    assert_eq!(again.id, app.id);
    assert_eq!(again.services.len(), 1);
    assert_eq!(again.services[0].status, "running");

    api.delete_application(&app.id).await.unwrap();
    assert!(api.application_named(p, "env-dev").await.unwrap().is_none());

    assert!(
        emu.off_list_calls().is_empty(),
        "Studio called something the gateway would refuse: {:?}",
        emu.off_list_calls()
    );
}

#[tokio::test]
async fn a_failed_build_on_the_emulator_shows_the_last_lines_of_its_log() {
    let (url, _) = spawn_for_tests(instant()).await;
    let api = signed_in(&url).await;
    let p = api.projects().await.unwrap()[0].id.clone();

    let work = tree("FROM rust:1.97\n# research-emulator: fail\nRUN cargo build\n");
    let e = api
        .build_in_desk(
            p.as_str(),
            &work,
            "research-b2",
            &api_image(),
            FAST,
            &quiet,
            &never,
        )
        .await
        .unwrap_err()
        .to_string();
    let _ = std::fs::remove_dir_all(&work);
    assert!(e.contains("could not build image gbx-api"), "{e}");
    assert!(e.contains("STEP 1/2: FROM rust:1.97"), "{e}");
    assert!(e.contains("research-emulator: fail"), "{e}");
}

const FAST_RETRY: DavRetry = DavRetry {
    for_: Duration::from_secs(2),
    first: Duration::from_millis(1),
    cap: Duration::from_millis(5),
    start_for: Duration::from_secs(2),
    poll: Duration::from_millis(5),
};

#[tokio::test]
async fn an_upload_goes_through_the_gateways_502s_on_the_emulator() {
    // Research DEV, 2026-11-19: one PUT of thousands answered 502, and the
    // build failed. Each desk call is asked again now.
    let (url, emu) = spawn_for_tests(instant()).await;
    let api = signed_in(&url).await.with_dav_retry(FAST_RETRY);
    let p = api.projects().await.unwrap()[0].id.clone();
    // A 502 starts the filesystem and asks again, twice at most per call.
    emu.state_for_tests().dav_hiccups = 2;

    let work = tree("FROM rust:1.97\nRUN cargo build\n");
    let built = api
        .build_in_desk(&p, &work, "research-b3", &api_image(), FAST, &quiet, &never)
        .await;
    let _ = std::fs::remove_dir_all(&work);
    assert_eq!(built.unwrap().len(), 1);
    assert_eq!(
        emu.state_for_tests().dav_hiccups,
        0,
        "every hiccup was met and gone through"
    );
}

/// What the concurrent builds below said.
static SAID: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

fn say<'a>(m: String) -> BoxFuture<'a, ()> {
    SAID.lock().unwrap().push(m);
    Box::pin(async {})
}

#[tokio::test]
async fn two_builds_into_one_research_project_take_its_desk_in_turn_on_the_emulator() {
    let (url, emu) = spawn_for_tests(instant()).await;
    let api = signed_in(&url).await;
    let p = api.projects().await.unwrap()[0].id.clone();
    let (one, two) = (
        tree("FROM rust:1.97\nRUN cargo build\n"),
        tree("FROM rust:1.97\nRUN cargo build\n"),
    );
    let images = api_image();
    let (a, b) = tokio::join!(
        api.build_in_desk(&p, &one, "research-c1", &images, FAST, &say, &never),
        api.build_in_desk(&p, &two, "research-c2", &images, FAST, &say, &never),
    );
    let _ = (std::fs::remove_dir_all(&one), std::fs::remove_dir_all(&two));
    assert_eq!(a.unwrap().len(), 1);
    assert_eq!(b.unwrap().len(), 1);
    let said = SAID.lock().unwrap();
    assert!(
        said.iter()
            .any(|m| m.starts_with("waiting for build research-c")),
        "the second says what it waits for: {said:?}"
    );
    let st = emu.state_for_tests();
    assert_eq!(st.images.len(), 2);
    assert!(
        st.desks.values().all(|d| d.status != "running"),
        "the desk is stopped once both are done"
    );
}

/// A tree of nested folders, a small file at the bottom and a 12 MB one.
fn deep_tree() -> (std::path::PathBuf, Vec<u8>) {
    let work = std::env::temp_dir().join(format!("research-emu-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(work.join("repo/a/b/c")).unwrap();
    std::fs::write(work.join("repo/a/b/c/deep.txt"), "deep\n").unwrap();
    let big: Vec<u8> = (0..12_582_912u32).map(|i| (i % 253) as u8).collect();
    std::fs::write(work.join("repo/a/big.bin"), &big).unwrap();
    (work, big)
}

/// A desk of the project, its filesystem running.
async fn running_desk(api: &ResearchApi, p: &str) -> String {
    let desk = api.build_desk(p).await.unwrap();
    api.desk_running(&desk.id, FAST, &never).await.unwrap();
    desk.id
}

#[tokio::test]
async fn a_tree_and_a_12_mb_file_go_up_by_the_desks_rules_on_the_emulator() {
    // The emulator keeps Research's rules (2026-11): no folder made by a PUT
    // (404 ENOENT), MKCOL 405/409, no body over 8 MB (413), parts of exactly
    // 5 MiB but the last, with their checksums.
    let (url, emu) = spawn_for_tests(instant()).await;
    let api = signed_in(&url).await.with_dav_retry(FAST_RETRY);
    let p = api.projects().await.unwrap()[0].id.clone();
    let desk = running_desk(&api, &p).await;
    let (work, big) = deep_tree();
    let files = api.upload(&desk, &work, "studio-build/t1", None).await;
    let _ = std::fs::remove_dir_all(&work);
    assert_eq!(files.unwrap(), 2);

    let st = emu.state_for_tests();
    let stored = &st.files[&desk];
    assert_eq!(
        stored.files["studio-build/t1/repo/a/b/c/deep.txt"],
        b"deep\n"
    );
    assert!(
        stored.files["studio-build/t1/repo/a/big.bin"] == big,
        "the parts make the file again"
    );
    let refused: Vec<_> = st
        .calls
        .iter()
        // A DELETE before a parts upload finds no file the first time: 404 is
        // its answer then, not a missing folder.
        .filter(|c| matches!(c.status, 400 | 404 | 409 | 413))
        .filter(|c| !(c.status == 404 && c.method == "DELETE"))
        .map(|c| format!("{} {} {}", c.status, c.method, c.path))
        .collect();
    assert!(
        refused.is_empty(),
        "never 413, never a missing folder: {refused:?}"
    );
    let parts = st
        .calls
        .iter()
        .filter(|c| c.method == "PUT" && c.path.ends_with("/repo/a/big.bin"))
        .count();
    assert_eq!(parts, 3, "5 MiB + 5 MiB + 2 MiB");
}

#[tokio::test]
async fn a_desk_whose_file_service_is_down_is_started_and_the_write_goes_on_on_the_emulator() {
    // Research's rules §2: a 503 means the desk's file service is not
    // running; Studio starts it and waits for it, rather than asking blindly.
    let (url, emu) = spawn_for_tests(instant()).await;
    let api = signed_in(&url).await.with_dav_retry(FAST_RETRY);
    let p = api.projects().await.unwrap()[0].id.clone();
    let desk = api.build_desk(&p).await.unwrap().id;
    api.put_file(&desk, "x.txt", b"x").await.unwrap();
    let st = emu.state_for_tests();
    assert_eq!(st.files[&desk].files["x.txt"], b"x");
    let seen: Vec<String> = st
        .calls
        .iter()
        .map(|c| format!("{} {}", c.status, c.method))
        .collect();
    assert!(seen.contains(&"503 PUT".to_owned()), "{seen:?}");
    assert!(
        st.calls
            .iter()
            .any(|c| c.method == "POST" && c.path.ends_with("/filesystem")),
        "{seen:?}"
    );
}

#[tokio::test]
async fn a_damaged_part_is_sent_again_on_the_emulator() {
    // Research's rules §5.4: `409 Checksum mismatch`, then resend that part.
    let (url, emu) = spawn_for_tests(instant()).await;
    let api = signed_in(&url).await.with_dav_retry(FAST_RETRY);
    let p = api.projects().await.unwrap()[0].id.clone();
    let desk = running_desk(&api, &p).await;
    emu.state_for_tests().corrupt_next_parts = 1;
    let content: Vec<u8> = (0..12_582_912u32).map(|i| (i % 241) as u8).collect();
    api.put_file(&desk, "weights.bin", &content).await.unwrap();
    let st = emu.state_for_tests();
    assert!(st.files[&desk].files["weights.bin"] == content);
    let puts: Vec<u16> = st
        .calls
        .iter()
        .filter(|c| c.method == "PUT" && c.path.ends_with("/weights.bin"))
        .map(|c| c.status)
        .collect();
    assert_eq!(
        puts.len(),
        4,
        "three parts and the damaged one again: {puts:?}"
    );
    assert_eq!(puts.iter().filter(|s| **s == 409).count(), 1, "{puts:?}");
}
