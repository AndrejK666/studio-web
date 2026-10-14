use super::*;
use crate::documents::spec_model::glossary::Alias;

fn fact(path: &str, subject: &str, value: &str, text: &str) -> Fact {
    Fact {
        kind: "relation".into(),
        subject: subject.into(),
        aspect: String::new(),
        value: value.into(),
        text: text.into(),
        status: "active".into(),
        status_because: String::new(),
        path: path.into(),
        line_start: 4,
        line_end: 4,
        quote: text.into(),
    }
}

fn entry(name: &str, aliases: &[&str]) -> Entry {
    let mut spellings = vec![name.to_string()];
    spellings.extend(aliases.iter().map(|a| a.to_string()));
    Entry {
        key: subject_key(name),
        name: name.into(),
        chosen: !aliases.is_empty(),
        spellings,
        aliases: aliases
            .iter()
            .map(|a| Alias {
                key: subject_key(a),
                name: a.to_string(),
            })
            .collect(),
        facts: 0,
        documents: 0,
    }
}

const PRD: &str = "\
# Billing PRD

Every invoice is sent to the customer.
A client may pay by card.
";

#[test]
fn an_entity_the_model_relates_to_a_mentioned_one_is_asked_about() {
    let entries = [
        entry("Invoice", &[]),
        entry("Customer", &["client"]),
        entry("Ledger", &[]),
        entry("Webhook", &[]),
    ];
    let facts = [
        fact(
            "design.md",
            "Ledger",
            "every invoice",
            "The ledger records every invoice.",
        ),
        fact("design.md", "Ledger", "", "The ledger is append-only."),
        fact("adr/0003.md", "Webhook", "", "Webhooks retry three times."),
        // The document's own facts do not count as the project's knowledge.
        fact(
            "prd.md",
            "Invoice",
            "webhook",
            "An invoice triggers a webhook.",
        ),
    ];
    let (qs, _) = questions("prd.md", PRD, &entries, &facts);
    assert_eq!(qs.len(), 1, "{qs:?}");
    assert_eq!(qs[0].entity, "Ledger");
    assert_eq!(qs[0].because_of, ["Invoice"]);
    assert_eq!(qs[0].facts, 2);
    assert_eq!(qs[0].documents, ["design.md"]);
    assert_eq!(
        qs[0].example.as_ref().map(|e| e.0.as_str()),
        Some("design.md")
    );
}

#[test]
fn a_merged_alias_in_the_document_is_drift() {
    let entries = [entry("Customer", &["client"]), entry("Invoice", &[])];
    let (_, drifts) = questions("prd.md", PRD, &entries, &[]);
    assert_eq!(
        drifts,
        [Drift {
            used: "client".into(),
            project_name: "Customer".into(),
            line: 4,
        }]
    );
}

#[test]
fn mentions_are_whole_words() {
    assert!(mentions("the ledgers and the ledger", "ledger").is_some());
    assert!(mentions("ledgerless", "ledger").is_none());
    assert!(
        mentions("an ox", "ox").is_none(),
        "too short to mean anything"
    );
}
