use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, anyhow};
use bollard::Docker;
use bollard::container::{
    Config as ContainerConfig, CreateContainerOptions, ListContainersOptions,
    RemoveContainerOptions, StopContainerOptions,
};
use bollard::service::{HostConfig, PortBinding};
use tokio::sync::RwLock;
use uuid::Uuid;

use super::config::StudioSessionConfig;

const SESSION_LABEL: &str = "cf.studio.session";
const WS_LABEL: &str = "cf.studio.workspace_id";
const TENANT_LABEL: &str = "cf.studio.tenant_id";
const PORT_LABEL: &str = "cf.studio.port";
const THEIA_PORT: &str = "3003/tcp";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionState {
    Starting,
    Running,
    Stopped,
}

impl SessionState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Stopped => "stopped",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Session {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub tenant_id: Uuid,
    pub container_id: String,
    pub port: u16,
    pub state: SessionState,
    pub created_at_epoch_secs: u64,
    pub repo_url: Option<String>,
}

pub struct SessionService {
    cfg: StudioSessionConfig,
    docker: Docker,
    sessions: RwLock<HashMap<Uuid, Session>>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

impl SessionService {
    pub fn new(cfg: StudioSessionConfig) -> anyhow::Result<Arc<Self>> {
        let docker = Docker::connect_with_local_defaults()
            .context("cannot connect to the Docker daemon (is /var/run/docker.sock available?)")?;
        Ok(Arc::new(Self {
            cfg,
            docker,
            sessions: RwLock::new(HashMap::new()),
        }))
    }

    pub fn session_url(&self, port: u16) -> String {
        format!("http://{}:{port}/", self.cfg.public_host)
    }

    /// Fail early with a clear message if the Theia image is missing.
    pub async fn ensure_image(&self) -> anyhow::Result<()> {
        self.docker.inspect_image(&self.cfg.image).await.map_err(|_| {
            anyhow!(
                "Theia image '{}' not found — build it first: \
                 cd fabric-poc/poc/theia && docker build -t {} .",
                self.cfg.image,
                self.cfg.image
            )
        })?;
        Ok(())
    }

