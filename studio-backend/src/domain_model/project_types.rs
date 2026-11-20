//! "Is this type a Project": the one is-a check every reader of project
//! objects asks (ADR-0073 amendment, studio-web#1118).
//!
//! A project type is a kit's subtype of the core Project type: an entity
//! whose `extends` chain reaches `project`, catalogued under a GTS id chained
//! onto Project's (`gts.cf.studio.domain.project.v1~cf.studio.kit_<kit>.project.v1~`,
//! `meta.gts`). A project's object is stored as that subtype, so graph-storage
//! validates the subtype's own fields on write, and a reader that wants "the
//! projects" asks for every type that **is a** Project rather than for the
//! string `project`.
//!
//! Two ways to the same answer, both kept in step:
//!
//! - by the model: the entity is `project` or one of its ancestors is
//!   ([`Ontology::ancestors`], the overlay's `extends`);
//! - by the GTS id alone: the type id is Project's or chained onto it
//!   ([`is_project_type_id`]), for a reader holding only a stored type id.
//!
//! Only a Project subtype is stored under its chained id. Every other type,
//! a kit's own types that extend `record` or `managed-object` included, keeps
//! the flat id its entity gives ([`super::gts::node_type_id`]): their objects
//! were written that way, and moving them is not this change.

use serde_json::Value;

use super::Ontology;
use crate::domain_model::gts;

/// The core type a project is (ADR-0010).
pub const PROJECT: &str = "project";

/// The GTS id of the core Project type, `gts.cf.studio.domain.project.v1~`.
pub fn project_type_id() -> String {
    gts::node_type_id(PROJECT)
}

/// Is the GTS type id Project's, or chained onto it (a Project subtype)?
pub fn is_project_type_id(type_id: &str) -> bool {
    type_id.starts_with(&project_type_id())
}

/// Is `type_id` the GTS id of a type derived from `base` (a type id ending in
/// `~`) by exactly one more well-formed segment,
/// `vendor.package.namespace.type.vN~`? What a stored subtype id must be:
/// graph-storage refuses anything else.
fn is_chained_onto(type_id: &str, base: &str) -> bool {
    let Some(own) = type_id.strip_prefix(base) else {
        return false;
    };
    let Some(own) = own.strip_suffix('~') else {
        return false;
    };
    if own.contains('~') {
        return false;
    }
    let tokens: Vec<&str> = own.split('.').collect();
    let token_ok = |t: &str| {
        t.starts_with(|c: char| c.is_ascii_lowercase() || c == '_')
            && t.chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    };
    tokens.len() == 5
        && tokens[..4].iter().all(|t| token_ok(t))
        && tokens[4]
            .strip_prefix('v')
            .is_some_and(|v| !v.is_empty() && v.chars().all(|c| c.is_ascii_digit()))
}

impl Ontology {
    /// Is the type a Project: `project` itself, or a type whose `extends`
    /// chain reaches it. Takes an entity id, a GTS type id (a subtype's
    /// chained id included) or a leaf, as [`Self::resolve_entity_id`] does.
    pub fn is_project(&self, type_ref: &str) -> bool {
        if is_project_type_id(type_ref) {
            return true;
        }
        self.resolve_entity_id(type_ref)
            .is_some_and(|e| self.ancestors(&e).iter().any(|a| a == PROJECT))
    }

    /// The GTS type id `entity`'s objects are stored under: a Project
    /// subtype's chained id (`meta.gts`), when it has a well-formed one, else
    /// the id the entity gives.
    pub fn type_id_of(&self, entity_id: &str) -> String {
        self.chained_type_id(entity_id)
            .unwrap_or_else(|| gts::node_type_id(entity_id))
    }

