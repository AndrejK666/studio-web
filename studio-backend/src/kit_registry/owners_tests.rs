use super::*;

#[test]
fn the_built_in_kits_say_who_brings_the_moved_screens_types() {
    let owners = KitOwners::builtin();
    // ADR-0071 step 4: Issues and `finding` to the Project model, project
    // Components (`project.parts`) to Product & Releases.
    assert_eq!(
        owners.owner("finding", MarkOn::Type),
        Some("project-domain-model")
    );
    assert_eq!(
        owners.owner("project", MarkOn::Property("issues")),
        Some("project-domain-model")
    );
    assert_eq!(
        owners.owner("kit", MarkOn::Property("introduces_type_22")),
        Some("project-domain-model")
    );
    assert_eq!(
        owners.owner("project", MarkOn::Property("parts")),
        Some("project-product")
    );
    // A claimed gear type, and a field of a kit's own type (it comes with
    // the type).
    assert_eq!(owners.owner("ci-run", MarkOn::Type), Some("project-tests"));
    assert_eq!(
        owners.owner("project", MarkOn::Lifecycle("phase")),
        Some("project-lifecycle")
    );
}

#[test]
fn a_mark_moves_only_from_a_kit_of_studio_s_that_no_longer_brings_it() {
    let owners = KitOwners::builtin();
    assert_eq!(
        owners.rehome("project-issues", "finding", MarkOn::Type),
        Some(Rehome::Kit("project-domain-model".into()))
    );
    assert_eq!(
        owners.rehome("components", "project", MarkOn::Property("parts")),
        Some(Rehome::Kit("project-product".into()))
    );
    // Where it already is.
    assert_eq!(
        owners.rehome("project-domain-model", "finding", MarkOn::Type),
        None
    );
    // A retired slug's marks go to the kit that brings each piece (ADR-0071
    // §8): one slug split in two lands in both.
    assert_eq!(
        owners.rehome("product-releases", "deployment", MarkOn::Type),
        Some(Rehome::Kit("delivery".into()))
    );
    assert_eq!(
        owners.rehome("product-releases", "project", MarkOn::Property("components")),
        Some(Rehome::Kit("project-product".into()))
    );
    assert_eq!(
        owners.rehome(
            "org-infrastructure",
            "organization",
            MarkOn::Property("environments")
        ),
        Some(Rehome::Kit("delivery".into()))
    );
    assert_eq!(
        owners.rehome("project-activity", "comment", MarkOn::Type),
        Some(Rehome::Kit("project-git".into()))
    );
    assert_eq!(
        owners.rehome("project-issues", "work-item", MarkOn::Type),
        Some(Rehome::Kit("project-git".into()))
    );
    // An organization's own kit keeps its marks.
    assert_eq!(owners.rehome("acme-ops", "finding", MarkOn::Type), None);
    // A piece no built-in kit brings stays its kit's to leave.
    assert_eq!(
        owners.rehome("project-issues", "no-such-type", MarkOn::Type),
        None
    );
}
