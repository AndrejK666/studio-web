use serde::Deserialize;

/// Configuration for the studio-llm-proxy gear.
///
/// Provider-agnostic: any OpenAI-compatible chat-completions endpoint works
/// (cloud providers, gateways, self-hosted vLLM/Ollama, ...). There is NO
/// default provider — unconfigured simply means in-IDE AI stays off. Every
/// knob has an env override so switching providers is a restart, not a
/// config edit:
///
///   STUDIO_LLM_BASE_URL  — e.g. https://api.openai.com/v1
///   STUDIO_LLM_MODEL     — e.g. gpt-4o-mini
///   STUDIO_LLM_API_KEY   — the provider key
#[derive(Debug, Clone, Deserialize)]
pub struct LlmProxyConfig {
    /// Upstream OpenAI-compatible base URL, up to and including `/v1`
    /// (no trailing slash). The proxy appends `/chat/completions`, `/models`.
    /// Env `base_url_env` (when set and non-empty) wins over this value.
    /// No default provider on purpose — unconfigured means AI is off.
    #[serde(default)]
    pub base_url: String,
    #[serde(default = "default_base_url_env")]
    pub base_url_env: String,

    /// Literal upstream API key. Wins over `api_key_env` when non-empty.
    /// Prefer the env indirection: keys don't belong in config files.
    #[serde(default)]
    pub api_key: String,
    #[serde(default = "default_api_key_env")]
    pub api_key_env: String,

    /// Model name requested from the upstream. Advertised to IDE clients via
    /// GET /studio-llm/v1/client-config; env `model_env` wins over this.
    /// No default — must match whatever the configured provider serves.
    #[serde(default)]
    pub model: String,
    #[serde(default = "default_model_env")]
    pub model_env: String,

    /// How OpenAI clients should send system prompts to this provider:
    /// one of `user | system | developer | mergeWithFollowingUserMessage |
    /// skip` (Theia ai-openai `developerMessageSettings`). `system` is the
    /// safe choice for non-OpenAI providers; OpenAI itself accepts any.
    #[serde(default = "default_developer_message_settings")]
    pub developer_message_settings: String,
}

impl Default for LlmProxyConfig {
    fn default() -> Self {
        Self {
            base_url: String::new(),
            base_url_env: default_base_url_env(),
            api_key: String::new(),
            api_key_env: default_api_key_env(),
            model: String::new(),
            model_env: default_model_env(),
            developer_message_settings: default_developer_message_settings(),
        }
    }
}

fn default_base_url_env() -> String {
    "STUDIO_LLM_BASE_URL".into()
}
fn default_api_key_env() -> String {
    "STUDIO_LLM_API_KEY".into()
}
fn default_model_env() -> String {
    "STUDIO_LLM_MODEL".into()
}
fn default_developer_message_settings() -> String {
    "system".into()
}

fn env_non_empty(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

impl LlmProxyConfig {
    /// Effective base URL: env override beats YAML.
    pub fn resolve_base_url(&self) -> String {
        env_non_empty(&self.base_url_env)
            .unwrap_or_else(|| self.base_url.clone())
            .trim_end_matches('/')
            .to_string()
    }

    /// Effective model: env override beats YAML.
    pub fn resolve_model(&self) -> String {
        env_non_empty(&self.model_env).unwrap_or_else(|| self.model.clone())
    }

    /// Effective key: literal beats env; empty/whitespace counts as absent.
    pub fn resolve_api_key(&self) -> Option<String> {
        let literal = self.api_key.trim();
        if !literal.is_empty() {
            return Some(literal.to_string());
        }
        env_non_empty(&self.api_key_env)
    }
}
