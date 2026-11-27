//! The documents kit's part of a project's status (the core's project status
//! port, ADR-0079 §4): the Specs queues, the project domain model and its
//! open findings.

use async_trait::async_trait;
use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::port::ProjectStatusFacts;
use crate::organizations::port::{
    FindingFacts, ModelFacts, PathStage, ProjectKitParts, StatusContributor, StatusPart,
    StatusSource, spec_queues,
};

inventory::submit! {
    StatusContributor {
        gear: "studio-documents",
        order: 10,
        source: &DocumentsStatus,
    }
}

struct DocumentsStatus;

#[async_trait]
impl StatusSource for DocumentsStatus {
    async fn read(&self, hub: &ClientHub, ctx: &SecurityContext, project: Uuid) -> StatusPart {
        let Ok(port) = hub.get::<dyn ProjectStatusFacts>() else {
            return StatusPart::default();
        };
        let Ok(d) = port.status_facts(ctx, project).await else {
            return StatusPart::default();
        };
        StatusPart {
            specs: d.queues.as_deref().map(spec_queues),
            model: d.model.map(|m| ModelFacts {
                documents: m.documents,
                extracted: m.extracted,
                facts: m.facts,
                running: m.running,
            }),
            findings: d.findings.map(|f| FindingFacts {
                open: f.open,
                high: f.high,
            }),
            ..StatusPart::default()
        }
    }
}

// The parts of a project's status and path this gear's kits own.
inventory::submit! {
    ProjectKitParts {
        kit: super::overview_block::SPECS_KIT,
        steps: &["types"],
        signals: &["specs"],
        stages: &[PathStage {
            id: "documents",
            title: "Documents",
            tab: "specs",
        }],
        opens: &[],
    }
}

inventory::submit! {
    ProjectKitParts {
        kit: "project-domain-model",
        steps: &["model", "findings"],
        signals: &["findings"],
        stages: &[
            PathStage {
                id: "model",
                title: "Domain model",
                tab: "model",
            },
            PathStage {
                id: "findings",
                title: "Findings",
                tab: "issues",
            },
        ],
        opens: &[],
    }
}
