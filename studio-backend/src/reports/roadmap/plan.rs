//! A roadmap board's plan: who works on its gears and who needs them.
//!
//! The planning team keeps it as `gears.yaml` next to their report script --
//! swimlanes (the order and names of the groups), units and their teams
//! (colour, head count, power), the people (GitHub login → team, alias,
//! power, email) and the consumer projects with, per gear, when each needs
//! it. None of it is on the board, and all of it is data: a sync is handed
//! the file -- or reads it from a repository -- and keeps it on the report's
//! source ([`crate::reports::gts::REPORT_SOURCE_TYPE`]).
//!
//! The lookups here are the planning script's, rule for rule: a team is
//! found by tag or by name, a user's unit by their team, a team's power is
//! its own or its members' summed, an unknown login falls to `__unassigned__`.

use std::collections::BTreeMap;

use serde_yaml::Value;

/// The lane of gears no configured person works on.
pub const UNASSIGNED: &str = "__unassigned__";

#[derive(Clone, Debug, Default)]
pub struct Team {
    pub tag: String,
    pub name: String,
    pub color: Option<String>,
    pub power: Option<f64>,
    pub people: Option<f64>,
}

#[derive(Clone, Debug, Default)]
pub struct Unit {
    pub name: String,
    pub color: Option<String>,
    pub teams: Vec<Team>,
}

#[derive(Clone, Debug, Default)]
pub struct User {
    pub login: String,
    pub unit: Option<String>,
    pub team: Option<String>,
    pub alias: Option<String>,
    /// As written: the People sheet shows it as given.
    pub power: Option<f64>,
    pub email: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Plan {
    pub swimlane_order: Vec<String>,
    pub swimlane_labels: Vec<(String, String)>,
    pub units: Vec<Unit>,
    pub no_unit_color: String,
    pub users: Vec<User>,
    /// Consumer projects in column order: key and display name.
    pub projects: Vec<(String, String)>,
    /// Gear number → project key → when it is needed (`Q3'26`, `YES`, `no`, `?`).
    pub needs: BTreeMap<String, BTreeMap<String, String>>,
}

impl Default for Plan {
    fn default() -> Self {
        Plan {
            swimlane_order: Vec::new(),
            swimlane_labels: Vec::new(),
            units: Vec::new(),
            no_unit_color: "595959".to_string(),
            users: Vec::new(),
            projects: Vec::new(),
            needs: BTreeMap::new(),
        }
    }
}

/// `CT Studio` and `ct_studio` name the same team.
pub fn normalize(name: &str) -> String {
    name.chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

fn text(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.trim().to_string()).filter(|s| !s.is_empty()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(if *b { "True" } else { "False" }.to_string()),
        _ => None,
    }
}

fn number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// Parse `gears.yaml` the way the planning script reads it (PyYAML): a key
/// written twice keeps its first place and its last value, where a strict
/// parser refuses the whole file. The file the team keeps has such a key.
pub fn parse(text: &str) -> Result<Value, String> {
    use serde::Deserialize;
    let loose =
        Loose::deserialize(serde_yaml::Deserializer::from_str(text)).map_err(|e| e.to_string())?;
    Ok(loose.0)
}

/// A YAML value whose mappings tolerate a repeated key.
struct Loose(Value);

impl<'de> serde::Deserialize<'de> for Loose {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = Loose;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a YAML value")
            }
            fn visit_bool<E>(self, v: bool) -> Result<Loose, E> {
                Ok(Loose(Value::Bool(v)))
            }
            fn visit_i64<E>(self, v: i64) -> Result<Loose, E> {
                Ok(Loose(Value::Number(v.into())))
            }
            fn visit_u64<E>(self, v: u64) -> Result<Loose, E> {
                Ok(Loose(Value::Number(v.into())))
            }
            fn visit_f64<E>(self, v: f64) -> Result<Loose, E> {
                Ok(Loose(Value::Number(v.into())))
            }
            fn visit_str<E>(self, v: &str) -> Result<Loose, E> {
                Ok(Loose(Value::String(v.to_string())))
            }
            fn visit_string<E>(self, v: String) -> Result<Loose, E> {
                Ok(Loose(Value::String(v)))
            }
            fn visit_unit<E>(self) -> Result<Loose, E> {
                Ok(Loose(Value::Null))
            }
            fn visit_none<E>(self) -> Result<Loose, E> {
                Ok(Loose(Value::Null))
            }
            fn visit_some<D: serde::Deserializer<'de>>(self, d: D) -> Result<Loose, D::Error> {
                serde::Deserialize::deserialize(d)
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> Result<Loose, A::Error> {
                let mut out = Vec::new();
                while let Some(Loose(v)) = seq.next_element()? {
                    out.push(v);
                }
                Ok(Loose(Value::Sequence(out)))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<Loose, A::Error> {
                let mut out = serde_yaml::Mapping::new();
                while let Some((Loose(k), Loose(v))) = map.next_entry()? {
                    // An existing key keeps its place and takes the new value.
                    out.insert(k, v);
                }
                Ok(Loose(Value::Mapping(out)))
            }
        }
        d.deserialize_any(V)
    }
}

