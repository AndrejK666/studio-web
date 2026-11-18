//! Which gears go into a project's product, as the gears-matcher service
//! reads its specifications (`docs/design/product-gear-match.md`).
//!
//! A person asks for a match; the request is checked as them (they reach the
//! project, its documents are read as they read them) and becomes one
//! `product.gear_match` run on studio-tasks ([`task`]), which submits the
//! documents to the matcher, follows its run and keeps the coverage report
//! with the project ([`store`]). Reading the report for a person -- per
//! requirement its verdict, candidates, evidence, passage and what Studio
//! offers -- is [`report`]. Nothing here changes the product: a proposed gear
//! goes in when a member adds it, through the product's own completion.
//!
//! The matcher is optional. Without its address or secret ([`config`]) every
//! route of the match answers 503 saying which, and nothing else of the
//! product changes.

pub mod client;
pub mod config;
pub mod report;
pub mod store;
pub mod task;

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::{Value, json};
use toolkit::client_hub::{ClientHub, ClientScope};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use client::{Matcher, MatcherError};
use config::MatcherConfig;
use report::SentDocument;
use store::{Change, Match, MatchStore, Note};

/// The matcher's own defaults (`GET /v1/info` `limits`), used when it does
/// not say.
const MAX_DOCUMENTS: usize = 20;
const MAX_DOCUMENT_BYTES: usize = 500_000;
const MAX_REQUEST_BYTES: usize = 2_000_000;

/// How many matches a project's history lists.
pub const HISTORY_MAX: u64 = 50;

/// Why a match was not started or read.
#[derive(Debug)]
pub enum Refusal {
    /// The matcher, the database or a port is not here: 503.
    Unavailable(String),
    /// The caller does not reach the project, or no such match: 404.
    NotFound(String),
    /// The request cannot be served as it is: 400 naming the field.
    Invalid {
        field: &'static str,
        why: String,
    },
    Internal(anyhow::Error),
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(m) | Self::NotFound(m) => f.write_str(m),
            Self::Invalid { field, why } => write!(f, "{field}: {why}"),
            Self::Internal(e) => write!(f, "{e:#}"),
        }
    }
}

impl From<anyhow::Error> for Refusal {
    fn from(e: anyhow::Error) -> Self {
        Self::Internal(e)
    }
}

/// What a person asks a match to read.
#[derive(Debug, Default, Clone)]
pub struct StartRequest {
    pub paths: Vec<String>,
    pub glob: Option<String>,
    /// Gears that are the product itself, never offered as candidates.
    pub own_gears: Vec<String>,
    /// Read documents not in the spec format too, with at most this many
    /// model calls; the deployment's default when absent.
    pub extract_max_calls: Option<u32>,
    pub idempotency_key: Option<String>,
}

/// The matcher, the store and the ports a match needs.
pub struct GearMatches {
    pub config: MatcherConfig,
    pub matcher: Arc<dyn Matcher>,
    store: Option<Arc<MatchStore>>,
    hub: Arc<ClientHub>,
}

impl GearMatches {
    pub fn new(
        config: MatcherConfig,
        matcher: Arc<dyn Matcher>,
        store: Option<Arc<MatchStore>>,
        hub: Arc<ClientHub>,
    ) -> Self {
        Self {
            config,
            matcher,
            store,
            hub,
        }
    }

    pub fn store(&self) -> Result<&Arc<MatchStore>, Refusal> {
        self.store.as_ref().ok_or_else(|| {
            Refusal::Unavailable(
                "gear matches are not kept in this deployment: studio-product has no database"
                    .to_owned(),
            )
        })
    }

    /// The matcher can be called and its reports kept.
    pub fn available(&self) -> Result<&Arc<MatchStore>, Refusal> {
        if let Some(why) = self.matcher.missing() {
            return Err(Refusal::Unavailable(why));
        }
        self.store()
    }

    fn queue(&self) -> Result<Arc<dyn crate::tasks::TaskQueue>, Refusal> {
        self.hub
            .get_scoped::<dyn crate::tasks::TaskQueue>(&ClientScope::gts_id(
                crate::tasks::TASK_QUEUE_INSTANCE_ID,
            ))
            .map_err(|_| {
                Refusal::Unavailable(
                    "a gear match cannot run here: studio-tasks has no database".to_owned(),
                )
            })
    }

