//! A deploy on the server (ADR-0043 §3): the run that installs a product's
//! chart into an environment, and the status read back afterwards.
//!
//! The run gets everything it needs in its payload -- the chart, the values,
//! the namespace, which connection -- so it reads nothing a person could have
//! changed after the deploy was asked for and approved, except the cluster's
//! credential, which it reads from credstore as the service at the last
//! moment and writes only into a file of its own that it removes afterwards.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, anyhow};
use async_trait::async_trait;
use base64::Engine;
use k8s_openapi::api::apps::v1::Deployment as KubeDeployment;
use k8s_openapi::api::core::v1::Namespace;
use k8s_openapi::api::networking::v1::Ingress;
use kube::api::{ListParams, ObjectMeta, PostParams};
use serde::{Deserialize, Serialize};
use tokio::process::Command;
use toolkit::client_hub::ClientHub;
use tracing::{info, warn};
use uuid::Uuid;

use crate::connectors::sdk::{ClusterAccess, Connectors};
use crate::tasks::sdk::{TaskContext, TaskHandler, TaskOutcome};

/// Task type. A wire contract: stored on every queued run.
pub const TASK_TYPE: &str = "environments.deploy";

/// How long `helm upgrade --wait` waits for the release to come up. Under the
/// task lease (15 minutes), so a slow rollout fails as itself rather than as a
/// lost lease.
const HELM_TIMEOUT: &str = "8m";

/// The helm binary: `STUDIO_HELM`, or `helm` on the PATH (the image installs
/// one).
fn helm_binary() -> String {
    std::env::var("STUDIO_HELM")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "helm".to_owned())
}

/// What the deploy route or an approval puts on the queue.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeployPayload {
    pub deployment_id: Uuid,
    pub organization_id: Uuid,
    pub project_id: Uuid,
    pub connection_id: Uuid,
    pub namespace: String,
    pub release: String,
    /// The chart, a `.tgz`, base64.
    pub chart: String,
    /// Values given to the chart: the images under the environment's registry.
    pub values: serde_json::Value,
}

pub struct DeployTask {
    hub: Arc<ClientHub>,
}

impl DeployTask {
    pub fn new(hub: Arc<ClientHub>) -> Self {
        Self { hub }
    }
}

/// The cluster's access for a connection, read as `ctx`.
pub async fn cluster_access(
    hub: &Arc<ClientHub>,
    ctx: &toolkit_security::SecurityContext,
    organization: Uuid,
    connection: Uuid,
) -> anyhow::Result<ClusterAccess> {
    let connectors = Connectors::new(Arc::clone(hub))
        .get()
        .ok_or_else(|| anyhow!("connections are not available in this deployment"))?;
    let (_, auth, c) = connectors
        .driver_and_auth(ctx, organization, connection)
        .await
        .map_err(|e| anyhow!("the environment's cluster connection cannot be used: {e:#}"))?;
    if c.provider != "kubernetes" {
        return Err(anyhow!(
            "connection '{}' is a {} connection, not a Kubernetes cluster",
            c.label,
            c.provider
        ));
    }
    ClusterAccess::parse(&auth.base_url, &auth.token)
}

#[async_trait]
impl TaskHandler for DeployTask {
    fn task_type(&self) -> &'static str {
        TASK_TYPE
    }

    /// Two: a cluster that did not answer gets one more try; a chart the
    /// cluster refused will refuse again, so `run` says Failed for that.
    fn max_attempts(&self) -> i16 {
        2
    }

    async fn run(&self, ctx: &TaskContext) -> TaskOutcome {
        let payload: DeployPayload = match serde_json::from_value(ctx.payload.clone()) {
            Ok(p) => p,
            Err(e) => {
                return TaskOutcome::Failed(format!(
                    "studio-environments: this run's payload is not a deploy ({e})"
                ));
            }
        };
        ctx.progress("reading the cluster's access").await;
        let access = match cluster_access(
            &self.hub,
            &ctx.security,
            payload.organization_id,
            payload.connection_id,
        )
        .await
        {
            Ok(a) => a,
            Err(e) => return TaskOutcome::Failed(format!("{e:#}")),
        };
        ctx.progress(format!("preparing namespace {}", payload.namespace))
            .await;
        match access.client().await {
            Ok(client) => {
                if let Err(e) = ensure_namespace(&client, &payload).await {
                    return TaskOutcome::Failed(format!("{e:#}"));
                }
            }
            Err(e) => return TaskOutcome::Retry(format!("{e:#}")),
        }
        ctx.progress(format!(
            "helm upgrade --install {} into {}",
            payload.release, payload.namespace
        ))
        .await;
        match helm_install(&access, &payload, &ctx.cancel).await {
            Ok(out) => {
                info!(
                    deployment = %payload.deployment_id,
                    namespace = %payload.namespace,
                    "studio-environments: release installed"
                );
                TaskOutcome::done_with(
                    format!("{} installed into {}", payload.release, payload.namespace),
                    serde_json::json!({ "output": tail(&out, 4000) }),
                )
            }
            Err(e) => TaskOutcome::Failed(format!("{e:#}")),
        }
    }
}

