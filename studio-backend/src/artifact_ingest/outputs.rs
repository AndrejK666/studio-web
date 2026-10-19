//! What a project's builds produced: the files CI runs kept and the
//! repositories' releases, read back for the Artifacts tab.
//!
//! The sync keeps each as a node (`build_artifact`, `release`) with only its
//! description; the bytes stay with the provider. A download is a link the
//! provider signs for a minute, asked for through the project's own
//! connection when someone clicks — so Studio never holds or streams a file
//! and a link in a page never outlives the click.

use serde_json::Value;

use crate::connectors::sdk::DownloadTarget;

/// Which of the two an output is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputKind {
    BuildArtifact,
    Release,
}

impl OutputKind {
    /// The node type leaf it is kept under, and its name on the wire.
    pub fn leaf(self) -> &'static str {
        match self {
            Self::BuildArtifact => "build_artifact",
            Self::Release => "release",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.trim() {
            "build_artifact" => Some(Self::BuildArtifact),
            "release" => Some(Self::Release),
            _ => None,
        }
    }
}

/// A file attached to a release.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Asset {
    /// The provider's id: what a download names.
    pub id: String,
    pub name: String,
    pub size: Option<i64>,
    pub content_type: Option<String>,
    pub download_count: Option<i64>,
}

/// One output as the sync kept it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Output {
    /// The node id.
    pub id: String,
    pub kind: OutputKind,
    /// The repo node it belongs to.
    pub repo: Option<String>,
    /// `owner/name`: what a download is asked through.
    pub repo_full_path: Option<String>,
    /// The provider's id of the artifact or the release.
    pub external_id: String,
    /// An artifact's name; a release's name, else its tag.
    pub title: String,
    pub size_in_bytes: Option<i64>,
    /// The provider dropped the artifact: listed, no longer downloadable.
    pub expired: bool,
    /// The run node that kept an artifact (the `/runs` id).
    pub run: Option<String>,
    pub branch: Option<String>,
    pub sha: Option<String>,
    pub tag: Option<String>,
    pub draft: bool,
    pub prerelease: bool,
    pub url: Option<String>,
    pub assets: Vec<Asset>,
    pub created_at: Option<String>,
    pub expires_at: Option<String>,
    pub published_at: Option<String>,
}

fn s(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_string)
}

fn b(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// A node's payload as an output; `None` without the provider's id.
pub fn output_of(kind: OutputKind, id: &str, v: &Value) -> Option<Output> {
    let external_id = s(v, "external_id")?;
    let assets = v
        .get("assets")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|a| {
                    Some(Asset {
                        id: s(a, "id")?,
                        name: s(a, "name").unwrap_or_default(),
                        size: a.get("size").and_then(Value::as_i64),
                        content_type: s(a, "content_type"),
                        download_count: a.get("download_count").and_then(Value::as_i64),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(Output {
        id: id.to_string(),
        kind,
        repo: s(v, "repo"),
        repo_full_path: s(v, "repo_full_path"),
        title: s(v, "title").unwrap_or_else(|| external_id.clone()),
        external_id,
        size_in_bytes: v.get("size_in_bytes").and_then(Value::as_i64),
        expired: b(v, "expired"),
        run: s(v, "run"),
        branch: s(v, "branch"),
        sha: s(v, "sha"),
        tag: s(v, "tag"),
        draft: b(v, "draft"),
        prerelease: b(v, "prerelease"),
        url: s(v, "url"),
        assets,
        created_at: s(v, "created_at"),
        expires_at: s(v, "expires_at"),
        published_at: s(v, "published_at"),
    })
}

impl Output {
    /// When it appeared: a release when it was published, an artifact when
    /// its run kept it.
    pub fn at(&self) -> Option<&str> {
        self.published_at.as_deref().or(self.created_at.as_deref())
    }
}

/// The outputs of one run, or all of them, newest first.
pub fn filter(mut outputs: Vec<Output>, run: Option<&str>) -> Vec<Output> {
    if let Some(run) = run.map(str::trim).filter(|r| !r.is_empty()) {
        outputs.retain(|o| o.run.as_deref() == Some(run));
    }
    outputs.sort_by(|a, b| b.at().cmp(&a.at()).then(b.id.cmp(&a.id)));
    outputs
}

/// Why a download cannot be asked for.
#[derive(Debug, PartialEq, Eq)]
pub enum NotDownloadable {
    /// The output does not say which repository it is in (a node an older
    /// sync wrote): the next sync fixes it.
    NoRepository,
    Expired,
    /// A release is downloaded one asset at a time.
    NoAsset,
    /// The release has no such asset.
    UnknownAsset(String),
    /// An artifact has no assets to name.
    AssetOnArtifact,
}

impl std::fmt::Display for NotDownloadable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoRepository => {
                f.write_str("the output does not say its repository yet; sync the project again")
            }
            Self::Expired => f.write_str("the provider no longer keeps this artifact"),
            Self::NoAsset => f.write_str("name the release's file with asset_id"),
            Self::UnknownAsset(id) => write!(f, "the release has no file {id}"),
            Self::AssetOnArtifact => {
                f.write_str("a CI artifact has no files to pick: drop asset_id")
            }
        }
    }
}

/// What to ask the provider for, and through which repository.
pub fn download_target(
    output: &Output,
    asset: Option<&str>,
) -> Result<(String, DownloadTarget), NotDownloadable> {
    let repo = output
        .repo_full_path
        .clone()
        .filter(|r| !r.trim().is_empty())
        .ok_or(NotDownloadable::NoRepository)?;
    let asset = asset.map(str::trim).filter(|a| !a.is_empty());
    let numeric = |id: &str| id.parse::<i64>().ok();
    match output.kind {
        OutputKind::BuildArtifact => {
            if asset.is_some() {
                return Err(NotDownloadable::AssetOnArtifact);
            }
            if output.expired {
                return Err(NotDownloadable::Expired);
            }
            let id = numeric(&output.external_id).ok_or(NotDownloadable::NoRepository)?;
            Ok((repo, DownloadTarget::BuildArtifact(id)))
        }
        OutputKind::Release => {
            let asset = asset.ok_or(NotDownloadable::NoAsset)?;
            let id = output
                .assets
                .iter()
                .find(|a| a.id == asset)
                .and_then(|a| numeric(&a.id))
                .ok_or_else(|| NotDownloadable::UnknownAsset(asset.to_string()))?;
            Ok((repo, DownloadTarget::ReleaseAsset(id)))
        }
    }
}

#[cfg(test)]
#[path = "outputs_tests.rs"]
mod tests;
