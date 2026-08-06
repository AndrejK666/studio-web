//! GTS identifiers for the connector subsystem.
//!
//! The provider *driver* is a plugin: it registers a `PluginV1` instance
//! under the connector plugin contract and publishes a scoped
//! [`super::driver::ConnectorDriver`] client under the same GTS id, exactly
//! like the IdP / authn / authz plugin families.
//!
//! The type schemas themselves are declared in the deployment profile
//! (`config/*.yaml`, `types-registry.static_entities`) rather than through
//! `#[gts_type_schema]`, matching how this crate already declares
//! `cf.studio.workspace.settings.v1`. Runtime behaviour is identical — the
//! registry stores the same documents — and the assembly crate stays free of
//! the GTS macro toolchain.

/// Plugin contract every connector driver derives from.
pub const CONNECTOR_PLUGIN_TYPE: &str =
    "gts.cf.toolkit.plugins.plugin.v1~cf.studio.connector.plugin.v1~";

/// Driver instance ids. One per provider; the connector gear resolves its
/// scoped client by this string, so a provider whose plugin gear is absent
/// from the assembly simply reports as unavailable.
pub const GITLAB_INSTANCE_ID: &str = "gts.cf.toolkit.plugins.plugin.v1~cf.studio.connector.plugin.v1~cf.studio._.gitlab_connector.v1";
pub const GITHUB_INSTANCE_ID: &str = "gts.cf.toolkit.plugins.plugin.v1~cf.studio.connector.plugin.v1~cf.studio._.github_connector.v1";
pub const BITBUCKET_INSTANCE_ID: &str = "gts.cf.toolkit.plugins.plugin.v1~cf.studio.connector.plugin.v1~cf.studio._.bitbucket_connector.v1";
pub const ANTHROPIC_INSTANCE_ID: &str = "gts.cf.toolkit.plugins.plugin.v1~cf.studio.connector.plugin.v1~cf.studio._.anthropic_connector.v1";
pub const OPENAI_INSTANCE_ID: &str = "gts.cf.toolkit.plugins.plugin.v1~cf.studio.connector.plugin.v1~cf.studio._.openai_connector.v1";

/// Tenant-metadata schema holding the connection catalogue of one tenant.
/// Connections are configuration, not secrets: the token lives in credstore
/// and only its reference is stored here.
///
/// NB the segment shape. A GTS segment is `vendor.package.namespace.type.vN`
/// (gts-spec §"gts-segment"), i.e. five dot-separated parts — the earlier
/// `cf.studio.connections.v1` had four and the registry rejected it at boot
/// with a bare `invalid_argument: Request validation failed`. `catalogue`
/// rather than `connection` because one row holds the whole list; the
/// singular id belongs to the REST error resource type.
pub const CONNECTIONS_METADATA_TYPE: &str =
    "gts.cf.core.am.tenant_metadata.v1~cf.studio.connector.catalogue.v1~";

/// Build the `PluginV1` registration document for a driver.
///
/// Hand-built rather than via `PluginV1::build_registration` because that
/// helper needs a `gts::GtsSchema` spec type, which in turn needs the GTS
/// derive macros in this crate. The emitted document is byte-compatible.
pub fn plugin_registration(instance_id: &str, vendor: &str, priority: i16) -> serde_json::Value {
    // The registry would reject a document whose id does not derive from the
    // contract, but only at boot and with a message about GTS chains. Catch a
    // mistyped instance id here instead, where the fix is obvious.
    debug_assert!(
        instance_id.starts_with(CONNECTOR_PLUGIN_TYPE),
        "connector driver instance id must derive from {CONNECTOR_PLUGIN_TYPE}, got {instance_id}"
    );
    serde_json::json!({
        "id": instance_id,
        "vendor": vendor,
        "priority": priority,
        "properties": {},
    })
}