    /// A Project subtype's chained GTS id, if `entity_id` is one.
    fn chained_type_id(&self, entity_id: &str) -> Option<String> {
        if entity_id == PROJECT {
            return None;
        }
        let meta_gts = self
            .entity(entity_id)?
            .get("meta")
            .and_then(|m| m.get("gts"))
            .and_then(Value::as_str)?;
        // The base it is chained onto must be the one its `extends` names,
        // and that one must be a Project: Project's own id, or another
        // subtype's chained id.
        let base = self
            .entity(entity_id)?
            .get("extends")
            .and_then(Value::as_str)
            .and_then(|b| self.resolve_entity_id(b))?;
        if !self.ancestors(&base).iter().any(|a| a == PROJECT) {
            return None;
        }
        let base_id = self.type_id_of(&base);
        is_chained_onto(meta_gts, &base_id).then(|| meta_gts.to_owned())
    }

    /// Every stored type id that **is** `entity`: its own, and each type's
    /// stored under an id chained onto it (a Project subtype under
    /// `project`). What a reader of `entity`'s objects lists.
    pub fn type_ids_of(&self, entity_id: &str) -> Vec<String> {
        let own = self.type_id_of(entity_id);
        let mut out = vec![own.clone()];
        for e in self.entity_ids() {
            if e == entity_id {
                continue;
            }
            if let Some(id) = self.chained_type_id(&e)
                && id.starts_with(&own)
                && !out.contains(&id)
            {
                out.push(id);
            }
        }
        out
    }

    /// The entity a stored type id is: the subtype a chained id names, else
    /// the entity the id's leaf resolves to.
    pub fn entity_of_type(&self, type_id: &str) -> Option<String> {
        self.resolve_entity_id(type_id)
    }

    /// The entity whose catalogued GTS id (`meta.gts`) is exactly
    /// `reference`, for a reference that is a chained id: its leaf would
    /// name the base (`…~cf.studio.kit_mna.project.v1~` ends in `project`).
    pub(super) fn entity_by_chained_gts(&self, reference: &str) -> Option<String> {
        if reference.trim_end_matches('~').matches('~').count() == 0 {
            return None;
        }
        self.entities()
            .iter()
            .find(|e| {
                e.get("meta")
                    .and_then(|m| m.get("gts"))
                    .and_then(Value::as_str)
                    == Some(reference)
            })
            .and_then(|e| e.get("id").and_then(Value::as_str))
            .map(str::to_owned)
    }

    /// The JSON schema of a Project subtype's own fields, for the payload
    /// graph-storage validates its objects against: `{name: schema}` of the
    /// fields it declares itself and whose type says a JSON shape. Empty for
    /// any other type: their registered schemas stay content-free.
    pub fn own_payload_schema(&self, entity_id: &str) -> serde_json::Map<String, Value> {
        let mut out = serde_json::Map::new();
        if self.chained_type_id(entity_id).is_none() {
            return out;
        }
        for p in self.effective_properties(entity_id) {
            if p.declared_by != entity_id {
                continue;
            }
            if let Some(schema) = super::super::validate::json_schema_of(&p.type_expr) {
                out.insert(p.name, schema);
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_chained_id_is_one_well_formed_segment_onto_its_base() {
        let base = project_type_id();
        assert!(is_chained_onto(
            &format!("{base}cf.studio.kit_mna.project.v1~"),
            &base
        ));
        // Six tokens: the GTS parser refuses it.
        assert!(!is_chained_onto(
            &format!("{base}cf.studio.kit.mna.project.v1~"),
            &base
        ));
        assert!(!is_chained_onto(&base, &base));
        assert!(!is_chained_onto(
            &format!("{base}cf.studio.kit_a.project.v1~cf.studio.kit_b.x.v1~"),
            &base
        ));
        assert!(!is_chained_onto(
            "gts.cf.studio.domain.record.v1~cf.studio.kit_a.x.v1~",
            &base
        ));
    }

    #[test]
    fn a_type_id_is_a_project_by_its_chain_prefix() {
        assert!(is_project_type_id("gts.cf.studio.domain.project.v1~"));
        assert!(is_project_type_id(
            "gts.cf.studio.domain.project.v1~cf.studio.kit_mna.project.v1~"
        ));
        assert!(!is_project_type_id("gts.cf.studio.domain.workspace.v1~"));
        assert!(!is_project_type_id("gts.cf.studio.domain.project_note.v1~"));
    }
}