/// A mapping's entries in the file's order, keys as text.
fn entries(v: Option<&Value>) -> Vec<(String, &Value)> {
    v.and_then(Value::as_mapping)
        .map(|m| m.iter().filter_map(|(k, v)| Some((text(k)?, v))).collect())
        .unwrap_or_default()
}

fn slug(name: &str) -> String {
    let mut out = String::new();
    let mut gap = false;
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            if gap && !out.is_empty() {
                out.push('_');
            }
            gap = false;
            out.push(c);
        } else {
            gap = true;
        }
    }
    out
}

impl Plan {
    /// Read a plan from `gears.yaml`'s text; one that does not parse is empty.
    #[cfg(test)]
    pub fn from_yaml(text: &str) -> Plan {
        parse(text)
            .map(|v| Plan::from_value(&v))
            .unwrap_or_default()
    }

    /// Read a plan from `gears.yaml`'s shape, in its order. Whatever is
    /// missing is empty.
    pub fn from_value(v: &Value) -> Plan {
        let mut plan = Plan::default();
        if let Some(lanes) = v.get("swimlanes") {
            plan.swimlane_order = lanes
                .get("order")
                .and_then(Value::as_sequence)
                .map(|a| a.iter().filter_map(text).collect())
                .unwrap_or_default();
            plan.swimlane_labels = entries(lanes.get("labels"))
                .into_iter()
                .filter_map(|(k, v)| Some((k, text(v)?)))
                .collect();
        }
        for (name, data) in entries(v.get("units")) {
            let mut unit = Unit {
                name,
                color: data.get("color").and_then(text),
                teams: Vec::new(),
            };
            for t in data
                .get("teams")
                .and_then(Value::as_sequence)
                .map(Vec::as_slice)
                .unwrap_or(&[])
            {
                let team = if t.is_mapping() {
                    let field = |k: &str| t.get(k).and_then(number);
                    Team {
                        tag: t.get("tag").and_then(text).unwrap_or_default(),
                        name: t.get("name").and_then(text).unwrap_or_default(),
                        color: t.get("color").and_then(text),
                        power: field("power"),
                        people: field("people")
                            .or_else(|| field("people_count"))
                            .or_else(|| field("size")),
                    }
                } else {
                    let name = text(t).unwrap_or_default();
                    Team {
                        tag: slug(&name),
                        name,
                        ..Team::default()
                    }
                };
                if !team.tag.is_empty() && !team.name.is_empty() {
                    unit.teams.push(team);
                }
            }
            plan.units.push(unit);
        }
        if let Some(c) = v.get("no_unit_color").and_then(text) {
            plan.no_unit_color = c;
        }
        for (login, data) in entries(v.get("users")) {
            let get = |k: &str| data.get(k).and_then(text);
            plan.users.push(User {
                login,
                unit: get("unit"),
                team: get("team"),
                alias: get("alias"),
                power: data.get("power").and_then(number),
                email: get("email"),
            });
        }
        plan.projects = entries(v.get("gear_projects"))
            .into_iter()
            .map(|(k, p)| {
                let name = p.get("name").and_then(text).unwrap_or_else(|| k.clone());
                (k, name)
            })
            .collect();
        let mut first_keys: Option<Vec<String>> = None;
        for (number, d) in entries(v.get("gear_project_dependencies")) {
            let projects = entries(d.get("projects"));
            if projects.is_empty() {
                continue;
            }
            first_keys.get_or_insert_with(|| projects.iter().map(|(k, _)| k.clone()).collect());
            let needs = projects
                .into_iter()
                .filter_map(|(k, v)| {
                    let v = if v.is_mapping() {
                        v.get("needed").cloned().unwrap_or(Value::Null)
                    } else {
                        v.clone()
                    };
                    Some((k, text(&v)?))
                })
                .collect();
            plan.needs.insert(number, needs);
        }
        // A project list without names is the first gear's project keys.
        if plan.projects.is_empty()
            && let Some(keys) = first_keys
        {
            plan.projects = keys.into_iter().map(|k| (k.clone(), k)).collect();
        }
        plan
    }