/// The last `n` bytes of `s`, on a character boundary.
fn tail(s: &str, n: usize) -> String {
    if s.len() <= n {
        return s.to_owned();
    }
    let mut at = s.len() - n;
    while !s.is_char_boundary(at) {
        at += 1;
    }
    format!("…{}", &s[at..])
}

/// Make sure the namespace exists, creating it when the connection may. A
/// connection limited to its namespaces cannot read namespaces at all, and is
/// trusted to have been given this one.
async fn ensure_namespace(client: &kube::Client, p: &DeployPayload) -> anyhow::Result<()> {
    let namespaces: kube::Api<Namespace> = kube::Api::all(client.clone());
    match namespaces.get_opt(&p.namespace).await {
        Ok(Some(_)) => Ok(()),
        Ok(None) => {
            let ns = Namespace {
                metadata: ObjectMeta {
                    name: Some(p.namespace.clone()),
                    labels: Some(
                        [
                            (
                                "app.kubernetes.io/managed-by".to_owned(),
                                "constructor-studio".to_owned(),
                            ),
                            (
                                "studio.constructor.tech/project".to_owned(),
                                p.project_id.to_string(),
                            ),
                        ]
                        .into(),
                    ),
                    ..ObjectMeta::default()
                },
                ..Namespace::default()
            };
            namespaces
                .create(&PostParams::default(), &ns)
                .await
                .map(|_| ())
                .map_err(|e| {
                    anyhow!(
                        "namespace {} does not exist and the cluster connection may not \
                         create it: create it, or let the connection's service account \
                         create namespaces ({e})",
                        p.namespace
                    )
                })
        }
        Err(kube::Error::Api(status)) if status.code == 403 => {
            warn!(namespace = %p.namespace, "studio-environments: cannot read namespaces; assuming it exists");
            Ok(())
        }
        Err(e) => Err(anyhow!("the cluster did not answer: {e}")),
    }
}

