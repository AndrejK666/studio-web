//! Docker session driver (ADR-0003 MVP).
//!
//! One container per workspace on the local daemon (bollard over the socket),
//! published on a loopback port. This is the whole of the Docker-specific code
//! behind [`SessionDriver`]; everything else lives in
//! [`SessionService`](super::service::SessionService).

use std::collections::HashMap;

use anyhow::{Context, anyhow};
use async_trait::async_trait;
use bollard::Docker;
use bollard::container::{
    Config as ContainerConfig, CreateContainerOptions, ListContainersOptions,
    RemoveContainerOptions, StopContainerOptions,
};
use bollard::service::{HostConfig, PortBinding};
use uuid::Uuid;

use super::config::StudioSessionConfig;
use super::driver::{AdoptedSession, LaunchSpec, LaunchedSession, SessionAddress, SessionDriver};

const SESSION_LABEL: &str = "cf.studio.session";
const WS_LABEL: &str = "cf.studio.workspace_id";
const TENANT_LABEL: &str = "cf.studio.tenant_id";
const PORT_LABEL: &str = "cf.studio.port";
const THEIA_PORT: &str = "3003/tcp";

pub struct DockerDriver {
    docker: Docker,
    cfg: StudioSessionConfig,
}

impl DockerDriver {
    /// Connect to the local daemon. Fails when `/var/run/docker.sock` is
    /// absent (k8s node, CI) — the gear turns that into "sessions disabled".
    pub fn connect(cfg: StudioSessionConfig) -> anyhow::Result<Self> {
        let docker = Docker::connect_with_local_defaults()
            .context("cannot connect to the Docker daemon (is /var/run/docker.sock available?)")?;
        Ok(Self { docker, cfg })
    }

    /// Read a container's env back out of the daemon. Empty when the container
    /// cannot be inspected or predates the gate (older image): the session is
    /// then adopted ungated, and a relaunch mints a fresh token.
    ///
    /// `docker ps` does not carry env, so this costs one inspect per adopted
    /// container — a handful, once, at startup. Everything it returns is
    /// already in the container's env, so it hands out nothing new.
    async fn adopted_env(&self, container_id: &str) -> Vec<String> {
        if container_id.is_empty() {
            return Vec::new();
        }
        let inspected = match self.docker.inspect_container(container_id, None).await {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(
                    container_id,
                    "studio-session: cannot inspect adopted container ({e}) — \
                     it will need a relaunch to be opened from the portal"
                );
                return Vec::new();
            }
        };
        inspected.config.and_then(|c| c.env).unwrap_or_default()
    }
}

/// One `KEY=value` lookup in a container's env.
fn env_value<'a>(env: &'a [String], key: &str) -> Option<&'a str> {
    let prefix = format!("{key}=");
    env.iter().find_map(|kv| kv.strip_prefix(&prefix))
}

#[async_trait]
impl SessionDriver for DockerDriver {
    async fn image_present(&self) -> bool {
        self.docker.inspect_image(&self.cfg.image).await.is_ok()
    }

    /// One registry pull. NB: the Docker API ignores `docker login`'s
    /// client-side credential store — private registries need explicit
    /// credentials (env-driven, see [`StudioSessionConfig::registry_credentials`]).
    async fn refresh_image(&self) -> anyhow::Result<()> {
        let pull = self.docker.create_image(
            Some(bollard::image::CreateImageOptions {
                from_image: self.cfg.image.clone(),
                ..Default::default()
            }),
            None,
            self.cfg.registry_credentials(),
        );
        use futures_util::TryStreamExt;
        pull.try_collect::<Vec<_>>()
            .await
            .map(|_| ())
            .map_err(|e| anyhow!("{e}"))
    }

