//! What GitLab builds keep: job artifacts and releases, as Studio's outputs
//! (the Artifacts tab, ADR-0045), and the links that download them.
//!
//! **Release ids.** GitLab keys a release by its tag; its REST API gives a
//! release no number. Studio's [`RemoteRelease::id`] is an `i64`, so a
//! GitLab release's id is [`release_id`]: the first eight bytes of the
//! SHA-256 of the tag name, big-endian, with the sign bit cleared. It is
//! stable for as long as the tag keeps its name, distinct across the tags of
//! a repository for any practical purpose, and computable again from the tag
//! alone. A release's files are its asset links, keyed by the link's own id.
//!
//! **Build artifacts.** GitLab keeps one artifacts archive per job, so a
//! job with an archive is one [`RemoteBuildArtifact`]: the job's id, the
//! job's name (a job named `studio-build` carries a pipeline's manifest,
//! ADR-0048 §4), the archive's size, and its pipeline as the run.
//!
//! **Downloads.** GitLab on object storage answers an artifact download with
//! a 302 to a short-lived signed link, which is handed out as GitHub's is.
//! A GitLab that serves the file itself (local storage, or proxied object
//! storage) has no such link; [`DownloadNeedsProxy`] says so, and Studio
//! then streams the file through its own authenticated route with the
//! connection's token, which never reaches the browser.

use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::super::driver::{
    DownloadNeedsProxy, RemoteBuildArtifact, RemoteRelease, RemoteReleaseAsset,
};

/// `GET /projects/:id/releases`.
#[derive(Deserialize)]
pub(super) struct Release {
    pub tag_name: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub released_at: Option<String>,
    /// Released in the future: GitLab's nearest thing to a pre-release.
    #[serde(default)]
    pub upcoming_release: bool,
    #[serde(rename = "_links", default)]
    pub links: Option<ReleaseLinks>,
    #[serde(default)]
    pub assets: ReleaseAssets,
}

#[derive(Deserialize, Default)]
pub(super) struct ReleaseLinks {
    #[serde(rename = "self", default)]
    pub self_url: Option<String>,
}

#[derive(Deserialize, Default)]
pub(super) struct ReleaseAssets {
    #[serde(default)]
    pub links: Vec<AssetLink>,
}

#[derive(Deserialize, Clone)]
pub(super) struct AssetLink {
    pub id: i64,
    pub name: String,
    #[serde(default)]
    pub url: Option<String>,
    /// The permanent link GitLab redirects to `url` from (13.x+).
    #[serde(default)]
    pub direct_asset_url: Option<String>,
    #[serde(default)]
    pub link_type: Option<String>,
}

impl AssetLink {
    /// Where the file is: the permanent link where GitLab gives one.
    pub fn target(&self) -> Option<&str> {
        self.direct_asset_url
            .as_deref()
            .or(self.url.as_deref())
            .filter(|u| !u.trim().is_empty())
    }
}

/// A GitLab release's id: see the module comment.
pub(super) fn release_id(tag: &str) -> i64 {
    let digest = Sha256::digest(tag.as_bytes());
    let mut first = [0u8; 8];
    first.copy_from_slice(&digest[..8]);
    (u64::from_be_bytes(first) & (i64::MAX as u64)) as i64
}

impl Release {
    pub fn into_remote(self) -> RemoteRelease {
        RemoteRelease {
            id: release_id(&self.tag_name),
            name: self.name.filter(|n| !n.trim().is_empty()),
            draft: false,
            prerelease: self.upcoming_release,
            url: self.links.and_then(|l| l.self_url),
            created_at: self.created_at,
            published_at: self.released_at,
            assets: self
                .assets
                .links
                .into_iter()
                .filter(|l| !l.name.trim().is_empty())
                .map(|l| RemoteReleaseAsset {
                    id: l.id,
                    name: l.name,
                    size: None,
                    content_type: l.link_type,
                    download_count: None,
                })
                .collect(),
            tag: self.tag_name,
        }
    }
}