    /// A plan written as JSON (tests): the same shape, in the order JSON
    /// gives it.
    #[cfg(test)]
    pub fn from_json(v: &serde_json::Value) -> Plan {
        serde_yaml::to_value(v)
            .map(|y| Plan::from_value(&y))
            .unwrap_or_default()
    }

    fn user(&self, login: &str) -> Option<&User> {
        self.users.iter().find(|u| u.login == login)
    }

    fn team_matches(team: &Team, wanted: &str) -> bool {
        let w = normalize(wanted);
        normalize(&team.tag) == w || normalize(&team.name) == w
    }

    pub fn team(&self, tag: &str) -> Option<&Team> {
        if tag.is_empty() || tag == UNASSIGNED {
            return None;
        }
        for unit in &self.units {
            if let Some(t) = unit.teams.iter().find(|t| t.tag == tag) {
                return Some(t);
            }
            if let Some(t) = unit.teams.iter().find(|t| Self::team_matches(t, tag)) {
                return Some(t);
            }
        }
        None
    }

    fn unit_of_team(&self, tag: &str) -> Option<&Unit> {
        if tag.is_empty() || tag == UNASSIGNED {
            return None;
        }
        self.units.iter().find(|u| {
            u.teams.iter().any(|t| t.tag == tag)
                || u.teams.iter().any(|t| Self::team_matches(t, tag))
        })
    }

    /// The unit a user belongs to as configured: theirs, or their team's.
    fn configured_unit(&self, login: &str) -> Option<String> {
        let user = self.user(login)?;
        if let Some(u) = &user.unit {
            return Some(u.clone());
        }
        let team = user.team.as_deref()?;
        self.unit_of_team(team).map(|u| u.name.clone())
    }

    pub fn team_of_user(&self, login: &str) -> Option<&Team> {
        let user = self.user(login);
        if let Some(tag) = user.and_then(|u| u.team.as_deref())
            && let Some(t) = self.team(tag)
        {
            return Some(t);
        }
        let unit = self.configured_unit(login)?;
        let unit = self.units.iter().find(|u| u.name == unit)?;
        if unit.teams.len() == 1 {
            return unit.teams.first();
        }
        None
    }

    pub fn user_team_tag(&self, login: &str) -> String {
        if let Some(t) = self.team_of_user(login) {
            return t.tag.clone();
        }
        self.user(login)
            .and_then(|u| u.team.clone())
            .unwrap_or_default()
    }

    pub fn user_unit(&self, login: &str) -> String {
        let tag = self.user_team_tag(login);
        if let Some(u) = self.unit_of_team(&tag) {
            return u.name.clone();
        }
        self.configured_unit(login).unwrap_or_default()
    }

    pub fn user_team_name(&self, login: &str) -> String {
        self.team_of_user(login)
            .map(|t| {
                if t.name.is_empty() {
                    t.tag.clone()
                } else {
                    t.name.clone()
                }
            })
            .unwrap_or_default()
    }

    pub fn user_team_color(&self, login: &str) -> String {
        if let Some(c) = self.team_of_user(login).and_then(|t| t.color.clone()) {
            return c;
        }
        let unit = self.user_unit(login);
        if let Some(c) = self
            .units
            .iter()
            .find(|u| u.name == unit && !unit.is_empty())
            .and_then(|u| u.color.clone())
        {
            return c;
        }
        self.no_unit_color.clone()
    }

