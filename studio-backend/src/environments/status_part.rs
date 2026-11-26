//! The delivery kit's part of a project's status (the core's project status
//! port, ADR-0079 §4): stages 5-9 as Releases says them, and the project's
//! deployments.

use async_trait::async_trait;
use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::port::{ProjectDeliveryStages, ProjectDeployments};
use crate::organizations::port::{
    PathStage, ProjectKitParts, StatusContributor, StatusPart, StatusSource, deploys,
};

inventory::submit! {
    StatusContributor {
        gear: "studio-environments",
        order: 40,
        source: &DeliveryStatus,
    }
}

struct DeliveryStatus;

#[async_trait]
impl StatusSource for DeliveryStatus {
    async fn read(&self, hub: &ClientHub, ctx: &SecurityContext, project: Uuid) -> StatusPart {
        // Stages 5-9 as Releases says them, read as the organizations gear.
        let delivery = async {
            let port = hub.get::<dyn ProjectDeliveryStages>().ok()?;
            port.delivery_stages(ctx, project).await.ok()
        };
        let deployments = async {
            let port = hub.get::<dyn ProjectDeployments>().ok()?;
            port.deployments_page(ctx, project)
                .await
                .ok()
                .map(|page| deploys(&page))
        };
        let (delivery, deployments) = tokio::join!(delivery, deployments);
        StatusPart {
            delivery,
            deployments,
            ..StatusPart::default()
        }
    }
}

// The parts of a project's status and path the delivery kit owns.
inventory::submit! {
    ProjectKitParts {
        kit: "delivery",
        steps: &["build"],
        signals: &["build", "deploy"],
        stages: &[
            PathStage {
                id: "build",
                title: "Build",
                tab: "releases",
            },
            PathStage {
                id: "images",
                title: "Images",
                tab: "releases",
            },
            PathStage {
                id: "environment",
                title: "Environment",
                tab: "releases",
            },
            PathStage {
                id: "deploy",
                title: "Deploy",
                tab: "releases",
            },
        ],
    }
}
