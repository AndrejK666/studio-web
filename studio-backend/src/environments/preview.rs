//! Previews (ADR-0055): a build installed into a namespace of its own for a
//! while, with an address of its own, then removed with everything in it.
//!
//! A preview is a deploy like any other -- the same run, the same chart, the
//! same images -- with three differences, all here:
//!
//! - its namespace is the project's namespace there with `-pv-<name>` after
//!   it, labelled `studio.constructor.tech/preview=true` and annotated with
//!   when it expires, so a cluster administrator sees what it is and the
//!   bootstrap manifest can let Studio delete exactly those namespaces;
//! - after the install, when the environment has a preview domain, the run
//!   routes `<namespace>.<domain>` to the product with an Ingress of its own
//!   ([`apply_route`]), since a generated chart has none: to the Service
//!   port named `http`, else `rest` -- the ports a gear's REST API listens
//!   on, as for a Research application;
//! - the sweep ([`SweepTask`]) deletes the namespace once the preview
//!   expires or somebody removes it, and records that on the deployment.
//!   One schedule per organization runs it every quarter of an hour; a
//!   removal asked for by a person is one more run, at once.

use std::sync::Arc;

use anyhow::anyhow;
use async_trait::async_trait;
use k8s_openapi::api::core::v1::{Namespace, Service};
use k8s_openapi::api::networking::v1::Ingress;
use kube::api::{DeleteParams, ListParams, Patch, PatchParams};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use toolkit::client_hub::ClientHub;
use tracing::{info, warn};
use uuid::Uuid;

use super::DEPLOYMENTS_METADATA_TYPE;
use super::model::{Deployment, DeploymentList};
use super::store::{Store, service_context};
use crate::tasks::sdk::{TaskContext, TaskHandler, TaskOutcome};

/// Task type. A wire contract: stored on every queued run and every schedule.
pub const SWEEP_TASK_TYPE: &str = "environments.previews.sweep";

/// How often an organization's schedule sweeps: a preview outlives its
/// expiry by at most this.
pub const SWEEP_CRON: &str = "*/15 * * * *";

/// The label every preview namespace carries.
pub const PREVIEW_LABEL: &str = "studio.constructor.tech/preview";
/// The annotation saying when it expires (RFC 3339).
pub const EXPIRES_ANNOTATION: &str = "studio.constructor.tech/expires-at";
/// The Ingress a preview's address is.
pub const ROUTE_NAME: &str = "studio-preview";

const FIELD_MANAGER: &str = "constructor-studio";

/// What a deploy run needs to know of a preview.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreviewRoute {
    /// RFC 3339; written on the namespace.
    pub expires_at: String,
    /// The host to route; `None` routes nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ingress_class: Option<String>,
}

/// A Service's name, and each of its ports' name and number.
pub type ServicePorts = (String, Vec<(Option<String>, i32)>);

/// The port names a preview's address goes to, in order of preference.
const ROUTED_PORTS: [&str; 2] = ["http", "rest"];

/// The Service and port a preview's address goes to: the first port named
/// `http`, else `rest`, preferring the Service named as the release, then
/// by name. `services` is each Service's name and its ports' names and
/// numbers.
pub fn backend(services: &[ServicePorts], release: &str) -> Option<(String, i32)> {
    let mut ordered: Vec<&ServicePorts> = services.iter().collect();
    ordered.sort_by(|a, b| (a.0 != release, &a.0).cmp(&(b.0 != release, &b.0)));
    ROUTED_PORTS.iter().find_map(|wanted| {
        ordered.iter().find_map(|(name, ports)| {
            ports
                .iter()
                .find(|(port, _)| port.as_deref() == Some(*wanted))
                .map(|(_, number)| (name.clone(), *number))
        })
    })
}

