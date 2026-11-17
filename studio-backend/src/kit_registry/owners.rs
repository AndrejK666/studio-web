//! Which built-in kit brings each piece of the model now (ADR-0071 §6, §8):
//! the table the `kit-rename` sweep rewrites an organization's stored kit
//! marks by.
//!
//! An organization's model records, on every type, field, relation, tab and
//! lifecycle a kit brought or claims, the kit's slug (`meta.kit`, a
//! property's `kit`, `left_by.kit`). When a screen and its types move to
//! another built-in kit (step 4: Issues and `finding` to
//! `project-domain-model`), or a kit is merged into another under a new slug
//! (step 5), those marks name a kit that no longer brings the piece. Left so,
//! the old kit's reconciliation would make the piece dormant and the new
//! kit's would find it taken (`KIT_MODEL_CONFLICT`). The sweep instead moves
//! each mark to the kit that brings the piece today, as one model version
//! with no inverse, before any kit's overlay is applied.
//!
//! Only marks of Studio's own kits move: a built-in kit's slug or a retired
//! one ([`super::aliases`]). An organization's own kit keeps its marks.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use super::claims::builtin_manifests;
use super::manifest::{KitManifest, overlay_of};

/// What a kit mark sits on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarkOn<'a> {
    /// A type (`meta.kit`, `meta.left_by.kit`).
    Type,
    /// A field, relation or tab of the type, by name.
    Property(&'a str),
    /// A lifecycle of the type, by its field.
    Lifecycle(&'a str),
}

/// Where a mark goes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Rehome {
    /// To this kit, which brings the piece now.
    Kit(String),
    /// To Studio's core: the retired kit's screen went to the shell, and the
    /// core declares the piece again (ADR-0071 §6, "to the shell"). The mark
    /// goes and the piece is adopted (`adopted_from` = the old kit).
    Core,
}

/// The owners of the model's pieces among the built-in kits.
#[derive(Clone, Debug, Default)]
pub struct KitOwners {
    types: BTreeMap<String, String>,
    properties: BTreeMap<(String, String), String>,
    lifecycles: BTreeMap<(String, String), String>,
    kits: BTreeSet<String>,
}

impl KitOwners {
    /// The owners the built-in kits' manifests say, read once.
    pub fn builtin() -> &'static Self {
        static OWNERS: OnceLock<KitOwners> = OnceLock::new();
        OWNERS.get_or_init(|| Self::of(&builtin_manifests()))
    }

    /// The owners `kits` declare: the types, fields, relations, tabs and
    /// lifecycles of their overlays, and the gear types they claim.
    pub fn of(kits: &[KitManifest]) -> Self {
        let mut out = Self::default();
        for m in kits {
            let slug = m.slug.clone();
            out.kits.insert(slug.clone());
            for g in &m.gears {
                for t in &g.types {
                    out.types.entry(t.clone()).or_insert_with(|| slug.clone());
                }
            }
            let Ok(Some(o)) = overlay_of(m) else {
                continue;
            };
            // `on`, `level` name a type by its id, or one of the kit's own by
            // its `name`.
            let entity = |name: &str| -> String {
                o.types
                    .iter()
                    .find(|t| t.name == name)
                    .map_or_else(|| name.to_owned(), |t| t.entity_id(&m.slug))
            };
            for t in &o.types {
                out.types
                    .entry(t.entity_id(&m.slug))
                    .or_insert_with(|| slug.clone());
            }
            let mut property = |on: String, name: &str| {
                out.properties
                    .entry((on, name.to_owned()))
                    .or_insert_with(|| slug.clone());
            };
            for f in &o.fields {
                property(entity(&f.on), &f.name);
            }
            for r in &o.relations {
                property(entity(&r.on), &r.name);
            }
            for t in &o.tabs {
                property(entity(&t.level), &t.name);
            }
            for p in &o.properties {
                if let Some(name) = p.property.get("name").and_then(|n| n.as_str()) {
                    property(entity(&p.on), name);
                }
            }
            for l in &o.lifecycles {
                out.lifecycles
                    .entry((entity(&l.on), l.field.clone()))
                    .or_insert_with(|| slug.clone());
            }
        }
        out
    }

    /// The built-in kit that brings `on` of type `entity` now: its own entry,
    /// else the type's (a field of a kit's own type comes with the type).
    pub fn owner(&self, entity: &str, on: MarkOn<'_>) -> Option<&str> {
        let own = match on {
            MarkOn::Type => None,
            MarkOn::Property(name) => self.properties.get(&(entity.to_owned(), name.to_owned())),
            MarkOn::Lifecycle(field) => self.lifecycles.get(&(entity.to_owned(), field.to_owned())),
        };
        own.or_else(|| self.types.get(entity)).map(String::as_str)
    }

    /// Whether `slug` is one of the built-in kits these owners are read from.
    pub fn is_builtin(&self, slug: &str) -> bool {
        self.kits.contains(slug)
    }

    /// Where a mark naming `kit` on `on` of type `entity` goes; `None` when it
    /// stays: an organization's own kit, the kit still brings it, or no
    /// built-in kit brings it (it is the kit's to leave dormant, as an
    /// uninstall does).
    pub fn rehome(&self, kit: &str, entity: &str, on: MarkOn<'_>) -> Option<Rehome> {
        let retired = super::aliases::resolve(kit);
        if !self.is_builtin(kit) && retired.is_none() {
            return None;
        }
        match self.owner(entity, on) {
            Some(owner) if owner == kit => None,
            Some(owner) => Some(Rehome::Kit(owner.to_owned())),
            // A retired kit's piece that no built-in kit brings: the shell's
            // when the slug went to the shell, else the first kit it went to.
            None => match retired {
                Some([]) => Some(Rehome::Core),
                Some([first, ..]) => Some(Rehome::Kit((*first).to_owned())),
                None => None,
            },
        }
    }
}

#[cfg(test)]
#[path = "owners_tests.rs"]
mod tests;
