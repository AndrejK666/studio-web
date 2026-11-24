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
    api.desk_running(&desk.id, FAST, &never, HandOver::never().follow_until)
        .await
        .unwrap();
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

#[tokio::test]
async fn a_build_counts_the_desk_the_files_the_bytes_and_the_images_on_the_emulator() {
    let (url, _) = spawn_for_tests(instant()).await;
    let api = signed_in(&url).await;
    let p = api.projects().await.unwrap()[0].id.clone();
    let work = tree("FROM rust:1.97\nCMD [\"api\"]\n");
    let seen: std::sync::Mutex<Vec<Measured>> = std::sync::Mutex::default();
    let measure = |m: Measured| -> BoxFuture<'_, ()> {
        seen.lock().unwrap().push(m);
        Box::pin(async {})
    };
    api.build_in_desk_measured(
        &p,
        &work,
        "research-m1",
        &api_image(),
        FAST,
        &quiet,
        &measure,
        &never,
    )
    .await
    .unwrap();
    let _ = std::fs::remove_dir_all(&work);
    let seen = seen.into_inner().unwrap();
    assert_eq!(seen.first(), Some(&Measured::Desk), "{seen:?}");
    let uploads: Vec<_> = seen
        .iter()
        .filter_map(|m| match m {
            Measured::Upload {
                files_done,
                files_total,
                bytes_done,
                bytes_total,
            } => Some((*files_done, *files_total, *bytes_done, *bytes_total)),
            _ => None,
        })
        .collect();
    let first = uploads.first().copied().unwrap();
    let last = uploads.last().copied().unwrap();
    assert_eq!((first.0, first.2), (0, 0), "it starts at nothing");
    assert_eq!(last.1, 2, "the Dockerfile and main.rs");
    assert_eq!(
        (last.0, last.2),
        (last.1, last.3),
        "and ends at every file and byte"
    );
    assert!(last.3 > 0);
    assert_eq!(
        seen.last(),
        Some(&Measured::Images { done: 1, total: 1 }),
        "{seen:?}"
    );
}

#[tokio::test]
async fn a_project_whose_deployment_is_off_says_so_and_refuses_to_build_on_the_emulator() {
    let (url, emu) = spawn_for_tests(instant()).await;
    let api = signed_in(&url).await;
    let p = api.projects().await.unwrap()[0].clone();
    assert_eq!(p.deployment_enabled, Some(true), "a new project's is on");

    emu.state_for_tests()
        .projects
        .get_mut(&p.id)
        .unwrap()
        .deployment_enabled = false;
    assert_eq!(
        api.projects().await.unwrap()[0].deployment_enabled,
        Some(false)
    );

    let work = tree("FROM rust:1.97\nCMD [\"api\"]\n");
    let refused = api
        .build_in_desk(
            &p.id,
            &work,
            "research-off",
            &api_image(),
            FAST,
            &quiet,
            &never,
        )
        .await
        .unwrap_err();
    let _ = std::fs::remove_dir_all(&work);
    assert!(
        format!("{refused:#}").contains("Deployment is not enabled for this project"),
        "{refused:#}"
    );

    // Turned on (as a deploy does), it is on again.
    api.enable_deployment(&p.id).await.unwrap();
    assert_eq!(
        api.projects().await.unwrap()[0].deployment_enabled,
        Some(true)
    );
}

/// How many files went up to the desk (the desk's lock, written again by
/// every attempt, is not one), and how many images Research was asked for.
fn uploads_and_builds(emu: &crate::research_emulator::Shared) -> (usize, usize) {
    let st = emu.state_for_tests();
    let puts = st
        .calls
        .iter()
        .filter(|c| {
            c.method == "PUT" && c.path.contains("/dav/") && !c.path.ends_with(".studio-desk-lock")
        })
        .count();
    (puts, st.images.len())
}

fn slow_builds() -> Timings {
    Timings {
        desk: Duration::ZERO,
        build: Duration::from_millis(600),
        start: Duration::ZERO,
    }
}

