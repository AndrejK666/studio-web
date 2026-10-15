use super::*;

fn renamed(text: &str) -> Option<String> {
    rename(text, "member", "Teammate").map(|(t, _)| t)
}

#[test]
fn a_whole_word_is_renamed_keeping_its_first_letter_case() {
    let (text, n) = rename("Member invites a member. MEMBER too.", "member", "teammate").unwrap();
    assert_eq!(text, "Teammate invites a teammate. Teammate too.");
    assert_eq!(n, 3);
    assert_eq!(
        renamed("a member and a Member").as_deref(),
        Some("a teammate and a Teammate")
    );
}

#[test]
fn part_of_a_longer_word_is_left_alone() {
    assert_eq!(renamed("membership and members and remember"), None);
    assert_eq!(renamed("a member_id"), None);
    assert_eq!(
        renamed("(member), member.").as_deref(),
        Some("(teammate), teammate.")
    );
}

#[test]
fn nothing_to_rename_is_none() {
    assert_eq!(renamed("no such word"), None);
    assert_eq!(rename("a member", "  ", "x"), None);
    assert_eq!(rename("a member", "member", " "), None);
}

#[test]
fn code_spans_and_fenced_code_stay() {
    let text = "Use `member` or ``a member``.\n\n```rust\nlet member = 1;\n```\n\nA member.\n";
    assert_eq!(
        renamed(text).as_deref(),
        Some("Use `member` or ``a member``.\n\n```rust\nlet member = 1;\n```\n\nA teammate.\n")
    );
    let tilde = "~~~\nmember\n~~~\nmember\n";
    assert_eq!(
        renamed(tilde).as_deref(),
        Some("~~~\nmember\n~~~\nteammate\n")
    );
}

#[test]
fn an_unclosed_backtick_is_text() {
    assert_eq!(renamed("a ` member").as_deref(), Some("a ` teammate"));
}

#[test]
fn a_links_destination_stays_but_its_label_is_renamed() {
    assert_eq!(
        renamed("See [the member](docs/member.md) and <https://x.io/member>.").as_deref(),
        Some("See [the teammate](docs/member.md) and <https://x.io/member>.")
    );
    assert_eq!(
        renamed("[member]: https://x.io/member\n").as_deref(),
        Some("[teammate]: https://x.io/member\n")
    );
}

#[test]
fn front_matter_stays() {
    let text = "---\nowner: member\n---\n\n# Member\n";
    assert_eq!(
        renamed(text).as_deref(),
        Some("---\nowner: member\n---\n\n# Teammate\n")
    );
}

#[test]
fn a_phrase_and_an_acronym() {
    assert_eq!(
        rename(
            "The product owner and the Product Owner.",
            "product owner",
            "Sponsor"
        ),
        Some(("The sponsor and the Sponsor.".to_owned(), 2))
    );
    assert_eq!(
        rename("call the api", "api", "SDK")
            .map(|(t, _)| t)
            .as_deref(),
        Some("call the SDK")
    );
}

#[test]
fn non_ascii_text_keeps_its_bytes() {
    assert_eq!(
        renamed("Ein Mitglied — member — ok").as_deref(),
        Some("Ein Mitglied — teammate — ok")
    );
    assert_eq!(
        rename("Über alles, über", "über", "oben")
            .map(|(t, _)| t)
            .as_deref(),
        Some("Oben alles, oben")
    );
}

#[test]
fn crlf_lines_are_kept() {
    assert_eq!(
        renamed("member\r\n```\r\nmember\r\n```\r\n").as_deref(),
        Some("teammate\r\n```\r\nmember\r\n```\r\n")
    );
}
