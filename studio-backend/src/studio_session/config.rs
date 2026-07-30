use serde::Deserialize;

/// Configuration for the studio-session gear.
#[derive(Debug, Clone, Deserialize)]
pub struct StudioSessionConfig {
    /// Docker image for a Theia session (built from fabric-poc/poc/theia).
    #[serde(default = "default_image")]
    pub image: String,
    /// Host directory that stores per-workspace content; a subdirectory named
    /// by workspace id is bind-mounted into the container at /workspace.
    /// NB: when the backend itself runs in a container, this must be a HOST
    /// path that is also mounted into the backend at the same location.
    #[serde(default = "default_workspaces_root")]
    pub workspaces_root: String,
    /// Host interface the session port is published on. Keep loopback: the
    /// Theia PoC has no authentication of its own.
    #[serde(default = "default_bind_host")]
    pub bind_host: String,
    /// Hostname the browser uses to reach sessions (what we put in the URL).
    #[serde(default = "default_public_host")]
    pub public_host: String,
    /// Inclusive host port range for sessions.
    #[serde(default = "default_port_start")]
    pub port_range_start: u16,
    #[serde(default = "default_port_end")]
    pub port_range_end: u16,
    /// Stop sessions older than this (seconds). 0 disables the reaper.
    #[serde(default = "default_max_session_secs")]
    pub max_session_secs: u64,
    /// STUDIO_GIT_MODE passed to the container: disabled | commit | push.
    #[serde(default = "default_git_mode")]
    pub git_mode: String,
}

impl Default for StudioSessionConfig {
    fn default() -> Self {
        Self {
            image: default_image(),
            workspaces_root: default_workspaces_root(),
            bind_host: default_bind_host(),
            public_host: default_public_host(),
            port_range_start: default_port_start(),
            port_range_end: default_port_end(),
            max_session_secs: default_max_session_secs(),
            git_mode: default_git_mode(),
        }
    }
}

fn default_image() -> String {
    "cf-studio-theia:latest".into()
}
fn default_workspaces_root() -> String {
    "~/.cf-studio-workspaces".into()
}
fn default_bind_host() -> String {
    "127.0.0.1".into()
}
fn default_public_host() -> String {
    "localhost".into()
}
fn default_port_start() -> u16 {
    41000
}
fn default_port_end() -> u16 {
    41099
}
fn default_max_session_secs() -> u64 {
    4 * 3600
}
fn default_git_mode() -> String {
    "disabled".into()
}

impl StudioSessionConfig {
    /// Expand a leading `~` against $HOME (same convention the toolkit uses
    /// for `server.home_dir`).
    pub fn workspaces_root_expanded(&self) -> String {
        if let Some(rest) = self.workspaces_root.strip_prefix("~/") {
            if let Ok(home) = std::env::var("HOME") {
                return format!("{home}/{rest}");
            }
        }
        self.workspaces_root.clone()
    }
}
