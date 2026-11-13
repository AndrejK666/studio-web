//! What one session launch clones, and from where.
//!
//! The project's repositories come from its config (`project_sources`), not
//! from the caller: a portal that knew nothing about them, or knew an older
//! list, used to launch an IDE with no code in it. The caller still adds what
//! is not the project's — a folder on the backend host, the shared gear corpus
//! a product project builds against — and anything it lists that the project
//! already has is the project's entry, cloned once.
//!
//! No source host's key reaches a session (#1095). A project source whose
//! connection is the organization's is cloned through Studio's Git proxy
//! (`studio-git`), which attaches the connection's key upstream and records
//! the clone; the session proves itself to the proxy with its own credential
//! (`STUDIO_GIT_PROXY_TOKEN`), never with a provider's token. Anything else is
//! cloned straight from its host, without credentials.
//!
//! Plain functions, so the rules have their tests; `rest::create_session`
//! hands the plan to the service, which writes [`sources_env`] into the
//! session's environment.

use uuid::Uuid;

use crate::git_proxy::sdk::{Source, source_path};
use crate::project_sources::same_repository;

/// One source to launch with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Planned {
    pub name: String,
    /// `"git"` or `"local"`, as the request spells it.
    pub kind: String,
    pub url: Option<String>,
    pub path: Option<String>,
    pub target: Option<String>,
    pub branch: Option<String>,
    /// Cloned through `studio-git` under this name. Only a project source
    /// whose connection the organization holds: the proxy serves the
    /// project's sources by name and refuses one held outside it.
    pub via_proxy: bool,
}

/// The project's sources, then each requested source that is not one of
/// them. A requested Git source names the same repository as a project one
/// by URL, whatever it is called; a requested source whose name is taken is
/// renamed `<name>-2`, `-3`…, because the name is the directory.
pub fn plan(project: Vec<Source>, requested: Vec<Planned>) -> Vec<Planned> {
    let mut out: Vec<Planned> = project
        .into_iter()
        .map(|s| Planned {
            via_proxy: s.held_outside.is_none(),
            name: s.name,
            kind: "git".to_owned(),
            url: Some(s.url),
            path: None,
            target: s.target,
            branch: s.branch,
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
        // Not the project's: the proxy does not know it by any name.
        asked.via_proxy = false;
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

/// One Git source as the session's entrypoint reads it (`STUDIO_SOURCES`).
pub struct GitSourceEnv<'a> {
    pub name: &'a str,
    pub target: Option<&'a str>,
    pub url: &'a str,
    pub branch: Option<&'a str>,
    pub via_proxy: bool,
}

/// The `STUDIO_SOURCES` entries: `url` is the repository's own address (what
/// the workspace manifest records), `clone_url` the proxy's address for it,
/// as the container reaches the gateway, when it goes through the proxy.
/// There is no credential in any entry.
pub fn sources_env(
    gateway_url: &str,
    workspace_id: Uuid,
    sources: &[GitSourceEnv<'_>],
) -> Vec<serde_json::Value> {
    let gateway = gateway_url.trim().trim_end_matches('/');
    sources
        .iter()
        .map(|s| {
            let mut entry = serde_json::json!({
                "name": s.name,
                "dir": s.target.map(str::trim).filter(|t| !t.is_empty()).unwrap_or(s.name),
                "url": s.url.trim(),
                "branch": s.branch.map(str::trim).filter(|b| !b.is_empty()),
            });
            if s.via_proxy && !gateway.is_empty() {
                entry["clone_url"] = serde_json::Value::String(format!(
                    "{gateway}{}",
                    source_path(workspace_id, s.name)
                ));
            }
            entry
        })
        .collect()
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
            via_proxy: false,
        }
    }

    #[test]
    fn a_launch_that_lists_nothing_clones_the_projects_repositories_through_the_proxy() {
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
        assert!(got[0].via_proxy);
        assert_eq!(got[0].branch.as_deref(), Some("main"));
    }

    #[test]
    fn a_source_held_outside_the_organization_is_not_proxied() {
        let mut outside = project("api", "https://github.com/org/api");
        outside.token_ref = None;
        outside.held_outside = Some(Uuid::nil());
        let got = plan(vec![outside], vec![]);
        assert!(
            !got[0].via_proxy,
            "the proxy refuses it, so it is cloned openly"
        );
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
        assert!(got[0].via_proxy);
    }

    #[test]
    fn what_is_not_the_projects_is_added_after_it_and_never_proxied() {
        let mut corpus = asked(
            "gears-rust",
            "git",
            Some("https://github.com/org/gears-rust"),
        );
        // Whatever the caller says: the proxy knows only the project's sources.
        corpus.via_proxy = true;
        let got = plan(
            vec![project("api", "https://github.com/org/api")],
            vec![corpus, asked("scratch", "local", None)],
        );
        let names: Vec<_> = got.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["api", "gears-rust", "scratch"]);
        assert_eq!(got[2].path.as_deref(), Some("/srv/x"));
        assert!(got[0].via_proxy);
        assert!(!got[1].via_proxy);
        assert!(!got[2].via_proxy);
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

    #[test]
    fn the_session_is_given_the_proxy_address_and_no_credential() {
        let ws = Uuid::from_u128(0xb0b);
        let got = sources_env(
            "http://host.docker.internal:8090/cf/",
            ws,
            &[
                GitSourceEnv {
                    name: "api",
                    target: Some(" services/api "),
                    url: " https://github.com/org/api.git ",
                    branch: Some("main"),
                    via_proxy: true,
                },
                GitSourceEnv {
                    name: "corpus",
                    target: None,
                    url: "https://github.com/org/gears-rust",
                    branch: Some(" "),
                    via_proxy: false,
                },
            ],
        );
        assert_eq!(
            got[0],
            serde_json::json!({
                "name": "api",
                "dir": "services/api",
                "url": "https://github.com/org/api.git",
                "branch": "main",
                "clone_url": format!(
                    "http://host.docker.internal:8090/cf/studio-git/v1/workspaces/{ws}/sources/api"
                ),
            })
        );
        assert_eq!(
            got[1],
            serde_json::json!({
                "name": "corpus",
                "dir": "corpus",
                "url": "https://github.com/org/gears-rust",
                "branch": null,
            })
        );
        let text = serde_json::Value::Array(got).to_string();
        assert!(!text.contains("token"), "{text}");
    }
}
