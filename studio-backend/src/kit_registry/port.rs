//! Asking the kit registry to install what a new project was told to have.
//!
//! One method. A kit a person ticked on the New project card is part of that
//! project's creation, not a thing they do afterwards — and the sequence that
//! creates the project has to survive the page that started it, so it has to
//! be able to ask for one without being a browser.
//!
//! Published on the ClientHub, and absent the same way as every other seam
//! here: a deployment without the kit registry skips that step with a reason
//! rather than failing the project over it.

use async_trait::async_trait;
use toolkit_security::SecurityContext;
use uuid::Uuid;

#[async_trait]
pub trait KitInstaller: Send + Sync + 'static {
    /// The kits this project has already been told to install.
    ///
    /// The probe for the step: a resumed run must not ask twice, and asking
    /// what is already wanted is cheaper than working out what changed.
    async fn wanted(&self, ctx: &SecurityContext, project_id: Uuid) -> anyhow::Result<Vec<String>>;

    /// Record that this project wants this kit.
    ///
    /// `version` empty means the kit's default — the catalogue decides, not
    /// the caller, so a project created today and one created tomorrow both
    /// get what the kit says is current.
    async fn want(
        &self,
        ctx: &SecurityContext,
        project_id: Uuid,
        kit_slug: &str,
        version: &str,
    ) -> anyhow::Result<()>;
}
