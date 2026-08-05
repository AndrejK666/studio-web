use serde::Deserialize;

/// Configuration for the studio-llm-proxy gear.
#[derive(Debug, Clone, Deserialize)]
pub struct LlmProxyConfig {
    /// Upstream OpenAI-compatible base URL, up to and including `/v1`
    /// (no trailing slash). The proxy appends `/chat/completions`, `/models`.
    #[serde(default = "default_base_url")]
    pub base_url: String,
    /// Literal upstream API key. Wins over `api_key_env` when non-empty.
    /// Prefer the env indirection: keys don't belong in config files.
    #[serde(default)]
    pub api_key: String,
    /// Name of the environment variable holding the upstream API key.
    /// Resolved once at gear init. Missing key does not fail the boot —
    /// requests then return a clear 500 until the key is provided.
    #[serde(default = "default_api_key_env")]
    pub api_key_env: String,
}

impl Default for LlmProxyConfig {
    fn default() -> Self {
        Self {
            base_url: default_base_url(),
            api_key: String::new(),
            api_key_env: default_api_key_env(),
        }
    }
}

fn default_base_url() -> String {
    // Same upstream the mini-chat gear uses (free tier); see config/oidc.yaml.
    "https://api.mistral.ai/v1".into()
}

fn default_api_key_env() -> String {
    // Same env var that seeds the mini-chat `openai-key` credstore secret.
    "STUDIO_LLM_API_KEY".into()
}

impl LlmProxyConfig {
    /// Effective key: literal beats env; empty/whitespace counts as absent.
    pub fn resolve_api_key(&self) -> Option<String> {
        let literal = self.api_key.trim();
        if !literal.is_empty() {
            return Some(literal.to_string());
        }
        std::env::var(&self.api_key_env)
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    }
}
