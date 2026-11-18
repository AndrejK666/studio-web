//! What one session launch clones.
//!
//! The project's repositories come from its config (`project_sources`), not
//! from the caller: a portal that knew nothing about them, or knew an older
//! list, used to launch an IDE with no code in it. The caller still adds what
//! is not the project's — a folder on the backend host, the shared gear corpus
//! a product project builds against — and anything it lists that the project
//! already has is the project's entry, cloned once.
//!
//! A plain function, so the rule has its tests; `rest::create_session`
//! resolves the tokens and hands the result to the service.

use crate::artifact_ingest::port::CloneCause;
use crate::git_proxy::sdk::{NoToken, Source};
use crate::project_sources::same_repository;

/// One source to launch with, before its token is resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Planned {
    pub name: String,
    /// `"git"` or `"local"`, as the request spells it.
    pub kind: String,
    pub url: Option<String>,
    pub path: Option<String>,
    pub target: Option<String>,
    pub branch: Option<String>,
    pub token_ref: Option<String>,
    /// One of the project's own sources, rather than one the caller added.
    pub from_project: bool,
    /// Why a project source has no `token_ref`, when it has none.
    pub no_token: Option<NoToken>,
}

/// What a launch says on the project's Sources tab about one source (#1071).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchClone {
    /// The session clones it without the token its connection should lend.
    Failed(CloneCause),
    /// It has its token: a failure an earlier launch recorded no longer holds.
    Clear,
    /// Not the project's source: nothing to say.
    Nothing,
}

/// What the launch of `planned` says, given whether its token was read:
/// `None` when it had no token to read, `Some(false)` when credstore did not
/// give it.
///
/// Only what the server knows for certain before the clone is said. A source
/// that names no connection, or a personal one, may well be public and clone
/// without a token, so its launch says nothing against it; one whose
/// connection is lost or held outside the organization, or whose token cannot
/// be read, was meant to clone with a token and does not get one.
pub fn launch_clone(planned: &Planned, token_read: Option<bool>) -> LaunchClone {
    if !planned.from_project {
        return LaunchClone::Nothing;
    }
    match token_read {
        Some(false) => LaunchClone::Failed(CloneCause::TokenUnreadable),
        Some(true) => LaunchClone::Clear,
        None => match planned.no_token {
            Some(NoToken::ConnectionNotFound) => {
                LaunchClone::Failed(CloneCause::ConnectionNotFound)
            }
            Some(NoToken::HeldOutside) => LaunchClone::Failed(CloneCause::HeldOutside),
            _ => LaunchClone::Clear,
        },
    }
}

