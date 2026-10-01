//! The one type the reports gear keeps: where a report's data and plan come
//! from, per organization.
//!
//! Graph-storage is tenant-scoped, which is what makes a source the
//! organization's rather than a person's: everyone who opens the report reads
//! the one their organization configured.

use serde_json::{Value, json};
use uuid::Uuid;

/// A report's source: which board, which plan, and the plan as last read.
pub const REPORT_SOURCE_TYPE: &str = "gts.cf.studio.reports.report_source.v1~";

const TITLE: &str = "Report source";
const DESCRIPTION: &str = "Where one report's data and plan come from in this organization: the connection, the board, the plan file, and the plan as it was last read.";

/// Graph-storage's family for owned nodes.
const OWNED_NODE_FAMILY: &str = "gts.cf.core.graph.node.v1~cf.core.graph.owned_node.v1~";

/// Instance ids are UUIDs derived from the report id, so a source is found
/// again by the report it is for.
const INSTANCE_NS: Uuid = Uuid::from_u128(0x5d1c_7a2e_93b4_4f60_8e21_c4a7_09b3_6f15);

/// The type id graph-storage stores a report source under.
pub fn graph_type_id() -> String {
    let leaf = REPORT_SOURCE_TYPE.trim_start_matches("gts.");
    format!("{OWNED_NODE_FAMILY}{leaf}")
}

/// The node key of a report's source.
pub fn source_key(report: &str) -> String {
    Uuid::new_v5(&INSTANCE_NS, format!("report_source|{report}").as_bytes()).to_string()
}

/// The type as the platform registry catalogs it.
pub fn type_schemas() -> Vec<Value> {
    vec![json!({
        "$id": format!("gts://{REPORT_SOURCE_TYPE}"),
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": TITLE,
        "description": DESCRIPTION,
        "type": "object",
    })]
}

/// The type as graph-storage stores it. Nothing a person searches for, so
/// no search traits.
pub fn graph_node_type_schemas() -> Vec<Value> {
    vec![json!({
        "$id": format!("gts://{}", graph_type_id()),
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": TITLE,
        "description": DESCRIPTION,
        "type": "object",
        "allOf": [{ "$ref": format!("gts://{OWNED_NODE_FAMILY}") }],
    })]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_type_is_a_valid_gts_segment_derived_from_a_graph_family() {
        let leaf = REPORT_SOURCE_TYPE
            .trim_start_matches("gts.")
            .trim_end_matches('~');
        let tokens: Vec<&str> = leaf.split('.').collect();
        assert_eq!(tokens.len(), 5, "{tokens:?}");
        assert!(tokens[4].starts_with('v'));
        assert!(graph_type_id().starts_with(OWNED_NODE_FAMILY));
        assert!(graph_type_id().ends_with("cf.studio.reports.report_source.v1~"));
    }

    #[test]
    fn a_source_key_is_the_reports_and_only_its() {
        assert_eq!(source_key("roadmap"), source_key("roadmap"));
        assert_ne!(source_key("roadmap"), source_key("other"));
        assert!(Uuid::parse_str(&source_key("roadmap")).is_ok());
    }
}
