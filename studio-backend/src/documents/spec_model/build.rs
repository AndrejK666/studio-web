//! One build of a project's model: the documents nobody has extracted at
//! their current revision are read by a model on the key of the member who
//! asked (`docs/spec-domain-model.md`, "A person's key, never Studio's").
//!
//! WHY NOT A studio-tasks RUN. A run is executed by the queue worker, which
//! acts as `studio-tasks` and never as the person who asked
//! (`tasks/dispatch.rs`), and a model is reached only on a person's key. So a
//! build runs in this process under the caller's context, like a long
//! request. What it costs to lose one is small: every document finished is
//! kept by revision, and the next build starts where this one stopped.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use time::OffsetDateTime;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::extract::{self, Extraction};
use crate::llm_proxy::port::{CompletionError, ModelProviders};

/// Where a project's build is, as this process knows it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BuildState {
    pub running: bool,
    /// Documents this build has to read.
    pub documents: usize,
    pub done: usize,
    pub current: Option<String>,
    /// Why the build stopped, when it did not finish: no key, most often.
    pub error: Option<String>,
    pub started_at: Option<OffsetDateTime>,
    pub finished_at: Option<OffsetDateTime>,
}

static BUILDS: LazyLock<Mutex<HashMap<Uuid, BuildState>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// The project's build as this process knows it; the default when it never
/// ran one here.
pub fn state(project_id: Uuid) -> BuildState {
    BUILDS
        .lock()
        .map(|b| b.get(&project_id).cloned().unwrap_or_default())
        .unwrap_or_default()
}

/// Mark a build started; `false` when one is already running for the
/// project, which is then left alone.
pub fn begin(project_id: Uuid, documents: usize) -> bool {
    let Ok(mut builds) = BUILDS.lock() else {
        return false;
    };
    if builds.get(&project_id).is_some_and(|b| b.running) {
        return false;
    }
    builds.insert(
        project_id,
        BuildState {
            running: true,
            documents,
            started_at: Some(OffsetDateTime::now_utc()),
            ..BuildState::default()
        },
    );
    true
}

pub fn update(project_id: Uuid, change: impl FnOnce(&mut BuildState)) {
    if let Ok(mut builds) = BUILDS.lock()
        && let Some(state) = builds.get_mut(&project_id)
    {
        change(state);
    }
}

pub fn finish(project_id: Uuid, error: Option<String>) {
    update(project_id, |s| {
        s.running = false;
        s.current = None;
        s.error = error;
        s.finished_at = Some(OffsetDateTime::now_utc());
    });
}

/// What reading one document gave.
pub struct Read {
    pub extraction: Extraction,
    /// Why a piece could not be read, when one could not.
    pub error: Option<String>,
    pub provider: String,
    pub model: String,
}

/// Why a build cannot go on at all.
pub struct Stop(pub String);