/// The project's sources, then each requested source that is not one of
/// them. A requested Git source names the same repository as a project one
/// by URL, whatever it is called; a requested source whose name is taken is
/// renamed `<name>-2`, `-3`…, because the name is the directory.
pub fn plan(project: Vec<Source>, requested: Vec<Planned>) -> Vec<Planned> {
    let mut out: Vec<Planned> = project
        .into_iter()
        .map(|s| Planned {
            name: s.name,
            kind: "git".to_owned(),
            url: Some(s.url),
            path: None,
            target: s.target,
            branch: s.branch,
            token_ref: s.token_ref,
            from_project: true,
            no_token: s.no_token,
        })
        .collect();
    let project_urls: Vec<String> = out.iter().filter_map(|p| p.url.clone()).collect();
    for mut asked in requested {
        let duplicate = asked.kind == "git"
            && asked
                .url
                .as_deref()
                .is_some_and(|url| project_urls.iter().any(|p| same_repository(p, url)));
        if duplicate {
            continue;
        }
        let base = asked.name.clone();
        let mut suffix = 2;
        while out.iter().any(|p| p.name == asked.name) {
            asked.name = format!("{base}-{suffix}");
            suffix += 1;
        }
        out.push(asked);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(name: &str, url: &str) -> Source {
        Source {
            name: name.to_owned(),
            url: url.to_owned(),
            branch: Some("main".to_owned()),
            target: None,
            token_ref: Some(format!("ref-{name}")),
            held_outside: None,
            no_token: None,
        }
    }

    fn asked(name: &str, kind: &str, url: Option<&str>) -> Planned {
        Planned {
            name: name.to_owned(),
            kind: kind.to_owned(),
            url: url.map(str::to_owned),
            path: (kind == "local").then(|| "/srv/x".to_owned()),
            target: None,
            branch: None,
            token_ref: None,
            from_project: false,
            no_token: None,
        }
    }

    fn lost(no_token: Option<NoToken>) -> Planned {
        let mut source = project("api", "https://github.com/org/api.git");
        source.token_ref = None;
        source.no_token = no_token;
        plan(vec![source], vec![]).remove(0)
    }

    /// #1067: the connection was not found, the session cloned without a
    /// token, and the Sources tab said nothing.
    #[test]
    fn a_launch_without_the_token_its_connection_should_lend_is_a_failed_clone() {
        assert_eq!(
            launch_clone(&lost(Some(NoToken::ConnectionNotFound)), None),
            LaunchClone::Failed(CloneCause::ConnectionNotFound)
        );
        assert_eq!(
            launch_clone(&lost(Some(NoToken::HeldOutside)), None),
            LaunchClone::Failed(CloneCause::HeldOutside)
        );
        let read = plan(
            vec![project("api", "https://github.com/org/api.git")],
            vec![],
        )
        .remove(0);
        assert_eq!(
            launch_clone(&read, Some(false)),
            LaunchClone::Failed(CloneCause::TokenUnreadable)
        );
    }

    #[test]
    fn a_launch_with_its_token_or_without_a_connection_says_nothing_against_it() {
        let read = plan(
            vec![project("api", "https://github.com/org/api.git")],
            vec![],
        )
        .remove(0);
        assert_eq!(launch_clone(&read, Some(true)), LaunchClone::Clear);
        // Possibly public: no connection, or a personal one, is no failure.
        assert_eq!(
            launch_clone(&lost(Some(NoToken::NoConnection)), None),
            LaunchClone::Clear
        );
        assert_eq!(
            launch_clone(&lost(Some(NoToken::Personal)), None),
            LaunchClone::Clear
        );
        // What the caller added is not the project's to report on.
        let extra = asked("corpus", "git", Some("https://github.com/org/corpus.git"));
        assert_eq!(launch_clone(&extra, Some(false)), LaunchClone::Nothing);
    }

    #[test]
    fn a_launch_that_lists_nothing_clones_the_projects_repositories() {
        let got = plan(
            vec![project(
                "studio-web",
                "https://github.com/org/studio-web.git",
            )],
            vec![],
        );
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "studio-web");
        assert_eq!(got[0].kind, "git");
        assert_eq!(got[0].token_ref.as_deref(), Some("ref-studio-web"));
        assert_eq!(got[0].branch.as_deref(), Some("main"));
    }

    #[test]
    fn a_repository_the_project_has_is_cloned_once_as_the_projects() {
        let got = plan(
            vec![project(
                "studio-web",
                "https://github.com/org/studio-web.git",
            )],
            vec![asked(
                "web",
                "git",
                Some("https://github.com/Org/studio-web"),
            )],
        );
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "studio-web");
    }

    #[test]
    fn what_is_not_the_projects_is_added_after_it() {
        let got = plan(
            vec![project("api", "https://github.com/org/api")],
            vec![
                asked(
                    "gears-rust",
                    "git",
                    Some("https://github.com/org/gears-rust"),
                ),
                asked("scratch", "local", None),
            ],
        );
        let names: Vec<_> = got.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["api", "gears-rust", "scratch"]);
        assert_eq!(got[2].path.as_deref(), Some("/srv/x"));
    }

    #[test]
    fn an_added_source_whose_name_is_taken_is_renamed() {
        let got = plan(
            vec![project("api", "https://github.com/org/api")],
            vec![
                asked("api", "git", Some("https://github.com/other/api")),
                asked("api", "local", None),
            ],
        );
        let names: Vec<_> = got.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["api", "api-2", "api-3"]);
    }
}
