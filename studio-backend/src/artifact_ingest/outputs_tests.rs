use serde_json::json;

use super::*;

fn artifact(id: &str, run: Option<&str>, at: &str) -> Output {
    output_of(
        OutputKind::BuildArtifact,
        id,
        &json!({
            "external_id": "70",
            "repo_full_path": "o/r",
            "title": "dist",
            "run": run,
            "created_at": at,
        }),
    )
    .unwrap()
}

fn release() -> Output {
    output_of(
        OutputKind::Release,
        "rel",
        &json!({
            "external_id": "3",
            "repo_full_path": "o/r",
            "title": "v1.0.0",
            "tag": "v1.0.0",
            "published_at": "2026-10-18T10:00:00Z",
            "assets": [{ "id": "30", "name": "app.zip", "size": 10 }, { "name": "no id" }],
        }),
    )
    .unwrap()
}

#[test]
fn a_node_without_the_providers_id_is_not_an_output() {
    assert!(output_of(OutputKind::Release, "x", &json!({ "title": "t" })).is_none());
}

#[test]
fn a_release_reads_its_assets_and_skips_one_without_an_id() {
    let r = release();
    assert_eq!(r.assets.len(), 1);
    assert_eq!(r.assets[0].name, "app.zip");
    assert_eq!(r.at(), Some("2026-10-18T10:00:00Z"));
}

#[test]
fn outputs_are_newest_first_and_narrow_to_a_run() {
    let all = filter(
        vec![
            artifact("a", Some("run-1"), "2026-10-17T00:00:00Z"),
            release(),
            artifact("b", Some("run-2"), "2026-10-19T00:00:00Z"),
        ],
        None,
    );
    let ids: Vec<&str> = all.iter().map(|o| o.id.as_str()).collect();
    assert_eq!(ids, ["b", "rel", "a"]);
    let one = filter(all, Some("run-1"));
    assert_eq!(one.len(), 1);
    assert_eq!(one[0].id, "a");
}

#[test]
fn an_artifact_downloads_by_its_id_through_its_repository() {
    assert_eq!(
        download_target(&artifact("a", None, "t"), None),
        Ok(("o/r".to_owned(), DownloadTarget::BuildArtifact(70)))
    );
    assert_eq!(
        download_target(&artifact("a", None, "t"), Some("30")),
        Err(NotDownloadable::AssetOnArtifact)
    );
    let mut expired = artifact("a", None, "t");
    expired.expired = true;
    assert_eq!(
        download_target(&expired, None),
        Err(NotDownloadable::Expired)
    );
    let mut old = artifact("a", None, "t");
    old.repo_full_path = None;
    assert_eq!(
        download_target(&old, None),
        Err(NotDownloadable::NoRepository)
    );
}

#[test]
fn a_release_downloads_one_of_its_own_assets_only() {
    let r = release();
    assert_eq!(
        download_target(&r, Some("30")),
        Ok(("o/r".to_owned(), DownloadTarget::ReleaseAsset(30)))
    );
    assert_eq!(download_target(&r, None), Err(NotDownloadable::NoAsset));
    assert_eq!(
        download_target(&r, Some("31")),
        Err(NotDownloadable::UnknownAsset("31".into()))
    );
}