/// `GET /projects/:id/jobs`.
#[derive(Deserialize)]
pub(super) struct Job {
    pub id: i64,
    pub name: String,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(rename = "ref", default)]
    pub git_ref: Option<String>,
    #[serde(default)]
    pub artifacts_file: Option<ArtifactsFile>,
    #[serde(default)]
    pub artifacts: Vec<JobArtifact>,
    #[serde(default)]
    pub artifacts_expire_at: Option<String>,
    #[serde(default)]
    pub pipeline: Option<JobPipeline>,
}

#[derive(Deserialize)]
pub(super) struct ArtifactsFile {
    #[serde(default)]
    pub size: Option<i64>,
}

#[derive(Deserialize)]
pub(super) struct JobArtifact {
    pub file_type: String,
    #[serde(default)]
    pub size: Option<i64>,
}

#[derive(Deserialize)]
pub(super) struct JobPipeline {
    pub id: i64,
    #[serde(default)]
    pub sha: Option<String>,
}

impl Job {
    /// The job's archive as an output, `None` for a job that kept none.
    /// `now` decides whether it has expired.
    pub fn into_artifact(self, now: chrono::DateTime<chrono::Utc>) -> Option<RemoteBuildArtifact> {
        let archive = self.artifacts.iter().find(|a| a.file_type == "archive");
        if archive.is_none() && self.artifacts_file.is_none() {
            return None;
        }
        let size = archive
            .and_then(|a| a.size)
            .or_else(|| self.artifacts_file.as_ref().and_then(|f| f.size));
        let expired = self
            .artifacts_expire_at
            .as_deref()
            .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
            .is_some_and(|at| at < now);
        Some(RemoteBuildArtifact {
            id: self.id,
            name: self.name,
            size_in_bytes: size,
            expired,
            created_at: self.created_at,
            expires_at: self.artifacts_expire_at,
            run_id: self.pipeline.as_ref().map(|p| p.id),
            branch: self.git_ref,
            sha: self.pipeline.and_then(|p| p.sha),
        })
    }
}

/// The refusal [`super::GitLabDriver`] answers a download link with when
/// GitLab serves the file itself.
pub(super) fn needs_proxy() -> anyhow::Error {
    DownloadNeedsProxy { provider: "GitLab" }.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_release_id_is_its_tag_s_and_stays_positive() {
        assert_eq!(release_id("v1.2.0"), release_id("v1.2.0"));
        assert_ne!(release_id("v1.2.0"), release_id("v1.2.1"));
        assert!(release_id("v1.2.0") >= 0);
        assert!(release_id("") >= 0);
    }

    #[test]
    fn a_job_without_an_archive_is_no_artifact_and_an_old_one_has_expired() {
        let job = |v: serde_json::Value| serde_json::from_value::<Job>(v).unwrap();
        let now = chrono::DateTime::parse_from_rfc3339("2026-11-24T00:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        assert!(
            job(serde_json::json!({ "id": 1, "name": "lint", "artifacts": [] }))
                .into_artifact(now)
                .is_none()
        );
        let kept = job(serde_json::json!({
            "id": 2, "name": "studio-build", "ref": "main",
            "artifacts": [
                { "file_type": "trace", "size": 9 },
                { "file_type": "archive", "size": 1234 }
            ],
            "artifacts_expire_at": "2026-11-01T00:00:00Z",
            "pipeline": { "id": 77, "sha": "abc" }
        }))
        .into_artifact(now)
        .unwrap();
        assert_eq!((kept.id, kept.name.as_str()), (2, "studio-build"));
        assert_eq!(kept.size_in_bytes, Some(1234));
        assert!(kept.expired);
        assert_eq!(kept.run_id, Some(77));
        assert_eq!(kept.sha.as_deref(), Some("abc"));
    }
}