/// The Ingress that routes `host` to `service:port`.
pub fn ingress(host: &str, class: Option<&str>, service: &str, port: i32) -> serde_json::Value {
    let mut spec = serde_json::json!({
        "rules": [{
            "host": host,
            "http": { "paths": [{
                "path": "/",
                "pathType": "Prefix",
                "backend": { "service": { "name": service, "port": { "number": port } } },
            }]},
        }],
    });
    if let Some(class) = class {
        spec["ingressClassName"] = class.into();
    }
    serde_json::json!({
        "apiVersion": "networking.k8s.io/v1",
        "kind": "Ingress",
        "metadata": {
            "name": ROUTE_NAME,
            "labels": { "app.kubernetes.io/managed-by": FIELD_MANAGER },
        },
        "spec": spec,
    })
}

/// Route the preview's host to the product just installed into `namespace`.
/// `Ok(None)` when there is no host to route; `Ok(Some(why))` when there is
/// nothing to route it to, which leaves the preview without an address but
/// installed.
pub async fn apply_route(
    client: &kube::Client,
    namespace: &str,
    release: &str,
    route: &PreviewRoute,
) -> anyhow::Result<Option<String>> {
    let Some(host) = &route.host else {
        return Ok(None);
    };
    let services: kube::Api<Service> = kube::Api::namespaced(client.clone(), namespace);
    let listed = services
        .list(&ListParams::default())
        .await
        .map_err(|e| anyhow!("the preview's services could not be read: {e}"))?;
    let ports: Vec<ServicePorts> = listed
        .items
        .into_iter()
        .filter_map(|s| {
            let name = s.metadata.name?;
            let ports = s
                .spec
                .and_then(|spec| spec.ports)
                .unwrap_or_default()
                .into_iter()
                .map(|p| (p.name, p.port))
                .collect();
            Some((name, ports))
        })
        .collect();
    let Some((service, port)) = backend(&ports, release) else {
        return Ok(Some(format!(
            "no Service in {namespace} has a port named http or rest: the preview has no address"
        )));
    };
    let object = ingress(host, route.ingress_class.as_deref(), &service, port);
    kube::Api::<Ingress>::namespaced(client.clone(), namespace)
        .patch(
            ROUTE_NAME,
            &PatchParams::apply(FIELD_MANAGER).force(),
            &Patch::Apply(&object),
        )
        .await
        .map_err(|e| anyhow!("the preview's address could not be routed: {e}"))?;
    Ok(Some(format!("{host} routes to {service}:{port}")))
}

/// What a sweep run carries: the organization, and the one preview a person
/// asked to remove, if that is what it is for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SweepPayload {
    pub organization_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deployment_id: Option<Uuid>,
}

/// The previews a sweep removes: the one named, if it is still there, else
/// every live one that has expired by `now`.
pub fn to_remove(
    list: &DeploymentList,
    only: Option<Uuid>,
    now: OffsetDateTime,
) -> Vec<Deployment> {
    list.items
        .iter()
        .filter(|d| match only {
            Some(id) => d.id == id && d.is_live_preview(),
            None => d.preview_due(now),
        })
        .cloned()
        .collect()
}

/// Whether a namespace is one a preview made: Studio's, a preview, of this
/// project. The sweep deletes nothing else, whatever a record says.
pub fn is_preview_namespace(ns: &Namespace, project: Uuid) -> bool {
    let labels = ns.metadata.labels.clone().unwrap_or_default();
    labels
        .get("app.kubernetes.io/managed-by")
        .map(String::as_str)
        == Some(FIELD_MANAGER)
        && labels.get(PREVIEW_LABEL).map(String::as_str) == Some("true")
        && labels.get("studio.constructor.tech/project") == Some(&project.to_string())
}

