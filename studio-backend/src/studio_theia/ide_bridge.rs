//! The core's IDE port (`crate::ide_bridge`, ADR-0079), filled by this gear:
//! what studio-notify and studio-kits ask of a workspace's IDE, over the
//! control client. A bridge error becomes its own sentence.

use std::sync::Arc;

use async_trait::async_trait;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use crate::ide_bridge::{
    EditorNote, IdeBridge, IdeKitInstall, IdeKitInstalled, IdeRepository, IdeStatus,
};
use crate::studio_theia::sdk::models::KitSourceFile;
use crate::studio_theia::sdk::{InstallKit, NotifyEditor, SessionTarget, TheiaControlClientV1};

pub struct TheiaIdeBridge(pub Arc<dyn TheiaControlClientV1>);

fn target(workspace_id: Uuid) -> SessionTarget {
    SessionTarget { workspace_id }
}

#[async_trait]
impl IdeBridge for TheiaIdeBridge {
    async fn status(&self, ctx: &SecurityContext, workspace_id: Uuid) -> anyhow::Result<IdeStatus> {
        let status = self
            .0
            .get_runtime_status(ctx, &target(workspace_id))
            .await
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        Ok(IdeStatus {
            ready: status.ready,
            workspace_mode: status.workspace_mode,
        })
    }

    async fn notify(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        note: &EditorNote,
    ) -> anyhow::Result<bool> {
        let request = NotifyEditor {
            level: note.level.clone(),
            message: note.message.clone(),
            detail: note.detail.clone(),
            link: note.link.clone(),
            source: note.source.clone(),
        };
        let result = self
            .0
            .notify_editor(ctx, &target(workspace_id), &request)
            .await
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        Ok(result.shown)
    }

    async fn repositories(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
    ) -> anyhow::Result<Vec<IdeRepository>> {
        let repositories = self
            .0
            .get_repositories(ctx, &target(workspace_id))
            .await
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        Ok(repositories
            .into_iter()
            .map(|r| IdeRepository {
                repository_id: r.repository_id,
                label: r.label,
                kind: r.kind,
                git_mode: r.git_mode,
            })
            .collect())
    }

    async fn install_kit(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        kit: IdeKitInstall,
    ) -> anyhow::Result<IdeKitInstalled> {
        let request = InstallKit {
            kit_slug: kit.kit_slug,
            version: kit.version,
            repository_id: kit.repository_id,
            shelf_files: kit.shelf_files.map(|files| {
                files
                    .into_iter()
                    .map(|f| KitSourceFile {
                        path: f.path,
                        content: f.content,
                    })
                    .collect()
            }),
        };
        let result = self
            .0
            .install_kit(ctx, &target(workspace_id), &request)
            .await
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        Ok(IdeKitInstalled {
            repository_id: result.repository_id,
            repository_label: result.repository_label,
        })
    }
}
