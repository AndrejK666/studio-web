//! Where a document goes in a repository.
//!
//! One convention — `docs/<type>/<slug>.md` — and until now it existed in a
//! single portal's source, as the value prefilled into the publish form. The
//! write itself takes whatever path it is handed, so this was never enforced;
//! it was simply the only place that had an opinion, and every document this
//! product has committed went where it said.
//!
//! That is exactly the kind of rule a second portal re-invents: not because it
//! is hard, but because there is nothing to read it off. Two portals with two
//! layouts scatter the same documents across one repository, and nothing
//! reports it — the commits all succeed.
//!
//! Served as a SUGGESTION rather than imposed. A person editing the field is
//! making a decision about their own repository, and the server has no
//! business overruling it.

/// `docs/<type>/<slug>.md` for a document of this type with this title.
#[must_use]
pub fn suggested_path(type_key: &str, title: &str) -> String {
    format!("docs/{type_key}/{}.md", slug(title))
}

/// A filename-safe slug of a title.
///
/// A RUN of anything that is not a letter or digit becomes one hyphen, the
/// ends are trimmed, the result is capped, and a title with nothing sluggable
/// in it becomes `untitled` rather than an empty filename.
///
/// The cap and the fallback are not tidiness. A path of `docs/prd/.md` is a
/// file nobody can find and a commit nobody questions, and a title pasted from
/// a document can be a paragraph long.
#[must_use]
pub fn slug(title: &str) -> String {
    /// Long enough for any title worth reading, short enough to be a filename.
    const MAX: usize = 60;

    let mut out = String::with_capacity(title.len().min(MAX));
    let mut pending_gap = false;
    for ch in title.trim().chars() {
        if !ch.is_ascii_alphanumeric() {
            pending_gap = true;
            continue;
        }
        // The separator and the character it separates are pushed together,
        // so the cap is checked against BOTH: checking after pushing let one
        // iteration add two characters and overshoot by one.
        let width = usize::from(pending_gap && !out.is_empty()) + 1;
        if out.len() + width > MAX {
            break;
        }
        if pending_gap && !out.is_empty() {
            out.push('-');
        }
        pending_gap = false;
        out.push(ch.to_ascii_lowercase());
    }
    // A cut can still land right after a separator.
    let out = out.trim_end_matches('-');
    if out.is_empty() {
        return "untitled".to_owned();
    }
    out.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_title_becomes_a_path_under_its_type() {
        assert_eq!(
            suggested_path("prd", "Product Requirements"),
            "docs/prd/product-requirements.md"
        );
    }

    #[test]
    fn a_run_of_punctuation_is_one_hyphen_not_several() {
        assert_eq!(slug("Product Requirements (v2)"), "product-requirements-v2");
        assert_eq!(slug("A -- B"), "a-b");
    }

    #[test]
    fn the_ends_are_trimmed_rather_than_left_hanging() {
        assert_eq!(slug("  Hello!  "), "hello");
        assert_eq!(slug("...draft..."), "draft");
    }

    #[test]
    fn a_title_with_nothing_sluggable_in_it_is_untitled_not_empty() {
        // `docs/prd/.md` is a file nobody can find and a commit nobody
        // questions.
        assert_eq!(slug("···"), "untitled");
        assert_eq!(suggested_path("prd", "···"), "docs/prd/untitled.md");
    }

    #[test]
    fn a_title_pasted_from_a_document_is_capped() {
        let long = "word ".repeat(40);
        let out = slug(&long);
        assert!(out.len() <= 60, "{} chars", out.len());
        assert!(!out.ends_with('-'), "no hanging hyphen: {out}");
    }

    #[test]
    fn case_and_digits_survive_as_themselves() {
        assert_eq!(slug("ADR 0007 Shell Tokens"), "adr-0007-shell-tokens");
    }
}
