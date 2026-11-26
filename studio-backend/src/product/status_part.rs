//! The product kit's part of a project's status (the core's project status
//! port, ADR-0079 §4): the product record, the engine's last verdict kept on
//! it, and the saved description's revision.

use async_trait::async_trait;
use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::port::ProjectProducts;
use crate::organizations::port::{
    PathStage, ProjectKitParts, StatusContributor, StatusPart, StatusSource, product_record_facts,
};

inventory::submit! {
    StatusContributor {
        gear: "studio-product",
        order: 20,
        source: &ProductStatus,
    }
}

struct ProductStatus;

#[async_trait]
impl StatusSource for ProductStatus {
    async fn read(&self, hub: &ClientHub, ctx: &SecurityContext, project: Uuid) -> StatusPart {
        let Ok(port) = hub.get::<dyn ProjectProducts>() else {
            return StatusPart::default();
        };
        let scope = project.to_string();
        let product = async {
            let record = port.product_record(ctx, &scope).await.ok()?;
            Some(product_record_facts(record.as_ref()))
        };
        // The saved description's revision, as the delivery path reads it.
        let revision = async {
            match port.latest_description(ctx, project).await.ok()? {
                Some(d) => Some(d.revision.max(1)),
                None => port
                    .saved_description(ctx, &scope)
                    .await
                    .ok()
                    .flatten()
                    .map(|_| 0),
            }
        };
        let (product, revision) = tokio::join!(product, revision);
        let (product, product_check) = match product {
            Some((facts, check)) => (Some(facts), check),
            None => (None, None),
        };
        StatusPart {
            product,
            product_check,
            product_revision: revision,
            ..StatusPart::default()
        }
    }
}

// The parts of a project's status and path the product kit owns.
inventory::submit! {
    ProjectKitParts {
        kit: "project-product",
        steps: &["kind", "product"],
        signals: &["product"],
        stages: &[PathStage {
            id: "product",
            title: "Product",
            tab: "product",
        }],
    }
}
