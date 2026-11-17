//! [`port::SpecTexts`](super::port::SpecTexts): a project's specifications
//! with their text, for a gear that sends them elsewhere (studio-product's
//! gear match).
//!
//! The same read the project domain model's routes make (`rest.rs`,
//! `spec_model_state`): the project's parent workspace as the caller reads
//! it, then the model's sources through the checkout reader, narrowed by the
//! same selection a build takes (`spec_model::select`).

use std::sync::Arc;

use async_trait::async_trait;
use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::port::{SpecText, SpecTexts, SpecTextsRead, SpecTextsRefused};
use super::service::DocumentsService;
use super::spec_model::select::{self, Selection};

pub struct SpecTextsPort {
    service: Arc<DocumentsService>,
    hub: Arc<ClientHub>,
}

impl SpecTextsPort {
    pub fn new(service: Arc<DocumentsService>, hub: Arc<ClientHub>) -> Self {
        Self { service, hub }
    }
}

#[async_trait]
impl SpecTexts for SpecTextsPort {
    async fn spec_texts(
        &self,
        ctx: &SecurityContext,
        project_id: Uuid,
        paths: &[String],
        glob: Option<&str>,
    ) -> Result<SpecTextsRead, SpecTextsRefused> {
        let not_found = || {
            SpecTextsRefused::NotFound(format!("there is no project {project_id} for this caller"))
        };
        // Reading the project is what authorizes it, as `parent_workspace`
        // in the gear's routes does.
        let workspace = self
            .service
            .parent_of(ctx, project_id)
            .await
            .map_err(|_| not_found())?
            .ok_or_else(not_found)?;
        self.service
            .authorize(ctx, workspace)
            .await
            .map_err(|_| not_found())?;
        if paths.len() > select::PATHS_MAX {
            return Err(SpecTextsRefused::UnknownSelection(format!(
                "at most {} paths",
                select::PATHS_MAX
            )));
        }
        let reader = self
            .hub
            .get::<dyn crate::artifact_ingest::port::RepoFileReader>()
            .map_err(|_| {
                SpecTextsRefused::Unavailable(
                    "nothing in this deployment holds a checkout to read the specifications from"
                        .to_owned(),
                )
            })?;
        let sources = self
            .service
            .spec_model_sources(ctx, workspace, project_id, reader.as_ref())
            .await
            .map_err(SpecTextsRefused::Failed)?;
        let selection = Selection {
            path: None,
            paths,
            glob,
        };
        let chosen = if selection.is_empty() {
            sources.documents
        } else {
            select::select(&sources.documents, selection)
                .map_err(|unknown| SpecTextsRefused::UnknownSelection(unknown.message()))?
        };
        Ok(SpecTextsRead {
            documents: chosen
                .into_iter()
                .map(|d| SpecText {
                    commit: d.at.as_ref().map(|a| a.commit.clone()),
                    branch: d.at.as_ref().and_then(|a| a.git_ref.clone()),
                    path: d.path,
                    text: d.text,
                    doc_type: d.doc_type,
                })
                .collect(),
            unread: sources.unread,
        })
    }
}
