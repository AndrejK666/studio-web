//! Configuration for the persistent credstore value-store plugin.

use serde::Deserialize;

/// Plugin configuration.
///
/// Deliberately free of secret material: the encryption key is read from the
/// environment (see [`PgCredStorePluginConfig::key_env`]) so it never lands in
/// a YAML profile, a container image layer, or `--print-config` output.
#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct PgCredStorePluginConfig {
    /// Vendor name for GTS instance registration. Must match `credstore.vendor`
    /// — the resolver only considers instances of its own vendor.
    pub vendor: String,

    /// Plugin priority; LOWER wins. Must be below `static-credstore-plugin`
    /// (100) for this plugin to be selected, because credstore picks exactly
    /// ONE backend per vendor (`toolkit::plugins::choose_plugin_instance`).
    pub priority: i16,

    /// Environment variable holding the base64-encoded 32-byte AES-256-GCM key.
    ///
    /// Unset/empty → the gear logs a WARN and does not register, leaving
    /// `static-credstore-plugin` to win the selection (in-memory values, the
    /// pre-#66 behaviour). Set but malformed → boot fails loudly, because a
    /// typo'd key that silently degrades would only surface as lost secrets
    /// after the next restart.
    pub key_env: String,
}

impl Default for PgCredStorePluginConfig {
    fn default() -> Self {
        Self {
            vendor: "constructorfabric".to_owned(),
            priority: 50,
            key_env: "STUDIO_CREDSTORE_KEY".to_owned(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::PgCredStorePluginConfig;

    #[test]
    fn defaults_win_the_selection_against_the_static_plugin() {
        let cfg = PgCredStorePluginConfig::default();
        // Same vendor as CredStoreConfig::default() / every Studio profile:
        // a mismatch means the resolver never sees this plugin at all.
        assert_eq!(cfg.vendor, "constructorfabric");
        // static-credstore-plugin sits at 100 and lower wins.
        assert!(cfg.priority < 100);
        assert_eq!(cfg.key_env, "STUDIO_CREDSTORE_KEY");
    }

    #[test]
    fn deserializes_partial_config_with_defaults() {
        let cfg: PgCredStorePluginConfig =
            serde_json::from_str(r#"{"priority":10}"#).expect("deserialize");
        assert_eq!(cfg.priority, 10);
        assert_eq!(cfg.vendor, "constructorfabric");
        assert_eq!(cfg.key_env, "STUDIO_CREDSTORE_KEY");
    }

    /// Every shipped profile, paired with its file name for assertion messages.
    /// `include_str!` makes them a compile-time input of this test, so a
    /// profile cannot drift away from the code without the suite noticing.
    /// (Test-only, so the release image never evaluates these.)
    const PROFILES: [(&str, &str); 5] = [
        ("dev.yaml", include_str!("../../config/dev.yaml")),
        ("docker.yaml", include_str!("../../config/docker.yaml")),
        ("oidc.yaml", include_str!("../../config/oidc.yaml")),
        ("postgres.yaml", include_str!("../../config/postgres.yaml")),
        ("k8s.yaml", include_str!("../../config/k8s.yaml")),
    ];

    /// The `priority:` declared inside one gear's section of a profile.
    ///
    /// Deliberately a line scan rather than a YAML parse: this crate carries no
    /// YAML dependency, and the invariant under test is one number against
    /// another. It relies on the profiles' two-space gear indentation, which is
    /// uniform across all five files.
    fn gear_priority(profile: &str, gear: &str) -> Option<i16> {
        let header = format!("  {gear}:");
        let mut lines = profile.lines().skip_while(|l| l.trim_end() != header.as_str());
        lines.next()?; // consume the gear header itself
        for line in lines {
            let trimmed = line.trim_start();
            // Any non-blank, non-comment line at gear indentation starts the
            // next gear and therefore ends this section.
            if !line.starts_with("   ") && !trimmed.is_empty() && !trimmed.starts_with('#') {
                break;
            }
            if let Some(rest) = trimmed.strip_prefix("priority:") {
                return rest.split('#').next()?.trim().parse().ok();
            }
        }
        None
    }

    #[test]
    fn the_scan_finds_the_priority_it_is_supposed_to_find() {
        // Guards the assertion below against silently matching nothing.
        let docker = PROFILES
            .iter()
            .find(|(name, _)| *name == "docker.yaml")
            .expect("docker.yaml in PROFILES")
            .1;
        assert_eq!(gear_priority(docker, "static-credstore-plugin"), Some(100));
        assert_eq!(gear_priority(docker, "studio-credstore-pg"), Some(50));
        assert_eq!(gear_priority(docker, "no-such-gear"), None);
    }

    #[test]
    fn wherever_this_gear_is_enabled_it_outranks_the_static_plugin() {
        // credstore selects ONE backend plugin per vendor, lowest priority
        // wins. A profile where the static plugin ranked at or above this gear
        // would quietly go back to in-memory values — the exact #66 symptom,
        // and one that only shows up after a restart eats somebody's token.
        for (name, profile) in PROFILES {
            let Some(pg) = gear_priority(profile, "studio-credstore-pg") else {
                continue; // profile deliberately keeps the static plugin
            };
            let static_prio = gear_priority(profile, "static-credstore-plugin")
                .unwrap_or_else(|| panic!("{name}: static-credstore-plugin has no priority"));
            assert!(
                pg < static_prio,
                "{name}: studio-credstore-pg priority {pg} must be BELOW \
                 static-credstore-plugin's {static_prio}, or credstore keeps \
                 selecting the in-memory value store and secret values stop \
                 surviving a restart (issue #66)"
            );
        }
    }

    #[test]
    fn profiles_that_enable_this_gear_name_the_env_var_the_code_reads() {
        // A rename on one side only would land as "plugin NOT registered" in
        // the log and nothing else.
        let default_env = PgCredStorePluginConfig::default().key_env;
        for (name, profile) in PROFILES {
            if gear_priority(profile, "studio-credstore-pg").is_none() {
                continue;
            }
            assert!(
                profile.contains(&format!("key_env: \"{default_env}\"")),
                "{name}: enables studio-credstore-pg but does not set \
                 key_env: \"{default_env}\""
            );
        }
    }
}