    async fn launch(&self, spec: &LaunchSpec) -> anyhow::Result<LaunchedSession> {
        let labels: HashMap<String, String> = spec.labels.clone();

        // Workspace root + one bind per local source (at its target path).
        let mut binds = vec![format!("{}:/workspace", spec.workspace_host_dir)];
        for b in &spec.local_binds {
            binds.push(format!("{}:/workspace/{}", b.host_path, b.target));
        }

        let host_config = HostConfig {
            binds: Some(binds),
            port_bindings: Some(HashMap::from([(
                THEIA_PORT.to_string(),
                Some(vec![PortBinding {
                    host_ip: Some(self.cfg.bind_host.clone()),
                    host_port: Some(spec.port.to_string()),
                }]),
            )])),
            ..Default::default()
        };

        // A dead container may still hold the deterministic name (entrypoint
        // crash leaves it Exited; a stale one survives backend restarts). The
        // service only reaches launch when no LIVE session exists for the
        // workspace, so clearing the name-holder is always safe.
        if let Err(e) = self.destroy(&spec.name).await {
            tracing::debug!(
                "studio-session: no stale container '{}' to clear ({e:#})",
                spec.name
            );
        } else {
            tracing::warn!(
                "studio-session: removed stale container '{}' left over from a failed/killed session",
                spec.name
            );
        }

        let created = self
            .docker
            .create_container(
                Some(CreateContainerOptions {
                    name: spec.name.as_str(),
                    platform: None,
                }),
                ContainerConfig {
                    image: Some(spec.image.clone()),
                    env: Some(spec.env.clone()),
                    labels: Some(labels),
                    host_config: Some(host_config),
                    ..Default::default()
                },
            )
            .await
            .context(
                "docker create failed (name conflict? a stale session container \
                 from a previous run may need removing)",
            )?;

        self.docker
            .start_container::<String>(&created.id, None)
            .await
            .context("docker start failed")?;

        Ok(LaunchedSession {
            handle: created.id,
            address: SessionAddress::Loopback { port: spec.port },
        })
    }

    async fn is_running(&self, handle: &str) -> bool {
        match self.docker.inspect_container(handle, None).await {
            Ok(info) => info.state.as_ref().and_then(|s| s.running).unwrap_or(false),
            Err(_) => false,
        }
    }

    async fn is_reachable(&self, address: &SessionAddress) -> bool {
        let addr = match address {
            SessionAddress::Loopback { port } => format!("127.0.0.1:{port}"),
            SessionAddress::Service { host, port } => format!("{host}:{port}"),
        };
        tokio::time::timeout(
            std::time::Duration::from_millis(500),
            tokio::net::TcpStream::connect(&addr),
        )
        .await
        .map(|r| r.is_ok())
        .unwrap_or(false)
    }

    async fn destroy(&self, handle: &str) -> anyhow::Result<()> {
        let _ = self
            .docker
            .stop_container(handle, Some(StopContainerOptions { t: 10 }))
            .await; // already stopped is fine
        self.docker
            .remove_container(
                handle,
                Some(RemoveContainerOptions {
                    force: true,
                    ..Default::default()
                }),
            )
            .await
            .context("docker rm failed")?;
        Ok(())
    }

    async fn list_adoptable(&self) -> anyhow::Result<Vec<AdoptedSession>> {
        let containers = self
            .docker
            .list_containers(Some(ListContainersOptions {
                all: true,
                filters: HashMap::from([("label".to_string(), vec![format!("{SESSION_LABEL}=1")])]),
                ..Default::default()
            }))
            .await
            .context("docker ps failed")?;

        let mut out = Vec::new();
        for c in containers {
            let labels = c.labels.clone().unwrap_or_default();
            let (Some(ws), Some(tenant), Some(port)) = (
                labels.get(WS_LABEL).and_then(|v| v.parse::<Uuid>().ok()),
                labels
                    .get(TENANT_LABEL)
                    .and_then(|v| v.parse::<Uuid>().ok()),
                labels.get(PORT_LABEL).and_then(|v| v.parse::<u16>().ok()),
            ) else {
                continue;
            };
            let container_id = c.id.clone().unwrap_or_default();
            // Recover what the container was started with: the gate token, the
            // Theia control token, and the sources the summary is built from.
            let env = self.adopted_env(&container_id).await;
            out.push(AdoptedSession {
                workspace_id: ws,
                tenant_id: tenant,
                handle: container_id,
                address: SessionAddress::Loopback { port },
                running: c.state.as_deref() == Some("running"),
                created_at_epoch_secs: c.created.map(|v| v as u64).unwrap_or(0),
                session_token: env_value(&env, "STUDIO_SESSION_TOKEN")
                    .unwrap_or_default()
                    .to_string(),
                control_token: env_value(&env, "STUDIO_THEIA_S2S_TOKEN")
                    .unwrap_or_default()
                    .to_string(),
                sources: super::driver::adopted_sources(
                    env_value(&env, "STUDIO_ROOT_URL"),
                    env_value(&env, "STUDIO_SOURCES"),
                ),
            });
        }
        Ok(out)
    }
}
