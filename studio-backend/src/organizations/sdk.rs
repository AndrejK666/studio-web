//! Names another gear needs to recognise an organization, and the one walk up
//! the tree another gear may take to find a tenant's organization.

use toolkit_security::SecurityContext;
use uuid::Uuid;

pub(crate) use super::rollups::{
    ORGANIZATION_TENANT_TYPE, PROJECT_TENANT_TYPE, WORKSPACE_TENANT_TYPE,
};

/// The organization a project or workspace hangs under (project → workspace →
/// organization), read as the caller, so a caller learns nothing about an
/// organization their scope does not reach. `None` when any step fails or no
/// organization is found within that many steps up.
pub async fn organization_of(
    am: &dyn account_management_sdk::AccountManagementClient,
    ctx: &SecurityContext,
    scope: Uuid,
) -> Option<Uuid> {
    let mut id = scope;
    for _ in 0..3 {
        let tenant = am.get_tenant(ctx, id).await.ok()?;
        if tenant.tenant_type.as_deref() == Some(ORGANIZATION_TENANT_TYPE) {
            return Some(id);
        }
        id = tenant.parent_id?.0;
    }
    None
}

/// The workspaces the caller's portfolio holds (`GET
/// /studio-organizations/v1/rollups` with no scope), as `(id, name)` in the
/// same order and read as the caller: those under the caller's tenant, then
/// those under each organization in it (a platform tenant holds
/// organizations, and they hold the workspaces, ADR-0011). Only the tenant
/// tree is read -- none of a rollup's counts -- so a gear that needs just
/// the list (the Inbox) does not pay for them.
///
/// An error when the caller's own tenant could not be listed; an
/// organization under it that cannot be listed adds nothing, as in the
/// portfolio.
pub async fn portfolio_workspaces(
    am: &dyn account_management_sdk::AccountManagementClient,
    ctx: &SecurityContext,
) -> anyhow::Result<Vec<(Uuid, String)>> {
    use super::rollups::children_of;
    let root = ctx.subject_tenant_id();
    let (mut out, organizations) = tokio::try_join!(
        children_of(am, ctx, root, WORKSPACE_TENANT_TYPE),
        children_of(am, ctx, root, ORGANIZATION_TENANT_TYPE),
    )?;
    let under = futures_util::future::join_all(
        organizations
            .into_iter()
            .map(|(org, _)| children_of(am, ctx, org, WORKSPACE_TENANT_TYPE)),
    )
    .await;
    for workspaces in under {
        out.extend(workspaces.unwrap_or_default());
    }
    Ok(out)
}