    /// Create (or return the existing) session for a workspace.
    /// Idempotency key: (tenant, workspace).
    pub async fn create(
        &self,
        tenant_id: Uuid,
        actor_id: Uuid,
        workspace_id: Uuid,
        repo_url: Option<String>,
    ) -> anyhow::Result<(Session, bool /* already_existed */)> {
        {
            let sessions = self.sessions.read().await;
            if let Some(existing) = sessions.values().find(|s| {
                s.workspace_id == workspace_id
                    && s.tenant_id == tenant_id
                    && s.state != SessionState::Stopped
            }) {
                return Ok((existing.clone(), true));
            }
        }

        self.ensure_image().await?;

        // Workspace directory on the host (bind-mount source).
        let root = self.cfg.workspaces_root_expanded();
        let ws_dir = format!("{root}/{workspace_id}");
        std::fs::create_dir_all(&ws_dir)
            .with_context(|| format!("cannot create workspace dir {ws_dir}"))?;

        let port = self.allocate_port().await?;
        let session_id = Uuid::new_v4();
        let name = format!("cf-studio-session-{workspace_id}");

        let mut env = vec![
            format!("STUDIO_WORKSPACE_ID={workspace_id}"),
            format!("STUDIO_ACTOR_ID={actor_id}"),
            format!("STUDIO_GIT_MODE={}", self.cfg.git_mode),
        ];
        if let Some(url) = &repo_url {
            env.push(format!("STUDIO_REPO_URL={url}"));
        }

        let labels: HashMap<String, String> = HashMap::from([
            (SESSION_LABEL.into(), "1".into()),
            (WS_LABEL.into(), workspace_id.to_string()),
            (TENANT_LABEL.into(), tenant_id.to_string()),
            (PORT_LABEL.into(), port.to_string()),
        ]);

        let host_config = HostConfig {
            binds: Some(vec![format!("{ws_dir}:/workspace")]),
            port_bindings: Some(HashMap::from([(
                THEIA_PORT.to_string(),
                Some(vec![PortBinding {
                    host_ip: Some(self.cfg.bind_host.clone()),
                    host_port: Some(port.to_string()),
                }]),
            )])),
            ..Default::default()
        };

        let created = self
            .docker
            .create_container(
                Some(CreateContainerOptions {
                    name: name.as_str(),
                    platform: None,
                }),
                ContainerConfig {
                    image: Some(self.cfg.image.clone()),
                    env: Some(env),
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

        let session = Session {
            id: session_id,
            workspace_id,
            tenant_id,
            container_id: created.id,
            port,
            state: SessionState::Starting,
            created_at_epoch_secs: now_secs(),
            repo_url,
        };
        self.sessions
            .write()
            .await
            .insert(session_id, session.clone());
        Ok((session, false))
    }

    /// Refresh state: Starting → Running once the Theia port accepts TCP.
    pub async fn get(&self, tenant_id: Uuid, id: Uuid) -> Option<Session> {
        let mut sessions = self.sessions.write().await;
        let session = sessions.get_mut(&id)?;
        if session.tenant_id != tenant_id {
            return None; // tenant isolation: not yours == not found
        }
        if session.state == SessionState::Starting {
            let addr = format!("127.0.0.1:{}", session.port);
            let reachable = tokio::time::timeout(
                Duration::from_millis(500),
                tokio::net::TcpStream::connect(&addr),
            )
            .await
            .map(|r| r.is_ok())
            .unwrap_or(false);
            if reachable {
                session.state = SessionState::Running;
            }
        }
        Some(session.clone())
    }

    pub async fn list(&self, tenant_id: Uuid) -> Vec<Session> {
        self.sessions
            .read()
            .await
            .values()
            .filter(|s| s.tenant_id == tenant_id)
            .cloned()
            .collect()
    }

    pub async fn stop(&self, tenant_id: Uuid, id: Uuid) -> anyhow::Result<bool> {
        let session = {
            let sessions = self.sessions.read().await;
            match sessions.get(&id) {
                Some(s) if s.tenant_id == tenant_id => s.clone(),
                _ => return Ok(false),
            }
        };
        self.remove_container(&session.container_id).await?;
        self.sessions.write().await.remove(&id);
        Ok(true)
    }

    async fn remove_container(&self, container_id: &str) -> anyhow::Result<()> {
        let _ = self
            .docker
            .stop_container(container_id, Some(StopContainerOptions { t: 10 }))
            .await; // already stopped is fine
        self.docker
            .remove_container(
                container_id,
                Some(RemoveContainerOptions {
                    force: true,
                    ..Default::default()
                }),
            )
            .await
            .context("docker rm failed")?;
        Ok(())
    }

    /// Next free port in the configured range (not used by known sessions).
    async fn allocate_port(&self) -> anyhow::Result<u16> {
        let sessions = self.sessions.read().await;
        let used: Vec<u16> = sessions.values().map(|s| s.port).collect();
        (self.cfg.port_range_start..=self.cfg.port_range_end)
            .find(|p| !used.contains(p))
            .ok_or_else(|| anyhow!("no free session ports in the configured range"))
    }

    /// Adopt labeled containers left over from a previous backend run, so a
    /// restart does not orphan running IDE sessions.
    pub async fn adopt_existing(&self) -> anyhow::Result<usize> {
        let containers = self
            .docker
            .list_containers(Some(ListContainersOptions {
                all: true,
                filters: HashMap::from([(
                    "label".to_string(),
                    vec![format!("{SESSION_LABEL}=1")],
                )]),
                ..Default::default()
            }))
            .await
            .context("docker ps failed")?;

        let mut adopted = 0;
        let mut sessions = self.sessions.write().await;
        for c in containers {
            let labels = c.labels.unwrap_or_default();
            let (Some(ws), Some(tenant), Some(port)) = (
                labels.get(WS_LABEL).and_then(|v| v.parse::<Uuid>().ok()),
                labels.get(TENANT_LABEL).and_then(|v| v.parse::<Uuid>().ok()),
                labels.get(PORT_LABEL).and_then(|v| v.parse::<u16>().ok()),
            ) else {
                continue;
            };
            let running = c.state.as_deref() == Some("running");
            let id = Uuid::new_v4();
            sessions.insert(
                id,
                Session {
                    id,
                    workspace_id: ws,
                    tenant_id: tenant,
                    container_id: c.id.unwrap_or_default(),
                    port,
                    state: if running {
                        SessionState::Running
                    } else {
                        SessionState::Stopped
                    },
                    created_at_epoch_secs: c.created.map(|v| v as u64).unwrap_or_else(now_secs),
                    repo_url: None,
                },
            );
            adopted += 1;
        }
        Ok(adopted)
    }

    /// Reaper pass: stop sessions past max_session_secs. Returns reaped count.
    pub async fn reap_expired(&self) -> usize {
        if self.cfg.max_session_secs == 0 {
            return 0;
        }
        let cutoff = now_secs().saturating_sub(self.cfg.max_session_secs);
        let expired: Vec<Session> = self
            .sessions
            .read()
            .await
            .values()
            .filter(|s| s.created_at_epoch_secs < cutoff && s.state != SessionState::Stopped)
            .cloned()
            .collect();
        let mut reaped = 0;
        for s in expired {
            if self.remove_container(&s.container_id).await.is_ok() {
                self.sessions.write().await.remove(&s.id);
                reaped += 1;
            }
        }
        reaped
    }
}