/// One attempt of the build's run: it follows the images for `follow`, then
/// hands over what the next attempt goes on from, as the run would between
/// its attempts -- through JSON, as it is kept on the run.
async fn attempt(
    api: &ResearchApi,
    project: &str,
    local: Option<&std::path::Path>,
    name: &str,
    images: &[ImageBuild],
    state: DeskBuild,
    follow: Duration,
) -> Followed {
    let kept: std::sync::Mutex<Option<DeskBuild>> = std::sync::Mutex::default();
    let checkpoint = |d: &DeskBuild| -> BoxFuture<'_, ()> {
        *kept.lock().unwrap() = Some(d.clone());
        Box::pin(async {})
    };
    let now = tokio::time::Instant::now();
    let went = api
        .desk_build(
            project,
            local,
            name,
            images,
            state,
            FAST,
            HandOver {
                upload_by: now + Duration::from_secs(60),
                follow_until: now + follow,
            },
            &quiet,
            &unmeasured,
            &checkpoint,
            &never,
        )
        .await
        .unwrap();
    match went {
        Followed::Later(state) => {
            let text = serde_json::to_string(&state).unwrap();
            Followed::Later(serde_json::from_str(&text).unwrap())
        }
        built => built,
    }
}

#[tokio::test]
async fn an_image_build_longer_than_an_attempt_goes_on_in_the_next_and_deploys_on_the_emulator() {
    // research-faa4fdf8107a on the stand, 2026-11-23: gbx-api-gateway took
    // longer than the run queue's lease, and the run was given up on. Here
    // an attempt follows the builds for 100 ms -- the "lease" -- and each
    // build takes 600 ms.
    let (url, emu) = spawn_for_tests(slow_builds()).await;
    let api = signed_in(&url).await;
    let p = api.projects().await.unwrap()[0].id.clone();
    let work = tree("FROM rust:1.97\nRUN cargo build\nCMD [\"api\"]\n");

    let mut went = attempt(
        &api,
        &p,
        Some(&work),
        "research-l1",
        &api_image(),
        DeskBuild::default(),
        Duration::from_millis(100),
    )
    .await;
    let _ = std::fs::remove_dir_all(&work);
    let after_first = uploads_and_builds(&emu);
    assert_eq!(after_first.1, 1, "one image asked for");
    let mut attempts = 1;
    let built = loop {
        match went {
            Followed::Built(built) => break built,
            Followed::Later(state) => {
                assert!(state.submitted && state.desk.is_some(), "{state:?}");
                attempts += 1;
                assert!(attempts < 50, "it never finished");
                // No tree: a later attempt needs none.
                went = attempt(
                    &api,
                    &p,
                    None,
                    "research-l1",
                    &api_image(),
                    state,
                    Duration::from_millis(100),
                )
                .await;
            }
        }
    };
    assert!(
        attempts >= 3,
        "the build outlasted its attempts: {attempts}"
    );
    assert_eq!(
        uploads_and_builds(&emu),
        after_first,
        "nothing was uploaded or built again"
    );
    assert_eq!(built.len(), 1);

    let small = smallest(&api.hardware(&p).await.unwrap()).unwrap().clone();
    let app = api
        .put_application(
            &p,
            "env-dev",
            &[ServiceBody {
                name: "api".into(),
                image_id: built[0].id.clone(),
                hardware_configuration_id: small.id,
                volumes: vec![],
                ports: vec![PortBody {
                    number: 8080,
                    expose_to_internet: true,
                }],
                environment_variables: vec![],
            }],
            FAST,
            &quiet,
        )
        .await
        .unwrap();
    assert_eq!(app.services[0].status, "running");
}

fn two_images() -> [ImageBuild; 2] {
    [
        ImageBuild {
            key: "api".into(),
            name: "gbx-api".into(),
            dockerfile: "repo/Dockerfile.studio-api".into(),
        },
        ImageBuild {
            key: "ui".into(),
            name: "gbx-ui".into(),
            dockerfile: "repo/Dockerfile.studio-api".into(),
        },
    ]
}

#[tokio::test]
async fn images_an_earlier_build_made_are_not_uploaded_nor_built_again_on_the_emulator() {
    let (url, emu) = spawn_for_tests(instant()).await;
    let api = signed_in(&url).await;
    let p = api.projects().await.unwrap()[0].id.clone();
    let work = tree("FROM rust:1.97\nCMD [\"api\"]\n");
    let first = api
        .build_in_desk(
            &p,
            &work,
            "research-r1",
            &two_images(),
            FAST,
            &quiet,
            &never,
        )
        .await
        .unwrap();
    let before = uploads_and_builds(&emu);
    assert_eq!(before.1, 2);

    // Nothing changed: no desk, no upload, no build -- straight to deploy.
    let went = attempt(
        &api,
        &p,
        None,
        "research-r2",
        &[],
        DeskBuild::reusing(first.clone()),
        Duration::from_secs(5),
    )
    .await;
    let Followed::Built(again) = went else {
        panic!("{went:?}")
    };
    assert_eq!(
        uploads_and_builds(&emu),
        before,
        "nothing uploaded or built"
    );
    assert_eq!(again, first, "the same images");

    // The ui changed: only it is built.
    let api_kept: Vec<Built> = first.iter().filter(|b| b.key == "api").cloned().collect();
    let ui_only: Vec<ImageBuild> = two_images().into_iter().filter(|i| i.key == "ui").collect();
    let went = attempt(
        &api,
        &p,
        Some(&work),
        "research-r3",
        &ui_only,
        DeskBuild::reusing(api_kept),
        Duration::from_secs(5),
    )
    .await;
    let _ = std::fs::remove_dir_all(&work);
    let Followed::Built(third) = went else {
        panic!("{went:?}")
    };
    assert_eq!(uploads_and_builds(&emu).1, 3, "one image more: the ui");
    assert_eq!(third[0], first[0], "the api's image is the earlier one");
    assert_ne!(third[1].id, first[1].id, "the ui's is new");
}

