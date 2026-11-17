//! The `kit-rename` sweep's rewrite of one organization's model (ADR-0071
//! §8): every kit mark of Studio's own kits — a type's `meta.kit` and
//! `meta.left_by.kit`, a field's, relation's or tab's `kit` and
//! `left_by.kit`, a lifecycle's `kit` — and the kits' property sources
//! (`kit_property_layers`) are moved to the kit that brings the piece now.
//! Nothing else changes: ids, fields and objects stay as they are.
//!
//! Where a mark goes is the caller's to say ([`Rehome`]; studio-kits answers
//! from the built-in kits' manifests). `Core` is a retired kit whose screen
//! went to the shell: a piece the running core declares again is adopted by
//! it (`adopted_from` = the kit, never made dormant); a piece the core dropped
//! (`dropped_from_core`) and the kit had already left is left by Studio; one
//! the kit still carries stays for its uninstall to leave or remove.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value, json};

use super::super::LEFT_BY_STUDIO;
use super::{KEY, Layer, Ontology};
pub use crate::kit_registry::port::{MarkOn, Rehome};

/// The running core's pieces, and what it dropped.
struct Core {
    types: BTreeSet<String>,
    properties: BTreeSet<(String, String)>,
    dropped: BTreeSet<String>,
}

impl Core {
    fn running() -> Self {
        let mut types = BTreeSet::new();
        let mut properties = BTreeSet::new();
        for e in Ontology::running_core() {
            let Some(id) = e.get("id").and_then(Value::as_str) else {
                continue;
            };
            types.insert(id.to_owned());
            for p in e
                .get("properties")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(name) = p.get("name").and_then(Value::as_str) {
                    properties.insert((id.to_owned(), name.to_owned()));
                }
            }
        }
        let dropped = Ontology::running_moves()
            .into_iter()
            .filter(|(_, by)| by == LEFT_BY_STUDIO)
            .map(|(key, _)| key)
            .collect();
        Self {
            types,
            properties,
            dropped,
        }
    }

    fn declares(&self, entity: &str, on: MarkOn<'_>) -> bool {
        match on {
            MarkOn::Type => self.types.contains(entity),
            MarkOn::Property(name) => self
                .properties
                .contains(&(entity.to_owned(), name.to_owned())),
            MarkOn::Lifecycle(_) => false,
        }
    }

    fn dropped(&self, entity: &str, on: MarkOn<'_>) -> bool {
        match on {
            MarkOn::Type => self.dropped.contains(entity),
            MarkOn::Property(name) => self.dropped.contains(&format!("{entity}.{name}")),
            MarkOn::Lifecycle(_) => false,
        }
    }
}

/// A mark's place: `kit` on a piece a kit brings, `left` on one it left.
fn mark_of(v: &Map<String, Value>) -> Option<(&'static str, String)> {
    if matches!(
        v.get("origin").and_then(Value::as_str),
        Some("kit" | "gear")
    ) && let Some(k) = v.get("kit").and_then(Value::as_str)
    {
        return Some(("kit", k.to_owned()));
    }
    v.get("left_by")
        .and_then(|l| l.get("kit"))
        .and_then(Value::as_str)
        .map(|k| ("left", k.to_owned()))
}