/// Delete the preview's namespace with everything in it. A namespace already
/// gone is removed too.
async fn remove(hub: &Arc<ClientHub>, org: Uuid, d: &Deployment) -> anyhow::Result<()> {
    let Some(p) = &d.preview else {
        return Ok(());
    };
    let from = p.connections_from.unwrap_or(org);
    let reader = service_context(from)?;
    let access = super::deploy::cluster_access(hub, &reader, from, p.connection_id).await?;
    let client = access.client().await?;
    let namespaces: kube::Api<Namespace> = kube::Api::all(client);
    let Some(ns) = namespaces
        .get_opt(&d.namespace)
        .await
        .map_err(|e| anyhow!("the cluster did not answer: {e}"))?
    else {
        return Ok(());
    };
    if !is_preview_namespace(&ns, d.project_id) {
        return Err(anyhow!(
            "namespace {} is not labelled as this project's preview: Studio leaves it alone",
            d.namespace
        ));
    }
    match namespaces
        .delete(&d.namespace, &DeleteParams::default())
        .await
    {
        Ok(_) => Ok(()),
        Err(kube::Error::Api(s)) if s.code == 404 => Ok(()),
        Err(kube::Error::Api(s)) if s.code == 403 => Err(anyhow!(
            "the cluster connection may not delete namespace {}: apply the cluster's bootstrap \
             manifest again, which lets it delete Studio's preview namespaces ({})",
            d.namespace,
            s.message
        )),
        Err(e) => Err(anyhow!(
            "namespace {} could not be deleted: {e}",
            d.namespace
        )),
    }
}

pub struct SweepTask {
    hub: Arc<ClientHub>,
}

impl SweepTask {
    pub fn new(hub: Arc<ClientHub>) -> Self {
        Self { hub }
    }

    fn store(&self) -> anyhow::Result<Store> {
        let am = self
            .hub
            .get::<dyn account_management_sdk::AccountManagementClient>()
            .map_err(|_| anyhow!("account management is not available in this deployment"))?;
        Ok(Store::new(am))
    }
}