#[tokio::test]
async fn the_images_of_a_build_that_stopped_following_them_deploy_once_built_on_the_emulator() {
    // A build that failed after its images were asked for: its record keeps
    // their ids, Research goes on building them, and "Deploy these images"
    // checks each is built and runs them -- building nothing.
    let (url, emu) = spawn_for_tests(slow_builds()).await;
    let api = signed_in(&url).await;
    let p = api.projects().await.unwrap()[0].id.clone();
    let work = tree("FROM rust:1.97\nCMD [\"api\"]\n");
    let went = attempt(
        &api,
        &p,
        Some(&work),
        "research-f1",
        &api_image(),
        DeskBuild::default(),
        Duration::from_millis(50),
    )
    .await;
    let _ = std::fs::remove_dir_all(&work);
    let Followed::Later(state) = went else {
        panic!("it should not have finished yet: {went:?}")
    };
    let id = state.images[0].id.clone();
    assert_ne!(api.image(&id).await.unwrap().build_status, "done");
    let builds = uploads_and_builds(&emu).1;

    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(api.image(&id).await.unwrap().build_status, "done");
    let small = smallest(&api.hardware(&p).await.unwrap()).unwrap().clone();
    let app = api
        .put_application(
            &p,
            "env-dev",
            &[ServiceBody {
                name: "api".into(),
                image_id: id,
                hardware_configuration_id: small.id,
                volumes: vec![],
                ports: vec![],
                environment_variables: vec![],
            }],
            FAST,
            &quiet,
        )
        .await
        .unwrap();
    assert_eq!(app.services[0].status, "running");
    assert_eq!(uploads_and_builds(&emu).1, builds, "nothing built again");
}

#[tokio::test]
async fn a_call_that_never_reaches_research_is_asked_again_then_says_so() {
    // Nothing listens on port 9 of this machine.
    let api = ResearchApi::new(
        reqwest::Client::new(),
        "http://127.0.0.1:9/api/platform-account/v1",
        "rk-x".into(),
    )
    .with_net_retry(NetRetry {
        tries: 2,
        first: Duration::from_millis(1),
    });
    let e = format!("{:#}", api.projects().await.unwrap_err());
    assert!(e.contains(NOT_REACHED), "{e}");
    assert_eq!(
        crate::environments::failure_code_for_tests(&e, "images"),
        "RESEARCH_UNAVAILABLE",
        "{e}"
    );
}

#[tokio::test]
async fn a_service_start_longer_than_an_attempt_goes_on_in_the_next_and_says_where_it_runs_on_the_emulator()
 {
    // The deploy's half of research-faa4fdf8107a: Research starts services
    // for up to fifteen minutes, longer than the run queue's lease. Here an
    // attempt follows the start for 100 ms and the start takes 600 ms.
    let (url, emu) = spawn_for_tests(Timings {
        desk: Duration::ZERO,
        build: Duration::ZERO,
        start: Duration::from_millis(600),
    })
    .await;
    let api = signed_in(&url).await;
    let p = api.projects().await.unwrap()[0].id.clone();
    let work = tree("FROM rust:1.97\nCMD [\"api\"]\n");
    let built = api
        .build_in_desk(&p, &work, "research-d1", &api_image(), FAST, &quiet, &never)
        .await
        .unwrap();
    let _ = std::fs::remove_dir_all(&work);
    let small = smallest(&api.hardware(&p).await.unwrap()).unwrap().clone();
    let body = ServiceBody {
        name: "api".into(),
        image_id: built[0].id.clone(),
        hardware_configuration_id: small.id,
        volumes: vec![],
        ports: vec![PortBody {
            number: 8080,
            expose_to_internet: true,
        }],
        environment_variables: vec![],
    };

    let put = api
        .put_services(&p, "env-dev", &[body], FAST, &quiet)
        .await
        .unwrap();
    let mut state: AppDeploy = put;
    let mut attempts = 0;
    let app = loop {
        attempts += 1;
        assert!(attempts < 50, "it never started");
        // What one attempt keeps on the run, read back by the next.
        state = serde_json::from_str(&serde_json::to_string(&state).unwrap()).unwrap();
        let until = tokio::time::Instant::now() + Duration::from_millis(100);
        if let Some(app) = api.follow_start(&state, FAST, until, &quiet).await.unwrap() {
            break app;
        }
    };
    assert!(
        attempts >= 3,
        "the start outlasted its attempts: {attempts}"
    );
    assert_eq!(
        emu.state_for_tests().services.len(),
        1,
        "the service was put once"
    );
    assert_eq!(app.services[0].status, "running");
    let links = app.links();
    assert_eq!(links.len(), 1);
    assert!(links[0].starts_with(&format!("{url}/_apps/")), "{links:?}");
}