/// A directory only this process reads, removed when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> anyhow::Result<Self> {
        let dir = std::env::temp_dir().join(format!("studio-deploy-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).context("cannot create a scratch directory")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(Self(dir))
    }

    fn write(&self, name: &str, bytes: &[u8]) -> anyhow::Result<PathBuf> {
        let path = self.0.join(name);
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        use std::io::Write;
        options
            .open(&path)
            .and_then(|mut f| f.write_all(bytes))
            .with_context(|| format!("cannot write {name}"))?;
        Ok(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The arguments of the install, without the kubeconfig's path, so a test
/// can say what runs.
pub fn helm_args(p: &DeployPayload, chart: &Path, values: &Path, kubeconfig: &Path) -> Vec<String> {
    vec![
        "upgrade".into(),
        "--install".into(),
        p.release.clone(),
        chart.display().to_string(),
        "--namespace".into(),
        p.namespace.clone(),
        "--values".into(),
        values.display().to_string(),
        "--kubeconfig".into(),
        kubeconfig.display().to_string(),
        "--wait".into(),
        "--timeout".into(),
        HELM_TIMEOUT.into(),
        "--history-max".into(),
        "10".into(),
    ]
}

async fn helm_install(
    access: &ClusterAccess,
    p: &DeployPayload,
    cancel: &tokio_util::sync::CancellationToken,
) -> anyhow::Result<String> {
    let chart = base64::engine::general_purpose::STANDARD
        .decode(p.chart.as_bytes())
        .context("the chart is not base64")?;
    let scratch = Scratch::new()?;
    let chart_path = scratch.write("chart.tgz", &chart)?;
    let values_path = scratch.write("values.json", serde_json::to_string(&p.values)?.as_bytes())?;
    let kubeconfig = scratch.write("kubeconfig", access.kubeconfig_yaml().as_bytes())?;
    let home = scratch.path().join("helm");
    let mut cmd = Command::new(helm_binary());
    cmd.args(helm_args(p, &chart_path, &values_path, &kubeconfig))
        // Helm's cache, config and data under the scratch directory: the
        // server's home is not writable, and nothing should outlive the run.
        .env("HELM_CACHE_HOME", home.join("cache"))
        .env("HELM_CONFIG_HOME", home.join("config"))
        .env("HELM_DATA_HOME", home.join("data"))
        .env_remove("KUBECONFIG")
        .kill_on_drop(true);
    let child = cmd.output();
    let output = tokio::select! {
        out = child => out.map_err(|e| anyhow!("helm could not be started -- is it installed on the server? ({e})"))?,
        () = cancel.cancelled() => return Err(anyhow!("the deploy was cancelled")),
    };
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if output.status.success() {
        Ok(text)
    } else {
        Err(anyhow!("helm upgrade failed: {}", tail(text.trim(), 2000)))
    }
}

/// One workload of a release as the cluster reports it.
#[derive(Debug, Clone, Serialize)]
pub struct Workload {
    pub name: String,
    pub ready: i32,
    pub desired: i32,
    pub images: Vec<String>,
}

/// A release's rollout as the cluster reports it now.
#[derive(Debug, Clone, Serialize)]
pub struct Rollout {
    pub workloads: Vec<Workload>,
    /// Hosts the release's ingresses answer on.
    pub hosts: Vec<String>,
}

/// Read a release's workloads and addresses from the cluster.
pub async fn rollout(
    access: &ClusterAccess,
    namespace: &str,
    release: &str,
) -> anyhow::Result<Rollout> {
    let client = access.client().await?;
    let selector = format!("app.kubernetes.io/instance={release}");
    let read = async {
        let deployments: kube::Api<KubeDeployment> =
            kube::Api::namespaced(client.clone(), namespace);
        let mut items = deployments
            .list(&ListParams::default().labels(&selector))
            .await?
            .items;
        // A chart that does not label its workloads with the release: the
        // namespace is the release's own (one per project and environment).
        if items.is_empty() {
            items = deployments.list(&ListParams::default()).await?.items;
        }
        let ingresses: kube::Api<Ingress> = kube::Api::namespaced(client.clone(), namespace);
        let hosts = ingresses
            .list(&ListParams::default())
            .await
            .map(|l| l.items)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|i| i.spec)
            .flat_map(|s| s.rules.unwrap_or_default())
            .filter_map(|r| r.host)
            .collect::<Vec<_>>();
        Ok::<_, kube::Error>((items, hosts))
    };
    let (items, hosts) = tokio::time::timeout(Duration::from_secs(20), read)
        .await
        .map_err(|_| anyhow!("the cluster did not answer in 20 s"))?
        .map_err(|e| anyhow!("the cluster refused to say: {e}"))?;
    let workloads = items
        .into_iter()
        .map(|d| {
            let status = d.status.unwrap_or_default();
            let spec = d.spec.unwrap_or_default();
            Workload {
                name: d.metadata.name.unwrap_or_default(),
                ready: status.ready_replicas.unwrap_or(0),
                desired: spec.replicas.unwrap_or(1),
                images: spec
                    .template
                    .spec
                    .map(|s| s.containers.into_iter().filter_map(|c| c.image).collect())
                    .unwrap_or_default(),
            }
        })
        .collect();
    Ok(Rollout { workloads, hosts })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload() -> DeployPayload {
        DeployPayload {
            deployment_id: Uuid::nil(),
            organization_id: Uuid::nil(),
            project_id: Uuid::nil(),
            connection_id: Uuid::nil(),
            namespace: "studio-web-prod".into(),
            release: "studio-web".into(),
            chart: String::new(),
            values: serde_json::json!({}),
        }
    }

    #[test]
    fn the_install_names_its_namespace_values_and_kubeconfig_and_waits() {
        let args = helm_args(
            &payload(),
            Path::new("/s/chart.tgz"),
            Path::new("/s/values.json"),
            Path::new("/s/kubeconfig"),
        );
        let line = args.join(" ");
        assert!(line.starts_with("upgrade --install studio-web /s/chart.tgz"));
        assert!(line.contains("--namespace studio-web-prod"));
        assert!(line.contains("--values /s/values.json"));
        assert!(line.contains("--kubeconfig /s/kubeconfig"));
        assert!(line.contains("--wait"));
        // The namespace is prepared by the run, with its labels; helm's
        // --create-namespace would make one without them.
        assert!(!line.contains("--create-namespace"));
    }

    #[test]
    fn a_scratch_directory_goes_away_with_its_files() {
        let path = {
            let s = Scratch::new().unwrap();
            s.write("kubeconfig", b"secret").unwrap();
            s.path().to_path_buf()
        };
        assert!(!path.exists());
    }

    #[test]
    fn a_long_output_keeps_its_end() {
        let s = format!("{}END", "x".repeat(5000));
        let t = tail(&s, 10);
        assert!(t.ends_with("END"));
        assert!(t.len() < 20);
    }
}