    /// Start a match of `project` (in organization `org`) as the caller:
    /// read its specifications as they read them, prepare what is sent, keep
    /// the match and queue its run. The same idempotency key answers the
    /// match it made first.
    pub async fn start(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        project: Uuid,
        product: &str,
        request: StartRequest,
    ) -> Result<Match, Refusal> {
        let store = self.available()?;
        let key = match request.idempotency_key.as_deref().map(str::trim) {
            Some(k) if !k.is_empty() => {
                if !key_ok(k) {
                    return Err(Refusal::Invalid {
                        field: "idempotency_key",
                        why: "1 to 100 characters of letters, digits, `.`, `_`, `:` and `-`".into(),
                    });
                }
                Some(k.to_owned())
            }
            _ => None,
        };
        let id = key.as_deref().map_or_else(Uuid::new_v4, |k| {
            Uuid::new_v5(
                &Uuid::NAMESPACE_OID,
                format!("gear-match:{project}:{k}").as_bytes(),
            )
        });
        if let Some(existing) = store.get(org, project, id).await? {
            return Ok(existing);
        }

        // The service's limits, and the proof that it answers, before
        // anything is read or kept.
        let info = self.matcher.info().await.map_err(|e| match e {
            MatcherError::NotConfigured(m) => Refusal::Unavailable(m),
            other => Refusal::Unavailable(format!("{other}")),
        })?;
        let limit = |k: &str, d: usize| {
            info["limits"][k]
                .as_u64()
                .and_then(|n| usize::try_from(n).ok())
                .unwrap_or(d)
        };
        let (max_docs, max_doc, max_body) = (
            limit("max_documents", MAX_DOCUMENTS),
            limit("max_document_bytes", MAX_DOCUMENT_BYTES),
            limit("max_request_bytes", MAX_REQUEST_BYTES),
        );

        let (texts, unread) = self.spec_texts(ctx, project, &request).await?;
        let nothing_named = request.paths.is_empty() && request.glob.is_none();
        if let Some(why) = unreadable_prds(&texts, &unread, nothing_named) {
            return Err(Refusal::Invalid {
                field: "paths",
                why,
            });
        }
        let mut docs = default_selection(texts, nothing_named);
        if docs.is_empty() {
            return Err(Refusal::Invalid {
                field: "paths",
                why: "the project has no specification to read: write or upload a PRD first".into(),
            });
        }
        if docs.len() > max_docs {
            return Err(Refusal::Invalid {
                field: "paths",
                why: format!(
                    "{} documents selected; the matcher reads at most {max_docs} at once -- name \
                     the PRD and specifications to read with `paths` or `glob`",
                    docs.len()
                ),
            });
        }

        // The project's answers to earlier questions go beside the
        // requirements they answer, in the copy sent.
        let answers = store.notes(org, project, store::NOTE_ANSWER).await?;
        let (by_requirement, general) = split_answers(&answers);
        let mut sent = Vec::with_capacity(docs.len());
        let mut body_docs = Vec::with_capacity(docs.len());
        for (i, d) in docs.drain(..).enumerate() {
            let (mut text, mut answered) = report::with_answers(&d.text, &by_requirement);
            if i == 0 && !general.is_empty() {
                let pairs: Vec<(String, String)> = general
                    .iter()
                    .map(|(topic, answer, _)| (topic.clone(), answer.clone()))
                    .collect();
                text = report::with_general_answers(&text, &pairs);
                answered.extend(general.iter().map(|(_, _, id)| id.clone()));
            }
            if text.len() > max_doc {
                return Err(Refusal::Invalid {
                    field: "paths",
                    why: format!(
                        "{} is {} KB; the matcher reads documents of at most {} KB",
                        d.path,
                        text.len() / 1000,
                        max_doc / 1000
                    ),
                });
            }
            let matcher_path = unique_path(&sent, report::matcher_path(&d.path));
            let sha256 = report::sha256_hex(&text);
            sent.push(SentDocument {
                path: d.path,
                matcher_path: matcher_path.clone(),
                sha256: sha256.clone(),
                bytes: text.len() as u64,
                doc_type: d.doc_type,
                commit: d.commit,
                branch: d.branch,
                answered,
            });
            body_docs.push(json!({ "path": matcher_path, "sha256": sha256, "content": text }));
        }
        let mut options = serde_json::Map::new();
        if let Some(n) = self.config.max_calls {
            options.insert("max_calls".into(), json!(n));
        }
        if let Some(n) = request.extract_max_calls.or(self.config.extract_max_calls) {
            options.insert("extract_max_calls".into(), json!(n.max(1)));
        }
        let mut body = json!({
            "product": product,
            "own_gears": request.own_gears,
            "documents": body_docs,
        });
        if !options.is_empty() {
            body["options"] = Value::Object(options);
        }
        let request_text = body.to_string();
        if request_text.len() > max_body {
            return Err(Refusal::Invalid {
                field: "paths",
                why: format!(
                    "the documents come to {} KB; the matcher takes at most {} KB at once -- \
                     select fewer",
                    request_text.len() / 1000,
                    max_body / 1000
                ),
            });
        }

        let now = store::now_ms();
        let row = Match {
            tenant_id: org,
            project_id: project,
            id,
            run_id: None,
            state: store::QUEUED.to_owned(),
            requested_by: ctx.subject_id().to_string(),
            created_at_ms: now,
            updated_at_ms: now,
            finished_at_ms: None,
            idempotency_key: format!("studio-{id}"),
            product: product.to_owned(),
            documents: serde_json::to_string(&sent).map_err(anyhow::Error::from)?,
            request: request_text,
            matcher_run_id: None,
            info: Some(info_summary(&info).to_string()),
            progress: None,
            report: None,
            totals: None,
            usage: None,
            error: None,
            cancel_requested: false,
        };
        let queue = self.queue()?;
        store.insert(row.clone()).await?;
        let project_key = project.to_string();
        let run = queue
            .enqueue(
                ctx,
                crate::tasks::sdk::NewRun {
                    tenant: org,
                    task_type: task::TASK_TYPE,
                    payload: json!(task::Payload {
                        match_id: id,
                        project_id: project
                    }),
                    partition_key: Some(&project_key),
                    idempotency_key: Some(&row.idempotency_key),
                    coalesce_queued: false,
                    notify_workspace_id: None,
                },
            )
            .await;
        match run {
            Ok(run_id) => {
                store
                    .update(
                        org,
                        project,
                        id,
                        Change {
                            run_id: Some(run_id),
                            ..Change::default()
                        },
                    )
                    .await?;
                Ok(Match {
                    run_id: Some(run_id),
                    ..row
                })
            }
            Err(e) => {
                let why = format!("the match could not be queued: {e:#}");
                store
                    .update(
                        org,
                        project,
                        id,
                        Change {
                            state: Some(store::FAILED),
                            error: Some(why.clone()),
                            finished: true,
                            ..Change::default()
                        },
                    )
                    .await?;
                Err(Refusal::Unavailable(why))
            }
        }
    }

