//! Retired kit slugs and what they resolve to (ADR-0071 §8): the alias
//! table, read for one release after a merge or a rename.
//!
//! Empty until the merges of step 5 retire their first slugs.

/// A retired slug, the kits it resolves to (none: the shell's), and when the
/// alias goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Alias {
    pub retired: &'static str,
    pub resolves_to: &'static [&'static str],
    pub removal: &'static str,
}

/// The alias table.
pub const ALIASES: &[Alias] = &[];

/// What `slug` resolves to when it is retired; `None` for a current slug.
pub fn resolve(slug: &str) -> Option<&'static [&'static str]> {
    ALIASES
        .iter()
        .find(|a| a.retired == slug)
        .map(|a| a.resolves_to)
}