/// Read one document piece by piece. A piece whose answer is unreadable is
/// asked once more and then given up, with the reason kept; the caller having
/// no key stops the build, since every other document would fail the same way.
pub async fn read_document(
    models: &dyn ModelProviders,
    ctx: &SecurityContext,
    path: &str,
    doc_type: Option<&str>,
    text: &str,
) -> Result<Read, Stop> {
    let pieces = extract::chunks(text);
    let total = pieces.len();
    let mut read = Read {
        extraction: Extraction::default(),
        error: None,
        provider: String::new(),
        model: String::new(),
    };
    for (i, piece) in pieces.iter().enumerate() {
        let request = extract::request(path, doc_type, piece, (i + 1, total));
        let mut last_error = None;
        for _attempt in 0..2 {
            match models.complete(ctx, &request).await {
                Ok(answer) => {
                    read.provider = answer.provider;
                    read.model = answer.model;
                    match extract::read_answer(path, piece, &answer.text) {
                        Ok(got) => {
                            read.extraction.facts.extend(got.facts);
                            read.extraction.dropped += got.dropped;
                            last_error = None;
                            break;
                        }
                        Err(e) => last_error = Some(e),
                    }
                }
                Err(CompletionError::NoKey(message)) => return Err(Stop(message)),
                Err(CompletionError::Failed(e)) => last_error = Some(format!("{e:#}")),
            }
        }
        if let Some(e) = last_error {
            read.error = Some(format!(
                "lines {}-{}: {e}",
                piece.first_line,
                piece.last_line()
            ));
        }
    }
    Ok(read)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm_proxy::port::{Completion, CompletionRequest, ModelInfo};
    use async_trait::async_trait;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Scripted {
        answers: Vec<Result<&'static str, &'static str>>,
        calls: AtomicUsize,
    }

    #[async_trait]
    impl ModelProviders for Scripted {
        async fn list_models(
            &self,
            _: &str,
            _: Option<&str>,
            _: &str,
        ) -> anyhow::Result<Vec<ModelInfo>> {
            Ok(Vec::new())
        }

        async fn complete(
            &self,
            _: &SecurityContext,
            _: &CompletionRequest,
        ) -> Result<Completion, CompletionError> {
            let i = self.calls.fetch_add(1, Ordering::SeqCst);
            match self
                .answers
                .get(i)
                .copied()
                .unwrap_or(Err("no more answers"))
            {
                Ok(text) => Ok(Completion {
                    provider: "anthropic".into(),
                    model: "m".into(),
                    text: text.into(),
                }),
                Err("nokey") => Err(CompletionError::NoKey("add a key in your profile".into())),
                Err(e) => Err(CompletionError::Failed(anyhow::anyhow!(e))),
            }
        }
    }

    fn ctx() -> SecurityContext {
        SecurityContext::builder()
            .subject_id(Uuid::from_u128(0xca7))
            .subject_type("user")
            .subject_tenant_id(Uuid::from_u128(0x0e9))
            .build()
            .expect("security context")
    }

    const TEXT: &str = "# T\n\nThe gateway rejects every request without a tenant header.\n";
    const GOOD: &str = r#"{"facts":[{"kind":"constraint","subject":"gateway","text":"t","status":"active","line_start":3,"line_end":3,"quote":"rejects every request without a tenant header"}]}"#;

    #[tokio::test]
    async fn an_unreadable_answer_is_asked_again_once() {
        let models = Scripted {
            answers: vec![Ok("sorry"), Ok(GOOD)],
            calls: AtomicUsize::new(0),
        };
        let read = read_document(&models, &ctx(), "d.md", None, TEXT)
            .await
            .ok()
            .unwrap();
        assert_eq!(read.extraction.facts.len(), 1);
        assert!(read.error.is_none());
        assert_eq!(read.provider, "anthropic");
    }

    #[tokio::test]
    async fn a_piece_that_fails_twice_is_kept_as_an_error() {
        let models = Scripted {
            answers: vec![Err("503"), Err("503")],
            calls: AtomicUsize::new(0),
        };
        let read = read_document(&models, &ctx(), "d.md", None, TEXT)
            .await
            .ok()
            .unwrap();
        assert!(read.extraction.facts.is_empty());
        assert!(read.error.unwrap().contains("503"));
    }

    #[tokio::test]
    async fn no_key_stops_the_build() {
        let models = Scripted {
            answers: vec![Err("nokey")],
            calls: AtomicUsize::new(0),
        };
        let stop = read_document(&models, &ctx(), "d.md", None, TEXT)
            .await
            .err()
            .unwrap();
        assert!(stop.0.contains("key"));
    }

    #[test]
    fn a_second_build_of_the_same_project_waits_for_the_first() {
        let project = Uuid::new_v4();
        assert!(begin(project, 3));
        assert!(!begin(project, 3));
        update(project, |s| s.done = 2);
        assert_eq!(state(project).done, 2);
        finish(project, None);
        assert!(!state(project).running);
        assert!(begin(project, 1));
    }
}