    async fn spec_texts(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        request: &StartRequest,
    ) -> Result<(Vec<crate::documents::port::SpecText>, Vec<String>), Refusal> {
        use crate::documents::port::{SpecTexts, SpecTextsRefused};
        let port = self.hub.get::<dyn SpecTexts>().map_err(|_| {
            Refusal::Unavailable(
                "a project's specifications cannot be read here: studio-documents is not part of \
                 this deployment"
                    .to_owned(),
            )
        })?;
        let read = port
            .spec_texts(ctx, project, &request.paths, request.glob.as_deref())
            .await
            .map_err(|e| match e {
                SpecTextsRefused::NotFound(m) => Refusal::NotFound(m),
                SpecTextsRefused::UnknownSelection(m) => Refusal::Invalid {
                    field: "paths",
                    why: m,
                },
                SpecTextsRefused::Unavailable(m) => Refusal::Unavailable(m),
                SpecTextsRefused::Failed(e) => Refusal::Internal(e),
            })?;
        if !read.unread.is_empty() {
            tracing::info!(
                %project,
                unread = ?read.unread,
                "studio-product: a gear match goes without the documents no checkout holds"
            );
        }
        let documents = read
            .documents
            .into_iter()
            .filter(|d| !d.text.trim().is_empty())
            .collect();
        Ok((documents, read.unread))
    }

