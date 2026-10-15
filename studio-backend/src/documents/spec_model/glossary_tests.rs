use super::*;

fn fact(path: &str, kind: &str, subject: &str, aspect: &str, value: &str) -> Fact {
    Fact {
        kind: kind.into(),
        subject: subject.into(),
        aspect: aspect.into(),
        value: value.into(),
        text: format!("{subject} {aspect} {value}"),
        status: "active".into(),
        status_because: String::new(),
        path: path.into(),
        line_start: 1,
        line_end: 1,
        quote: format!("{subject} {value}"),
        layer: None,
    }
}

fn alias(key: &str, of: &str) -> Choice {
    Choice {
        key: key.into(),
        name: None,
        alias_of: Some(of.into()),
    }
}

fn named(key: &str, name: &str) -> Choice {
    Choice {
        key: key.into(),
        name: Some(name.into()),
        alias_of: None,
    }
}

fn model() -> Vec<Fact> {
    vec![
        fact("PRD.md", "entity", "Tenant", "", ""),
        fact("PRD.md", "attribute", "tenants", "limit", "10 seats"),
        fact("DESIGN.md", "attribute", "Tenant", "region", "eu"),
        fact("DESIGN.md", "entity", "Organization", "", ""),
        fact("ADR-1.md", "decision", "ADR-0001", "", ""),
    ]
}

#[test]
fn spellings_that_fold_together_are_one_entry_named_by_the_most_frequent() {
    let got = entries(&model(), &[]);
    assert_eq!(got.len(), 2, "a decision-only subject is no entry");
    let tenant = &got[0];
    assert_eq!(tenant.key, "tenant");
    assert_eq!(tenant.name, "Tenant");
    assert!(!tenant.chosen);
    assert_eq!(tenant.spellings, ["Tenant", "tenants"]);
    assert_eq!((tenant.facts, tenant.documents), (3, 2));
}

#[test]
fn a_chosen_name_replaces_the_most_frequent_spelling() {
    let got = entries(&model(), &[named("tenant", "Workspace tenant")]);
    assert_eq!(got[0].name, "Workspace tenant");
    assert!(got[0].chosen);
}

#[test]
fn an_alias_merges_its_spellings_and_facts_into_the_entry() {
    let got = entries(&model(), &[alias("organization", "tenant")]);
    assert_eq!(got.len(), 1);
    let e = &got[0];
    assert_eq!(e.facts, 4);
    assert_eq!(
        e.aliases,
        [Alias {
            key: "organization".into(),
            name: "Organization".into()
        }]
    );
    assert!(e.spellings.contains(&"Organization".to_string()));
}

#[test]
fn an_alias_of_a_vanished_entry_of_itself_or_of_an_alias_holds_nothing() {
    assert_eq!(
        entries(&model(), &[alias("organization", "account")]).len(),
        2
    );
    assert_eq!(entries(&model(), &[alias("tenant", "tenant")]).len(), 2);
    // organization → tenant, tenant → organization: neither holds, so a
    // cycle never hides both entries.
    let cycle = entries(
        &model(),
        &[
            alias("organization", "tenant"),
            alias("tenant", "organization"),
        ],
    );
    assert_eq!(cycle.len(), 2);
}

#[test]
fn applied_aliases_give_the_rules_one_subject_and_keep_the_passages() {
    let facts = model();
    let applied = apply(
        &facts,
        &[alias("organization", "tenant"), named("tenant", "Org")],
    );
    let keys: BTreeSet<String> = applied
        .iter()
        .filter(|f| f.kind != "decision")
        .map(|f| subject_key(&f.subject))
        .collect();
    assert_eq!(keys, BTreeSet::from(["tenant".to_string()]));
    assert_eq!(applied[3].quote, facts[3].quote);
    assert_eq!(apply(&facts, &[named("tenant", "Org")]), facts);
}
