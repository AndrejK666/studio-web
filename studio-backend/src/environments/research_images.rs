//! What Constructor Research says of each image of a build, now: built,
//! still building, failed (with Research's words), gone -- or unknown, when
//! Research cannot be asked. A Research build's record says only that the
//! build asked for its images; whether they can run is Research's to say,
//! and the Releases page's Images stage and a deploy of a build's images
//! both ask it here.

use std::time::Duration;

use crate::connectors::sdk::research::ResearchApi;

use super::research_app;

/// How long Studio waits for Research to say how one image is.
const READ_FOR: Duration = Duration::from_secs(10);

/// How much of a failed build's log a status carries.
const LOG_LINES: usize = 5;

/// An image's state as Research says it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageStatus {
    /// Built, and still in Research: a deploy can run it.
    Built,
    /// Research is still building it.
    Building,
    /// Research could not build it.
    Failed,
    /// Research has no such image (removed, or never one Research built).
    Missing,
    /// Research could not be asked, or did not answer in time.
    Unknown,
}

impl ImageStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Built => "built",
            Self::Building => "building",
            Self::Failed => "failed",
            Self::Missing => "missing",
            Self::Unknown => "unknown",
        }
    }
}

/// One image of a build and its state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageState {
    pub app: String,
    /// The reference the build recorded.
    pub reference: String,
    /// The image's name and Research's id, when the reference is one of
    /// Research's.
    pub name: Option<String>,
    pub research_id: Option<String>,
    pub status: ImageStatus,
    /// Research's words: why it failed, why it is missing, why Studio could
    /// not ask.
    pub message: Option<String>,
}

impl ImageState {
    /// Every image of a build as `unknown`, for `why` (no sign-in, no
    /// connection): what is shown when Research cannot be asked at all.
    pub fn unknown(app: &str, reference: &str, why: &str) -> Self {
        let r = research_app::image_ref(reference);
        Self {
            app: app.to_owned(),
            reference: reference.to_owned(),
            name: r.as_ref().map(|r| r.name.clone()),
            research_id: r.map(|r| r.id),
            status: ImageStatus::Unknown,
            message: Some(why.to_owned()),
        }
    }

    /// What a deploy of the build says of it when it is not built.
    pub fn line(&self) -> String {
        let name = self.name.as_deref().unwrap_or(&self.app);
        match &self.message {
            Some(m) => format!("{name} ({}: {m})", self.status.as_str()),
            None => format!("{name} ({})", self.status.as_str()),
        }
    }
}

/// Research's `build_status` as an [`ImageStatus`].
pub fn status_of(build_status: &str) -> ImageStatus {
    match build_status {
        "done" => ImageStatus::Built,
        "error" | "failed" => ImageStatus::Failed,
        _ => ImageStatus::Building,
    }
}

/// Whether a refusal says the image is not there.
fn not_there(e: &str) -> bool {
    e.to_ascii_lowercase().contains("not found")
}

/// What Research says of the image `reference` (of application `app`),
/// asked through `api` and answered within [`READ_FOR`].
pub async fn image_state(api: &ResearchApi, app: &str, reference: &str) -> ImageState {
    let Some(image) = research_app::image_ref(reference) else {
        return ImageState {
            app: app.to_owned(),
            reference: reference.to_owned(),
            name: None,
            research_id: None,
            status: ImageStatus::Missing,
            message: Some("not an image Constructor Research built".into()),
        };
    };
    let mut state = ImageState {
        app: app.to_owned(),
        reference: reference.to_owned(),
        name: Some(image.name.clone()),
        research_id: Some(image.id.clone()),
        status: ImageStatus::Unknown,
        message: None,
    };
    match tokio::time::timeout(READ_FOR, api.image(&image.id)).await {
        Err(_) => {
            state.message = Some(format!(
                "Constructor Research did not answer within {} s",
                READ_FOR.as_secs()
            ));
        }
        Ok(Err(e)) => {
            let e = format!("{e:#}");
            state.status = if not_there(&e) {
                ImageStatus::Missing
            } else {
                ImageStatus::Unknown
            };
            state.message = Some(e);
        }
        Ok(Ok(i)) => {
            state.status = status_of(&i.build_status);
            if state.status == ImageStatus::Failed {
                let tail = tokio::time::timeout(READ_FOR, api.build_log_tail(&image.id, LOG_LINES))
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .flatten();
                state.message = Some(tail.unwrap_or_else(|| {
                    "Constructor Research could not build it and keeps no log of why".into()
                }));
            }
        }
    }
    state
}

/// Every image of a build, asked one after another.
pub async fn image_states(api: &ResearchApi, images: &[(String, String)]) -> Vec<ImageState> {
    let mut out = Vec::with_capacity(images.len());
    for (app, reference) in images {
        out.push(image_state(api, app, reference).await);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn researchs_build_statuses_read_as_what_a_person_acts_on() {
        assert_eq!(status_of("done"), ImageStatus::Built);
        assert_eq!(status_of("error"), ImageStatus::Failed);
        for s in ["not_started", "snapshot_creation", "in_progress", ""] {
            assert_eq!(status_of(s), ImageStatus::Building, "{s}");
        }
        assert!(not_there(
            "Constructor Research refused the image's state: Image not found"
        ));
    }

    #[test]
    fn an_image_research_cannot_be_asked_about_is_unknown_with_why() {
        let s = ImageState::unknown(
            "api",
            "research-image/7d19e2c3026f/gbx-api-gateway:cd9acc99",
            "sign in to Constructor Research",
        );
        assert_eq!(s.status, ImageStatus::Unknown);
        assert_eq!(s.name.as_deref(), Some("gbx-api-gateway"));
        assert_eq!(s.research_id.as_deref(), Some("cd9acc99"));
        assert_eq!(
            s.line(),
            "gbx-api-gateway (unknown: sign in to Constructor Research)"
        );
    }
}