    /// The match as it stands, with a run that stopped without telling it
    /// brought up to date: one cancelled or given up on in Background work.
    pub async fn read(&self, org: Uuid, project: Uuid, id: Uuid) -> Result<Match, Refusal> {
        let store = self.store()?;
        let row = store
            .get(org, project, id)
            .await?
            .ok_or_else(|| Refusal::NotFound(format!("the project has no gear match {id}")))?;
        Ok(self.reconcile(store, row).await)
    }

    /// The project's latest match, if any.
    pub async fn latest(&self, org: Uuid, project: Uuid) -> Result<Option<Match>, Refusal> {
        let store = self.store()?;
        match store.list(org, project, 1).await?.into_iter().next() {
            Some(row) => Ok(Some(self.reconcile(store, row).await)),
            None => Ok(None),
        }
    }

    async fn reconcile(&self, store: &MatchStore, row: Match) -> Match {
        if store::is_final(&row.state) {
            return row;
        }
        let (Some(run_id), Ok(queue)) = (row.run_id, self.queue()) else {
            return row;
        };
        let Ok(Some(view)) = queue.run(row.tenant_id, run_id).await else {
            return row;
        };
        use crate::tasks::RunState;
        let (state, error) = match view.state {
            RunState::Cancelled => (store::CANCELLED, None),
            RunState::Failed => (
                store::FAILED,
                Some(
                    view.last_error
                        .unwrap_or_else(|| "the run gave up".to_owned()),
                ),
            ),
            _ => return row,
        };
        // A run stopped from Background work leaves the matcher's run going:
        // stop it too, so it does not spend more calls for nobody.
        if state == store::CANCELLED
            && let Some(mid) = row.matcher_run_id.as_deref()
            && let Err(e) = self.matcher.cancel(mid).await
        {
            tracing::warn!(error = %e, "studio-product: the matcher's run could not be cancelled");
        }
        let change = Change {
            state: Some(state),
            error: error.clone(),
            finished: true,
            ..Change::default()
        };
        if let Err(e) = store
            .update(row.tenant_id, row.project_id, row.id, change)
            .await
        {
            tracing::warn!(error = %e, "studio-product: a stopped gear match could not be recorded");
        }
        Match {
            state: state.to_owned(),
            error: error.or(row.error.clone()),
            finished_at_ms: Some(store::now_ms()),
            ..row
        }
    }

    /// Ask a match to stop: its run, and through it the matcher's.
    pub async fn cancel(&self, org: Uuid, project: Uuid, id: Uuid) -> Result<Match, Refusal> {
        let store = self.store()?;
        let row = self.read(org, project, id).await?;
        if store::is_final(&row.state) {
            return Ok(row);
        }
        store
            .update(
                org,
                project,
                id,
                Change {
                    state: Some(store::CANCELLING),
                    cancel_requested: Some(true),
                    ..Change::default()
                },
            )
            .await?;
        if let Some(run_id) = row.run_id {
            self.queue()?.request_cancel(org, run_id).await?;
        }
        Ok(Match {
            state: store::CANCELLING.to_owned(),
            cancel_requested: true,
            ..row
        })
    }

    /// The project's notes of `kind`, by `(subject, gear_id)`.
    pub async fn notes(
        &self,
        org: Uuid,
        project: Uuid,
        kind: &str,
    ) -> Result<BTreeMap<(String, String), Note>, Refusal> {
        Ok(self
            .store()?
            .notes(org, project, kind)
            .await?
            .into_iter()
            .map(|n| ((n.subject.clone(), n.gear_id.clone()), n))
            .collect())
    }
}