    pub fn alias(&self, login: &str) -> String {
        self.user(login)
            .and_then(|u| u.alias.clone())
            .unwrap_or_else(|| login.to_string())
    }

    pub fn user_power(&self, login: &str) -> f64 {
        if login == UNASSIGNED {
            return 1.0;
        }
        match self.user(login).and_then(|u| u.power) {
            Some(p) if p > 0.0 => p,
            Some(_) => 1.0,
            None => 1.0,
        }
    }

    fn team_members(&self, tag: &str) -> Vec<&str> {
        if tag == UNASSIGNED {
            return Vec::new();
        }
        self.users
            .iter()
            .filter(|u| self.user_team_tag(&u.login) == tag)
            .map(|u| u.login.as_str())
            .collect()
    }

    pub fn team_power(&self, tag: &str) -> f64 {
        if tag == UNASSIGNED {
            return 1.0;
        }
        let power = match self.team(tag).and_then(|t| t.power) {
            Some(p) => p,
            None => self
                .team_members(tag)
                .iter()
                .map(|l| self.user_power(l))
                .sum(),
        };
        if power > 0.0 { power } else { 1.0 }
    }

    pub fn team_people(&self, tag: &str) -> u32 {
        if tag == UNASSIGNED {
            return 1;
        }
        let raw = match self.team(tag).and_then(|t| t.people) {
            Some(p) => p,
            None => self.team_members(tag).len() as f64,
        };
        (raw.ceil() as u32).max(1)
    }

    pub fn team_name(&self, tag: &str) -> String {
        self.team(tag)
            .map(|t| {
                if t.name.is_empty() {
                    t.tag.clone()
                } else {
                    t.name.clone()
                }
            })
            .unwrap_or_default()
    }

    pub fn team_color(&self, tag: &str) -> String {
        if tag == UNASSIGNED {
            return hex(&self.no_unit_color, "4472C4");
        }
        if let Some(c) = self.team(tag).and_then(|t| t.color.clone()) {
            return hex(&c, &self.no_unit_color);
        }
        if let Some(c) = self.unit_of_team(tag).and_then(|u| u.color.clone()) {
            return hex(&c, &self.no_unit_color);
        }
        hex(&self.no_unit_color, "4472C4")
    }

    /// Where a team's lane sorts on the Gantt: configured teams in the
    /// configured order, then the rest by name, then the unassigned.
    pub fn lane_order(&self, tag: &str) -> (u8, usize, usize, String) {
        if tag == UNASSIGNED {
            return (2, 0, 0, String::new());
        }
        for (ui, unit) in self.units.iter().enumerate() {
            if let Some(ti) = unit.teams.iter().position(|t| t.tag == tag) {
                return (0, ui, ti, tag.to_string());
            }
        }
        let name = self.team_name(tag);
        let name = if name.is_empty() {
            tag.to_string()
        } else {
            name
        };
        (1, 0, 0, format!("{}\u{0}{tag}", name.to_lowercase()))
    }

    pub fn swimlane_label(&self, group: &str) -> String {
        let upper = group.to_uppercase();
        self.swimlane_labels
            .iter()
            .find(|(k, _)| k.to_uppercase() == upper)
            .map_or_else(|| group.to_string(), |(_, v)| v.clone())
    }

    pub fn need(&self, number: Option<u64>, project: &str) -> Option<String> {
        let number = number?.to_string();
        self.needs.get(&number)?.get(project).cloned()
    }
}

