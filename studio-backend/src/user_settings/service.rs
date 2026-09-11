//! Per-person preferences: read, replace, patch.
//!
//! The gear's whole job is to file two strings under the right key, and the
//! right key is the canonical person (ADR-0014, ADR-0017). Resolution is not
//! this gear's business — it asks `studio-user`, the gear that owns the person.

use std::sync::Arc;

use anyhow::{Result, anyhow};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::store::SettingsStore;
use crate::user_profile::PersonResolver;

/// Longest value either field accepts.
///
/// The platform gear makes this configurable and defaults to 100. Nothing has
/// ever wanted a different number, and a limit that can be raised per
/// deployment is a limit every consumer has to defend against anyway — so it is
/// a constant here until something real needs otherwise.
pub const MAX_FIELD_LEN: usize = 100;

/// One person's preferences.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Settings {
    pub user_id: Uuid,
    pub theme: Option<String>,
    pub language: Option<String>,
}

/// A partial edit. A field left `None` is untouched, not cleared.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SettingsPatch {
    pub theme: Option<String>,
    pub language: Option<String>,
}

pub struct SettingsService {
    store: Arc<dyn SettingsStore>,
    people: Arc<dyn PersonResolver>,
}

/// Reject a value the storage would silently truncate or that is blank padding.
///
/// A pure check, so the rule is stated as a test rather than discovered when
/// somebody's theme comes back cut in half.
pub fn validate(field: &str, value: &str) -> Result<()> {
    if value.chars().count() > MAX_FIELD_LEN {
        return Err(anyhow!(
            "{field} must be at most {MAX_FIELD_LEN} characters"
        ));
    }
    Ok(())
}

impl SettingsService {
    pub(crate) fn new(store: Arc<dyn SettingsStore>, people: Arc<dyn PersonResolver>) -> Self {
        Self { store, people }
    }

    /// The person behind the caller.
    ///
    /// Errors rather than falling back to the token subject. Falling back would
    /// file a caller's preferences under a key their next request may not
    /// produce, which loses them with nothing reported — the failure this gear
    /// was taken over to prevent.
    async fn person(&self, ctx: &SecurityContext) -> Result<Uuid> {
        let user_id = self.people.resolve_caller(ctx).await?;
        Uuid::parse_str(&user_id).map_err(|e| anyhow!("person id {user_id} is not a uuid: {e}"))
    }

    /// The caller's preferences, empty rather than absent when never set.
    ///
    /// An unset preference is a normal state, not a missing resource: a client
    /// asking "what is my theme" deserves "none yet", not a 404 it has to
    /// special-case. (The platform gear answers the same way; the prototype's
    /// 404 handling around it was defensive, not required.)
    pub async fn get(&self, ctx: &SecurityContext) -> Result<Settings> {
        let user_id = self.person(ctx).await?;
        Ok(self.store.get(user_id).await?.unwrap_or(Settings {
            user_id,
            theme: None,
            language: None,
        }))
    }

    /// Replace both fields.
    pub async fn replace(
        &self,
        ctx: &SecurityContext,
        theme: &str,
        language: &str,
    ) -> Result<Settings> {
        validate("theme", theme)?;
        validate("language", language)?;
        let settings = Settings {
            user_id: self.person(ctx).await?,
            theme: Some(theme.to_owned()),
            language: Some(language.to_owned()),
        };
        self.store.upsert(&settings).await?;
        Ok(settings)
    }

    /// Change the fields the patch names and leave the rest alone.
    ///
    /// Read-modify-write rather than a partial UPDATE: two fields, one row, and
    /// the alternative is a column list assembled at runtime. Two concurrent
    /// patches from one person can lose the earlier one's field — which is a
    /// person racing themselves across two tabs, and the loser is a preference
    /// they can set again.
    pub async fn patch(&self, ctx: &SecurityContext, patch: &SettingsPatch) -> Result<Settings> {
        if let Some(theme) = patch.theme.as_deref() {
            validate("theme", theme)?;
        }
        if let Some(language) = patch.language.as_deref() {
            validate("language", language)?;
        }
        let user_id = self.person(ctx).await?;
        let current = self.store.get(user_id).await?;
        let settings = Settings {
            user_id,
            theme: patch
                .theme
                .clone()
                .or_else(|| current.as_ref().and_then(|c| c.theme.clone())),
            language: patch
                .language
                .clone()
                .or_else(|| current.as_ref().and_then(|c| c.language.clone())),
        };
        self.store.upsert(&settings).await?;
        Ok(settings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_value_at_the_limit_is_accepted_and_one_past_it_is_not() {
        assert!(validate("theme", &"a".repeat(MAX_FIELD_LEN)).is_ok());
        let err = validate("theme", &"a".repeat(MAX_FIELD_LEN + 1))
            .expect_err("one character too many must be refused");
        assert!(
            err.to_string().contains("theme"),
            "the refusal must name the field, got: {err}"
        );
    }

    #[test]
    fn the_limit_counts_characters_not_bytes() {
        // A multi-byte theme name is not three times shorter than an ASCII one.
        // Counting bytes here would refuse a value the column holds fine.
        assert!(validate("language", &"я".repeat(MAX_FIELD_LEN)).is_ok());
    }

    #[test]
    fn an_empty_value_is_allowed_because_clearing_a_preference_is_normal() {
        assert!(validate("theme", "").is_ok());
    }
}