/// A key the matcher's `Idempotency-Key` takes once prefixed.
fn key_ok(k: &str) -> bool {
    !k.is_empty()
        && k.len() <= 100
        && k.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

/// Whether a document is a PRD: typed so, under a `prd/` folder, or named
/// `prd…`.
fn is_prd(path: &str, doc_type: Option<&str>) -> bool {
    let name = path
        .rsplit(['/', ':'])
        .next()
        .unwrap_or(path)
        .to_ascii_lowercase();
    doc_type.is_some_and(|t| t.eq_ignore_ascii_case("prd"))
        || path.to_ascii_lowercase().contains("/prd/")
        || path.to_ascii_lowercase().starts_with("prd/")
        || name.starts_with("prd")
}

/// With nothing named, the PRDs are what is read; when the project has PRDs
/// but none of them could be read (no checkout holds them), why, naming
/// them. Falling back to "everything readable" then sent another document
/// in the PRD's place: on the local stand (2026-11-18) a 9 KB uploaded
/// design note went instead of `docs/prd/constructor-studio.md`, whose
/// repository's branch was gone, and the matcher refused it.
fn unreadable_prds(
    texts: &[crate::documents::port::SpecText],
    unread: &[String],
    nothing_named: bool,
) -> Option<String> {
    if !nothing_named || texts.iter().any(|d| is_prd(&d.path, d.doc_type.as_deref())) {
        return None;
    }
    let prds: Vec<&str> = unread
        .iter()
        .filter(|p| is_prd(p, None))
        .map(String::as_str)
        .collect();
    if prds.is_empty() {
        return None;
    }
    let shown: Vec<&str> = prds.iter().take(3).copied().collect();
    Some(format!(
        "the project's PRD{} {}{} could not be read: the server holds no copy of {} repository \
         (sync the source on the Sources tab, on a branch that exists), or name the documents \
         to read",
        if prds.len() == 1 { "" } else { "s" },
        shown.join(", "),
        if prds.len() > shown.len() {
            format!(" and {} more", prds.len() - shown.len())
        } else {
            String::new()
        },
        if prds.len() == 1 { "its" } else { "their" },
    ))
}

/// With nothing named: the project's PRDs when it has any, else everything.
fn default_selection(
    texts: Vec<crate::documents::port::SpecText>,
    nothing_named: bool,
) -> Vec<crate::documents::port::SpecText> {
    if !nothing_named {
        return texts;
    }
    let is_prd = |d: &crate::documents::port::SpecText| is_prd(&d.path, d.doc_type.as_deref());
    if texts.iter().any(is_prd) {
        texts.into_iter().filter(is_prd).collect()
    } else {
        texts
    }
}

/// A matcher path not used by an earlier document (`-2`, `-3` before `.md`).
fn unique_path(sent: &[SentDocument], path: String) -> String {
    if !sent.iter().any(|d| d.matcher_path == path) {
        return path;
    }
    let stem = path.strip_suffix(".md").unwrap_or(&path).to_owned();
    (2..)
        .map(|n| format!("{stem}-{n}.md"))
        .find(|p| !sent.iter().any(|d| &d.matcher_path == p))
        .unwrap_or(path)
}

/// An answer note's value: `{text, topic}`.
pub fn answer_value(text: &str, topic: Option<&str>) -> String {
    json!({ "text": text, "topic": topic }).to_string()
}

/// An answer note's text and topic.
pub fn answer_of(note: &Note) -> (String, Option<String>) {
    match serde_json::from_str::<Value>(&note.value) {
        Ok(v) => (
            v["text"].as_str().unwrap_or_default().to_owned(),
            v["topic"].as_str().map(str::to_owned),
        ),
        Err(_) => (note.value.clone(), None),
    }
}

/// The answers to requirements (`(id, text)`), and the report's own
/// questions' (`(topic, text, id)`).
#[allow(clippy::type_complexity)]
fn split_answers(notes: &[Note]) -> (Vec<(String, String)>, Vec<(String, String, String)>) {
    let mut by_requirement = Vec::new();
    let mut general = Vec::new();
    for n in notes {
        let (text, topic) = answer_of(n);
        if text.trim().is_empty() {
            continue;
        }
        if n.subject.starts_with("c-") {
            general.push((
                topic.unwrap_or_else(|| n.subject.clone()),
                text,
                n.subject.clone(),
            ));
        } else {
            by_requirement.push((n.subject.clone(), text));
        }
    }
    (by_requirement, general)
}

/// What a match keeps of `GET /v1/info`: the versions and the catalogue.
pub fn info_summary(info: &Value) -> Value {
    json!({
        "service_version": info["service_version"],
        "matcher_version": info["matcher_version"],
        "report_schema_versions": info["report_schema_versions"],
        "catalogue": info["catalogue"],
        "models": info["models"],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::documents::port::SpecText;

    fn doc(path: &str, doc_type: Option<&str>) -> SpecText {
        SpecText {
            path: path.into(),
            text: "x".into(),
            doc_type: doc_type.map(str::to_owned),
            commit: None,
            branch: None,
        }
    }

    #[test]
    fn with_nothing_named_the_prds_are_read_else_everything() {
        let all = vec![
            doc("docs/prd/constructor-studio.md", None),
            doc("docs/design/x.md", Some("design")),
            doc("upload:PRD.md", None),
        ];
        let picked: Vec<String> = default_selection(all.clone(), true)
            .into_iter()
            .map(|d| d.path)
            .collect();
        assert_eq!(
            picked,
            vec!["docs/prd/constructor-studio.md", "upload:PRD.md"]
        );
        assert_eq!(default_selection(all.clone(), false).len(), 3);
        let none = vec![doc("docs/design/x.md", Some("design"))];
        assert_eq!(default_selection(none, true).len(), 1);
    }

    #[test]
    fn a_prd_no_checkout_holds_is_named_not_replaced_by_another_document() {
        let read = vec![doc("studio:f8345044", Some("design"))];
        let unread = vec![
            "docs/adr/0001-identity-mapping.md".to_owned(),
            "docs/prd/constructor-studio.md".to_owned(),
        ];
        let why = unreadable_prds(&read, &unread, true).expect("refused");
        assert!(why.contains("docs/prd/constructor-studio.md"), "{why}");
        assert!(why.contains("Sources"), "{why}");
        // A PRD that was read, documents named, or no PRD anywhere: nothing to say.
        let with_prd = vec![doc("upload:PRD.md", None)];
        assert_eq!(unreadable_prds(&with_prd, &unread, true), None);
        assert_eq!(unreadable_prds(&read, &unread, false), None);
        assert_eq!(
            unreadable_prds(&read, &["docs/adr/0001.md".to_owned()], true),
            None
        );
    }

    #[test]
    fn two_documents_never_share_a_matcher_path() {
        let sent = vec![SentDocument {
            matcher_path: "a.md".into(),
            ..SentDocument::default()
        }];
        assert_eq!(unique_path(&sent, "a.md".into()), "a-2.md");
        assert_eq!(unique_path(&sent, "b.md".into()), "b.md");
    }

    #[test]
    fn a_caller_key_is_checked() {
        assert!(key_ok("2026-11-17:abc_1.2"));
        assert!(!key_ok("a b"));
        assert!(!key_ok(&"k".repeat(101)));
    }

    #[test]
    fn answers_split_into_requirements_and_the_reports_own() {
        let note = |subject: &str, value: String| Note {
            tenant_id: Uuid::nil(),
            project_id: Uuid::nil(),
            kind: store::NOTE_ANSWER.into(),
            subject: subject.into(),
            gear_id: String::new(),
            value,
            author: "a".into(),
            updated_at_ms: 0,
            match_id: None,
        };
        let (reqs, general) = split_answers(&[
            note("cpt-x-fr-a", answer_value("within 2 s", None)),
            note("c-0123456789ab", answer_value("read-only", Some("Offline"))),
            note("cpt-x-fr-b", answer_value("  ", None)),
        ]);
        assert_eq!(
            reqs,
            vec![("cpt-x-fr-a".to_owned(), "within 2 s".to_owned())]
        );
        assert_eq!(
            general,
            vec![(
                "Offline".to_owned(),
                "read-only".to_owned(),
                "c-0123456789ab".to_owned()
            )]
        );
    }
}
