//! The hypothesis check methods a kit adds (PRD "Validate product
//! hypotheses", fr-method-reference): five are built into the portal, and a
//! kit installed in the project may describe more in
//! `.cf-studio/config/kits/<kit>/check-methods.json`, a JSON array of
//! methods. Each says the uncertainty it addresses, what it needs, what it
//! does and what a result of it cannot establish, and the words in a claim it
//! applies to. Read as written; a file that does not follow this shape is
//! refused whole, with the reason, rather than read in part.

use serde::Deserialize;

/// Most kits one call reads.
pub const KITS_MAX: usize = 20;
/// Most methods one kit may add.
pub const METHODS_MAX: usize = 30;
/// The largest `check-methods.json` read.
pub const FILE_MAX: usize = 64 * 1024;

/// Where a kit keeps its methods in the project's repository.
pub fn path_of(kit: &str) -> String {
    format!(".cf-studio/config/kits/{kit}/check-methods.json")
}

/// A kit's slug as the kit registry names it: lowercase letters, digits and
/// dashes, so it is safe inside a path.
pub fn is_kit_slug(kit: &str) -> bool {
    !kit.is_empty()
        && kit.len() <= 64
        && kit
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !kit.starts_with('-')
}

/// One method as a kit describes it.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KitMethod {
    pub id: String,
    pub label: String,
    pub uncertainty: String,
    #[serde(default)]
    pub inputs: String,
    pub action: String,
    pub limits: String,
    #[serde(default)]
    pub applies_to: Vec<String>,
}

/// The methods in one kit's file, or why the file is refused.
pub fn parse(text: &str) -> Result<Vec<KitMethod>, String> {
    if text.len() > FILE_MAX {
        return Err(format!("larger than {} KiB", FILE_MAX / 1024));
    }
    let methods: Vec<KitMethod> =
        serde_json::from_str(text).map_err(|e| format!("not a list of methods: {e}"))?;
    if methods.len() > METHODS_MAX {
        return Err(format!("more than {METHODS_MAX} methods"));
    }
    let short = |s: &str, max: usize| !s.trim().is_empty() && s.len() <= max;
    for (n, m) in methods.iter().enumerate() {
        let at = || format!("method {}", n + 1);
        if !is_kit_slug(&m.id) {
            return Err(format!(
                "{}: the id must be lowercase letters, digits and dashes",
                at()
            ));
        }
        if !short(&m.label, 80) {
            return Err(format!("{}: a label of at most 80 bytes", at()));
        }
        if !(short(&m.uncertainty, 600) && short(&m.action, 600) && short(&m.limits, 600))
            || m.inputs.len() > 600
        {
            return Err(format!(
                "{}: uncertainty, action and limits are each needed, at most 600 bytes",
                at()
            ));
        }
        if m.applies_to.len() > 20 || m.applies_to.iter().any(|w| !short(w, 60)) {
            return Err(format!(
                "{}: applies_to is at most 20 words or phrases",
                at()
            ));
        }
        if methods[..n].iter().any(|o| o.id == m.id) {
            return Err(format!("{}: the id {} is used twice", at(), m.id));
        }
    }
    Ok(methods)
}

#[cfg(test)]
#[path = "check_methods_tests.rs"]
mod tests;