/// A colour as six hex digits, or the fallback.
pub fn hex(value: &str, fallback: &str) -> String {
    let t = value.trim().trim_start_matches('#').to_ascii_uppercase();
    let t = if t.len() == 8 && t.chars().all(|c| c.is_ascii_hexdigit()) {
        t[2..].to_string()
    } else {
        t
    };
    if t.len() == 6 && t.chars().all(|c| c.is_ascii_hexdigit()) {
        t
    } else {
        fallback.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan() -> Plan {
        Plan::from_json(&serde_json::json!({
            "swimlanes": { "order": ["CORE"], "labels": { "CORE": "Core Modules", "SERVERLESS": "Serverless Runtime" } },
            "units": {
                "Acronis": { "color": "1F3864", "teams": [
                    { "tag": "a_bravo", "name": "Acronis", "color": "1F3864", "people": 6, "power": 4 },
                    { "tag": "a_other", "name": "Acronis Other", "color": "1F3864" },
                ] },
                "Constructor": { "color": "1E5631", "teams": [
                    { "tag": "ct_studio", "name": "CT Studio", "color": "1E5631", "people": 4 },
                ] },
                "Virtuozzo": { "color": "843C0C", "teams": [ { "tag": "vz_core", "name": "Virtuozzo" } ] },
            },
            "users": {
                "ainetx": { "alias": "Max P", "team": "ct_studio", "power": 0.2 },
                "AndrejK666": { "alias": "Andrej K", "team": "ct_studio", "power": 1 },
                "vasylcf": { "team": "ct_studio", "power": 0.8 },
                "x": { "team": "ct_studio", "power": 1.0 },
                "vz": { "team": "Virtuozzo" },
            },
            "gear_projects": { "studio_web": { "name": "Studio Web" } },
            "gear_project_dependencies": { "2542": { "projects": { "studio_web": "Q3'26" } } },
        }))
    }

    #[test]
    fn a_team_without_power_has_its_members_power() {
        let p = plan();
        assert_eq!(p.team_people("ct_studio"), 4);
        assert!((p.team_power("ct_studio") - 3.0).abs() < 1e-9);
        assert!((p.team_power("a_bravo") - 4.0).abs() < 1e-9);
    }

    #[test]
    fn a_user_is_found_by_team_tag_or_team_name() {
        let p = plan();
        assert_eq!(p.user_team_tag("vz"), "vz_core");
        assert_eq!(p.user_unit("vz"), "Virtuozzo");
        assert_eq!(p.user_team_color("vz"), "843C0C");
        assert_eq!(p.alias("ainetx"), "Max P");
        assert_eq!(p.alias("stranger"), "stranger");
        assert_eq!(p.user_team_tag("stranger"), "");
    }

    #[test]
    fn swimlane_labels_and_needs_are_read() {
        let p = plan();
        assert_eq!(p.swimlane_label("Serverless"), "Serverless Runtime");
        assert_eq!(p.swimlane_label("OSS"), "OSS");
        assert_eq!(p.need(Some(2542), "studio_web").as_deref(), Some("Q3'26"));
        assert_eq!(p.projects, vec![("studio_web".into(), "Studio Web".into())]);
    }

    #[test]
    fn a_key_written_twice_keeps_its_place_and_its_last_value() {
        let v = parse("a: 1\nb: 2\na: 3\n").expect("parses");
        let m = v.as_mapping().expect("mapping");
        let keys: Vec<&str> = m.keys().filter_map(Value::as_str).collect();
        assert_eq!(keys, vec!["a", "b"]);
        assert_eq!(v.get("a").and_then(Value::as_i64), Some(3));
        assert!(parse("a: [1").is_err());
    }

    #[test]
    fn the_files_order_is_kept() {
        let p = Plan::from_yaml(
            "units:\n  Zed:\n    teams: [ { tag: z, name: Z } ]\n  Alpha:\n    teams: [ { tag: a, name: A } ]\nusers:\n  zoe: { team: z }\n  adam: { team: a }\ngear_projects:\n  web: { name: Studio Web }\n  bss: { name: VZ BSS }\n",
        );
        let units: Vec<&str> = p.units.iter().map(|u| u.name.as_str()).collect();
        assert_eq!(units, vec!["Zed", "Alpha"]);
        let users: Vec<&str> = p.users.iter().map(|u| u.login.as_str()).collect();
        assert_eq!(users, vec!["zoe", "adam"]);
        let projects: Vec<&str> = p.projects.iter().map(|(_, n)| n.as_str()).collect();
        assert_eq!(projects, vec!["Studio Web", "VZ BSS"]);
        assert!(p.lane_order("z") < p.lane_order("a"));
    }

    #[test]
    fn lanes_sort_in_configured_order_with_the_unassigned_last() {
        let p = plan();
        let mut tags = vec![UNASSIGNED, "ct_studio", "a_bravo", "zz"];
        tags.sort_by_key(|t| p.lane_order(t));
        assert_eq!(tags, vec!["a_bravo", "ct_studio", "zz", UNASSIGNED]);
    }
}
