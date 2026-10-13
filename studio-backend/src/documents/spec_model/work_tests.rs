use super::*;

fn ids(list: &[&str]) -> BTreeMap<String, Vec<Side>> {
    list.iter()
        .map(|id| ((*id).to_string(), vec![Side::at("docs/PRD.md", 3, id)]))
        .collect()
}

fn item(kind: &str, number: Option<i64>, title: &str, text: &str) -> WorkItem {
    WorkItem {
        kind: kind.into(),
        number,
        title: title.into(),
        text: text.into(),
        ..WorkItem::default()
    }
}

#[test]
fn work_that_names_an_identifier_is_linked_to_it_in_title_or_text() {
    let work = [
        item(
            "pull_request",
            Some(7),
            "feat: uploads (cpt-shop-fr-upload)",
            "",
        ),
        item(
            "issue",
            Some(9),
            "Uploads are slow",
            "See `cpt-shop-fr-upload`.",
        ),
        item("commit", None, "fix typo", "no id here"),
    ];
    let (linked, unlinked) = link(&ids(&["cpt-shop-fr-upload", "cpt-shop-fr-login"]), &work);
    assert_eq!(linked.len(), 1, "an identifier no work names is left out");
    assert_eq!(linked[0].id, "cpt-shop-fr-upload");
    assert_eq!(linked[0].work, [1, 0], "newest number first");
    assert_eq!(linked[0].defined[0].path, "docs/PRD.md");
    assert_eq!(unlinked, 1);
}

#[test]
fn an_identifier_is_named_only_as_a_whole_token_in_any_case() {
    let work = [
        item("issue", Some(1), "cpt-shop-fr-12 is done", ""),
        item("issue", Some(2), "drafting cpt-shop-fr-1-draft", ""),
        item("issue", Some(3), "CPT-SHOP-FR-1: login", ""),
    ];
    let (linked, _) = link(&ids(&["cpt-shop-fr-1"]), &work);
    assert_eq!(linked[0].work, [2], "neither -12 nor -1-draft names -1");
}

#[test]
fn issues_and_pull_requests_come_before_commits() {
    let work = [
        item("commit", None, "feat: cpt-shop-fr-upload", ""),
        item("issue", Some(4), "cpt-shop-fr-upload", ""),
    ];
    let (linked, _) = link(&ids(&["cpt-shop-fr-upload"]), &work);
    assert_eq!(linked[0].work, [1, 0]);
}

#[test]
fn one_piece_of_work_can_name_several_identifiers() {
    let work = [item(
        "pull_request",
        Some(5),
        "uploads and login",
        "Implements cpt-shop-fr-upload and cpt-shop-fr-login.",
    )];
    let (linked, unlinked) = link(&ids(&["cpt-shop-fr-upload", "cpt-shop-fr-login"]), &work);
    assert_eq!(linked.len(), 2);
    assert_eq!(unlinked, 0);
}