/// Rewrite the mark on `v` (a type's meta, a property, a lifecycle) by
/// `rehome`; the change, said, when there is one.
fn rewrite(
    v: &mut Map<String, Value>,
    entity: &str,
    on: MarkOn<'_>,
    core: &Core,
    rehome: &dyn Fn(&str, &str, MarkOn<'_>) -> Option<Rehome>,
) -> Option<String> {
    let (place, kit) = mark_of(v)?;
    let what = match on {
        MarkOn::Type => format!("type {entity}"),
        MarkOn::Property(name) => format!("{entity}.{name}"),
        MarkOn::Lifecycle(field) => format!("lifecycle {entity}.{field}"),
    };
    match rehome(&kit, entity, on)? {
        Rehome::Kit(to) => {
            if place == "kit" {
                v.insert("kit".into(), json!(to));
            } else if let Some(l) = v.get_mut("left_by").and_then(Value::as_object_mut) {
                l.insert("kit".into(), json!(to));
            }
            Some(format!("{what}: {kit} → {to}"))
        }
        Rehome::Core if core.declares(entity, on) && !core.dropped(entity, on) => {
            // Adopted by the core, never made dormant (ADR-0071 §8).
            let before = v.get("adopted_from").cloned();
            for key in ["kit", "kit_version", "left_by"] {
                v.remove(key);
            }
            match before.as_ref().and_then(Value::as_str) {
                // A type the kit had adopted from the core gets its origin
                // back.
                Some(origin) if matches!(on, MarkOn::Type) && origin != "kit" => {
                    v.insert("origin".into(), json!(origin));
                }
                _ => {
                    v.remove("origin");
                }
            }
            v.insert("adopted_from".into(), json!(kit));
            Some(format!("{what}: {kit} → the core"))
        }
        Rehome::Core if place == "left" && core.dropped(entity, on) => {
            // What the core dropped and the retired kit left: Studio left it.
            if let Some(l) = v.get_mut("left_by").and_then(Value::as_object_mut) {
                l.insert("kit".into(), json!(LEFT_BY_STUDIO));
            }
            Some(format!("{what}: {kit} → left by Studio"))
        }
        Rehome::Core => None,
    }
}

impl Ontology {
    /// Move every kit mark of Studio's own kits to the kit that brings the
    /// piece now, and the kits' property sources with them (ADR-0071 §8,
    /// `kit-rename`). Answers what moved, one line each; nothing when the
    /// model already names only current kits.
    pub(in crate::domain_model) fn rename_kit_marks(
        &mut self,
        rehome: &dyn Fn(&str, &str, MarkOn<'_>) -> Option<Rehome>,
    ) -> anyhow::Result<Vec<String>> {
        let core = Core::running();
        let mut changed = Vec::new();
        let Some(entities) = self.entities_mut() else {
            return Ok(changed);
        };
        for e in entities.iter_mut() {
            let id = e
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            if let Some(meta) = e.get_mut("meta").and_then(Value::as_object_mut) {
                changed.extend(rewrite(meta, &id, MarkOn::Type, &core, rehome));
                for l in meta
                    .get_mut("lifecycles")
                    .and_then(Value::as_array_mut)
                    .into_iter()
                    .flatten()
                {
                    let field = l
                        .get("field")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned();
                    if let Some(l) = l.as_object_mut() {
                        changed.extend(rewrite(l, &id, MarkOn::Lifecycle(&field), &core, rehome));
                    }
                }
            }
            for p in e
                .get_mut("properties")
                .and_then(Value::as_array_mut)
                .into_iter()
                .flatten()
            {
                let name = p
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                if let Some(p) = p.as_object_mut() {
                    changed.extend(rewrite(p, &id, MarkOn::Property(&name), &core, rehome));
                }
            }
        }
        changed.extend(self.rename_layers(rehome)?);
        Ok(changed)
    }

    /// The property sources of a kit whose pieces moved go with them: an
    /// entry to the layer of the kit that brings it now, made at the old
    /// layer's version if it has none; an entry the core takes back is
    /// dropped. A layer left with nothing is removed.
    fn rename_layers(
        &mut self,
        rehome: &dyn Fn(&str, &str, MarkOn<'_>) -> Option<Rehome>,
    ) -> anyhow::Result<Vec<String>> {
        let Some(stored) = self.doc.get(KEY).cloned() else {
            return Ok(Vec::new());
        };
        let mut layers: BTreeMap<String, Layer> = serde_json::from_value(stored)?;
        let mut changed = Vec::new();
        let slugs: Vec<String> = layers.keys().cloned().collect();
        for slug in slugs {
            let Some(layer) = layers.get(&slug).cloned() else {
                continue;
            };
            let mut keys: BTreeSet<(String, String)> = BTreeSet::new();
            for (entity, entries) in layer.source.iter() {
                keys.extend(entries.keys().map(|k| (entity.clone(), k.clone())));
            }
            for (entity, entries) in layer.overrides.iter() {
                keys.extend(entries.keys().map(|k| (entity.clone(), k.clone())));
            }
            let mut moved_any = false;
            for (entity, key) in keys {
                let on = match key.split_once(':') {
                    Some(("property", name)) => MarkOn::Property(name),
                    Some(("lifecycle", field)) => MarkOn::Lifecycle(field),
                    _ => continue,
                };
                let Some(to) = rehome(&slug, &entity, on) else {
                    continue;
                };
                let from = layers.get_mut(&slug).expect("read above");
                let source = from.source.get_mut(&entity).and_then(|e| e.remove(&key));
                let delta = from.overrides.get_mut(&entity).and_then(|e| e.remove(&key));
                from.source.retain(|_, e| !e.is_empty());
                from.overrides.retain(|_, e| !e.is_empty());
                moved_any = true;
                match to {
                    Rehome::Kit(to) => {
                        let target = layers.entry(to.clone()).or_insert_with(|| Layer {
                            format: layer.format,
                            version: layer.version.clone(),
                            installed: layer.installed,
                            overlay: Default::default(),
                            source: Default::default(),
                            overrides: Default::default(),
                        });
                        if let Some(mut v) = source {
                            // The source is the property as the kit wrote it,
                            // marks and all: it names the new kit too.
                            if let Some(o) = v.as_object_mut() {
                                if o.contains_key("kit") {
                                    o.insert("kit".into(), json!(to));
                                }
                                if let Some(l) = o.get_mut("left_by").and_then(Value::as_object_mut)
                                {
                                    l.insert("kit".into(), json!(to));
                                }
                            }
                            target
                                .source
                                .entry(entity.clone())
                                .or_default()
                                .insert(key.clone(), v);
                        }
                        if let Some(d) = delta {
                            target
                                .overrides
                                .entry(entity.clone())
                                .or_default()
                                .insert(key.clone(), d);
                        }
                        changed.push(format!("source {entity} {key}: {slug} → {to}"));
                    }
                    Rehome::Core => {
                        changed.push(format!("source {entity} {key}: {slug} → the core"))
                    }
                }
            }
            if moved_any
                && layers
                    .get(&slug)
                    .is_some_and(|l| l.source.is_empty() && l.overrides.is_empty())
            {
                layers.remove(&slug);
                changed.push(format!("source {slug}: removed, nothing left in it"));
            }
        }
        if !changed.is_empty() {
            self.doc[KEY] = json!(layers);
        }
        Ok(changed)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use crate::domain_model::kit_overlay::KitOverlay;

    fn overlay() -> KitOverlay {
        serde_json::from_value(json!({"fields": [
            {"on": "project", "name": "effort", "type": "integer", "description": "Kit default"}
        ]}))
        .unwrap()
    }

    fn property(o: &Ontology, entity: &str, name: &str) -> Value {
        o.entity(entity).unwrap()["properties"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["name"] == name)
            .cloned()
            .unwrap()
    }

    fn property_mut<'a>(o: &'a mut Ontology, entity: &str, name: &str) -> &'a mut Value {
        o.entity_mut(entity).unwrap()["properties"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|p| p["name"] == name)
            .unwrap()
    }

    fn layers(o: &Ontology) -> Value {
        o.doc.get(KEY).cloned().unwrap_or_default()
    }

    /// Everything of `old` goes to `new`.
    fn to_new(kit: &str, _: &str, _: MarkOn<'_>) -> Option<Rehome> {
        (kit == "old").then(|| Rehome::Kit("new".into()))
    }

    #[test]
    fn a_moved_piece_names_its_new_kit_and_its_source_goes_with_it() {
        let mut o = Ontology::load();
        o.sync_kit_properties("old", "1", Some(&overlay()), &|_| false)
            .unwrap();
        // The organization changed the kit's field: its override moves too.
        property_mut(&mut o, "project", "effort")["description"] = json!("Organization wording");
        o.sync_kit_properties("old", "1", Some(&overlay()), &|_| false)
            .unwrap();
        let moved = o.rename_kit_marks(&to_new).unwrap();
        assert!(
            moved.iter().any(|m| m == "project.effort: old → new"),
            "{moved:?}"
        );
        assert_eq!(property(&o, "project", "effort")["kit"], "new");
        let l = layers(&o);
        assert!(l.get("old").is_none(), "the emptied source goes: {l}");
        assert!(
            l["new"]["source"]["project"]
                .get("property:effort")
                .is_some()
        );
        assert!(
            l["new"]["overrides"]["project"]
                .get("property:effort")
                .is_some()
        );
        // Again: nothing left to move.
        assert!(o.rename_kit_marks(&to_new).unwrap().is_empty());
        // The new kit applies it as its own and the old kit's uninstall
        // removes nothing: the field reads as before, the organization's
        // wording kept.
        let before = property(&o, "project", "effort");
        o.sync_kit_properties("new", "1", Some(&overlay()), &|_| false)
            .unwrap();
        o.sync_kit_properties("old", "", None, &|_| false).unwrap();
        let after = property(&o, "project", "effort");
        assert_eq!(after["kit"], "new");
        assert_eq!(after["description"], "Organization wording");
        assert_eq!(after, before);
    }

    #[test]
    fn a_dormant_mark_names_its_new_kit_too() {
        let mut o = Ontology::load();
        o.sync_kit_properties("old", "1", Some(&overlay()), &|_| false)
            .unwrap();
        let p = property_mut(&mut o, "project", "effort");
        p.as_object_mut().unwrap().remove("kit");
        p["left_by"] = json!({"kit": "old", "version": "1", "at": "then"});
        o.rename_kit_marks(&to_new).unwrap();
        assert_eq!(property(&o, "project", "effort")["left_by"]["kit"], "new");
    }

    #[test]
    fn a_retired_kit_s_piece_the_core_declares_again_is_adopted_not_left() {
        let mut o = Ontology::load();
        let core = Core::running();
        let (entity, name) = core
            .properties
            .iter()
            .find(|(e, _)| e == "project")
            .cloned()
            .unwrap();
        let p = property_mut(&mut o, &entity, &name);
        p["origin"] = json!("kit");
        p["kit"] = json!("gone");
        p["kit_version"] = json!("1");
        let moved = o
            .rename_kit_marks(&|kit, _, _| (kit == "gone").then_some(Rehome::Core))
            .unwrap();
        assert_eq!(moved.len(), 1, "{moved:?}");
        let p = property(&o, &entity, &name);
        assert!(p.get("kit").is_none() && p.get("origin").is_none() && p.get("left_by").is_none());
        assert_eq!(p["adopted_from"], "gone");
    }

    #[test]
    fn an_organization_s_own_kit_keeps_its_marks() {
        let mut o = Ontology::load();
        o.sync_kit_properties("ours", "1", Some(&overlay()), &|_| false)
            .unwrap();
        let before = o.document().clone();
        assert!(o.rename_kit_marks(&to_new).unwrap().is_empty());
        assert_eq!(*o.document(), before);
    }
}