#[tokio::test]
async fn each_image_of_a_build_says_what_research_says_of_it_on_the_emulator() {
    use crate::environments::research_images::{ImageStatus, image_state, image_states};
    // As a Research build records an image (`research_app::image_reference`).
    let image_reference =
        |bake: &str, name: &str, id: &str| format!("research-image/{bake}/{name}:{id}");

    let (url, emu) = spawn_for_tests(instant()).await;
    let api = signed_in(&url).await;
    let p = api.projects().await.unwrap()[0].id.clone();

    let work = tree("FROM rust:1.97\nCMD [\"api\"]\n");
    let built = api
        .build_in_desk(&p, &work, "research-i1", &api_image(), FAST, &quiet, &never)
        .await
        .unwrap();
    let _ = std::fs::remove_dir_all(&work);
    let work = tree("FROM rust:1.97\n# research-emulator: fail\nRUN cargo build\n");
    let _ = api
        .build_in_desk(&p, &work, "research-i2", &api_image(), FAST, &quiet, &never)
        .await;
    let _ = std::fs::remove_dir_all(&work);
    let (failed, building) = {
        let mut st = emu.state_for_tests();
        let failed = st
            .images
            .values()
            .find(|i| i.fails.is_some())
            .map(|i| i.id.clone())
            .expect("the failed image");
        // One still building: started an hour from now.
        let mut b = st.images[&built[0].id].clone();
        b.id = "img-building".into();
        b.started_ms = u64::MAX / 2;
        st.images.insert(b.id.clone(), b);
        (failed, "img-building".to_owned())
    };

    let images = vec![
        (
            "api".to_owned(),
            image_reference("b1", "gbx-api", &built[0].id),
        ),
        ("ui".to_owned(), image_reference("b2", "gbx-ui", &failed)),
        (
            "worker".to_owned(),
            image_reference("b3", "gbx-worker", &building),
        ),
        (
            "gone".to_owned(),
            image_reference("b4", "gbx-gone", "img-removed"),
        ),
        ("db".to_owned(), "ghcr.io/acme/db:1".to_owned()),
    ];
    let states = image_states(&api, &images).await;
    let status: Vec<(&str, ImageStatus)> =
        states.iter().map(|s| (s.app.as_str(), s.status)).collect();
    assert_eq!(
        status,
        [
            ("api", ImageStatus::Built),
            ("ui", ImageStatus::Failed),
            ("worker", ImageStatus::Building),
            ("gone", ImageStatus::Missing),
            ("db", ImageStatus::Missing),
        ]
    );
    let why = states[1].message.as_deref().unwrap_or_default();
    assert!(
        why.contains("research-emulator: fail") || why.contains("Error"),
        "{why}"
    );
    assert_eq!(states[0].research_id.as_deref(), Some(built[0].id.as_str()));
    assert_eq!(states[0].message, None);

    // Research out of reach: unknown, with why -- never "missing".
    let away = ResearchApi::new(
        reqwest::Client::new(),
        "http://127.0.0.1:9/api/platform-account/v1",
        "rk-x".into(),
    )
    .with_net_retry(NetRetry {
        tries: 0,
        first: Duration::ZERO,
    });
    let s = image_state(&away, "api", &images[0].1).await;
    assert_eq!(s.status, ImageStatus::Unknown);
    assert!(
        s.message
            .as_deref()
            .unwrap_or_default()
            .contains(NOT_REACHED),
        "{s:?}"
    );
}