#[async_trait]
impl TaskHandler for SweepTask {
    fn task_type(&self) -> &'static str {
        SWEEP_TASK_TYPE
    }

    /// One: a preview the cluster would not let go is recorded as such, and
    /// the next sweep tries it again.
    fn max_attempts(&self) -> i16 {
        1
    }

    async fn run(&self, ctx: &TaskContext) -> TaskOutcome {
        let p: SweepPayload = match serde_json::from_value(ctx.payload.clone()) {
            Ok(p) => p,
            Err(e) => {
                return TaskOutcome::Failed(format!(
                    "studio-environments: this run's payload is not a preview sweep ({e})"
                ));
            }
        };
        let org = p.organization_id;
        // A schedule fires in the platform tenant: the run acts as this gear
        // in the organization it names.
        let (store, svc) = match (self.store(), service_context(org)) {
            (Ok(store), Ok(svc)) => (store, svc),
            (Err(e), _) | (_, Err(e)) => return TaskOutcome::Failed(format!("{e:#}")),
        };
        let list = match store
            .read::<DeploymentList>(&svc, org, DEPLOYMENTS_METADATA_TYPE)
            .await
        {
            Ok((list, _)) => list,
            Err(e) => return TaskOutcome::Retry(format!("{e:#}")),
        };
        let due = to_remove(&list, p.deployment_id, OffsetDateTime::now_utc());
        if due.is_empty() {
            return TaskOutcome::done_with("no preview to remove", serde_json::json!({}));
        }
        let mut removed = 0usize;
        let mut failed = Vec::new();
        for d in &due {
            ctx.progress(format!("removing preview namespace {}", d.namespace))
                .await;
            let result = remove(&self.hub, org, d).await;
            let at = OffsetDateTime::now_utc()
                .format(&Rfc3339)
                .unwrap_or_default();
            let error = result.as_ref().err().map(|e| format!("{e:#}"));
            match &error {
                None => {
                    removed += 1;
                    info!(deployment = %d.id, namespace = %d.namespace, "studio-environments: preview removed");
                }
                Some(why) => {
                    warn!(deployment = %d.id, error = %why, "studio-environments: a preview could not be removed");
                    failed.push(format!("{}: {why}", d.namespace));
                }
            }
            let id = d.id;
            let written = store
                .update::<DeploymentList, (), std::convert::Infallible>(
                    &svc,
                    org,
                    DEPLOYMENTS_METADATA_TYPE,
                    |list| {
                        if let Some(p) = list
                            .items
                            .iter_mut()
                            .find(|x| x.id == id)
                            .and_then(|x| x.preview.as_mut())
                        {
                            match &error {
                                None => {
                                    p.removed_at = Some(at.clone());
                                    p.removal_error = None;
                                }
                                Some(why) => p.removal_error = Some(why.clone()),
                            }
                        }
                        Ok(())
                    },
                )
                .await;
            if let Err(e) = written {
                warn!(error = ?e, deployment = %id, "studio-environments: a preview's removal could not be recorded");
            }
        }
        let summary = format!("{removed} of {} previews removed", due.len());
        if failed.is_empty() {
            TaskOutcome::done_with(summary, serde_json::json!({}))
        } else {
            TaskOutcome::Failed(format!("{summary}; {}", failed.join("; ")))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn svc(name: &str, ports: &[(&str, i32)]) -> ServicePorts {
        (
            name.to_owned(),
            ports
                .iter()
                .map(|(n, p)| ((!n.is_empty()).then(|| (*n).to_owned()), *p))
                .collect(),
        )
    }

    #[test]
    fn the_address_goes_to_http_before_rest_and_to_the_release_before_others() {
        let services = vec![
            svc("api-gateway", &[("rest", 8080)]),
            svc("frontend", &[("http", 80)]),
            svc("shop", &[("metrics", 9090), ("rest", 8087)]),
        ];
        assert_eq!(backend(&services, "shop"), Some(("frontend".into(), 80)));
        let no_http = vec![
            svc("api-gateway", &[("rest", 8080)]),
            svc("shop", &[("rest", 8087)]),
        ];
        assert_eq!(backend(&no_http, "shop"), Some(("shop".into(), 8087)));
        assert_eq!(
            backend(&no_http, "other"),
            Some(("api-gateway".into(), 8080))
        );
        assert_eq!(backend(&[svc("db", &[("", 5432)])], "shop"), None);
    }

    #[test]
    fn the_ingress_routes_the_host_to_the_port_and_names_a_class_only_when_given() {
        let i = ingress("shop-dev-pv-pr-1.preview.example.com", None, "frontend", 80);
        assert_eq!(i["metadata"]["name"], ROUTE_NAME);
        assert_eq!(
            i["spec"]["rules"][0]["host"],
            "shop-dev-pv-pr-1.preview.example.com"
        );
        let path = &i["spec"]["rules"][0]["http"]["paths"][0];
        assert_eq!(path["backend"]["service"]["name"], "frontend");
        assert_eq!(path["backend"]["service"]["port"]["number"], 80);
        assert!(i["spec"].get("ingressClassName").is_none());
        let with = ingress("h.example.com", Some("nginx"), "frontend", 80);
        assert_eq!(with["spec"]["ingressClassName"], "nginx");
    }

    #[test]
    fn only_a_namespace_labelled_as_the_projects_preview_is_deleted() {
        let project = Uuid::new_v4();
        let ns = |labels: &[(&str, &str)]| Namespace {
            metadata: kube::api::ObjectMeta {
                labels: Some(
                    labels
                        .iter()
                        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                        .collect(),
                ),
                ..Default::default()
            },
            ..Default::default()
        };
        let pid = project.to_string();
        let full = [
            ("app.kubernetes.io/managed-by", "constructor-studio"),
            (PREVIEW_LABEL, "true"),
            ("studio.constructor.tech/project", pid.as_str()),
        ];
        assert!(is_preview_namespace(&ns(&full), project));
        assert!(!is_preview_namespace(&ns(&full[..2]), project));
        assert!(!is_preview_namespace(&ns(&[full[0], full[2]]), project));
        assert!(!is_preview_namespace(&ns(&full), Uuid::new_v4()));
    }
}
