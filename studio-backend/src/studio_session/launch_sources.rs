//! What one session launch clones, and from where.
//!
//! The project's repositories come from its config (`project_sources`), not
//! from the caller: a portal that knew nothing about them, or knew an older
//! list, used to launch an IDE with no code in it. The caller still adds what
//! is not the project's — a folder on the backend host, the shared gear corpus
//! a product project builds against — and anything it lists that the project
//! already has is the project's entry, cloned once.
//!
//! No source host's key reaches a session (#1095). Every Git source, and the
//! workspace root, is cloned through Studio's Git proxy (`studio-git`), which
//! attaches the right key upstream and records the clone; the session proves
//! itself to the proxy with its own credential (`STUDIO_GIT_PROXY_TOKEN`).
//!
//! - **A project source** ([`ProxyRoute::Project`]) is served by name from the
//!   project's config, with its connection's key. One whose connection is held
//!   outside the organization is refused by the proxy, and the clone fails
//!   saying so: it is never cloned anonymously behind the person's back.
//! - **Anything else** ([`ProxyRoute::Extra`]): the workspace root (as
//!   [`ROOT_SOURCE`]) and a source the caller adds (the gear corpus). The
//!   session's launch records it with the key reference it was launched with
//!   ([`extras_env`]); the proxy serves it to that session alone, attaching
//!   the key only when a connection of the organization holds it. Without a
//!   reference it is relayed without credentials, as it was cloned before.
//!
//! Plain functions, so the rules have their tests; `rest::create_session`
//! hands the plan to the service, which writes [`sources_env`] and
//! [`extras_env`] into the session's environment.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::artifact_ingest::port::CloneCause;
use crate::git_proxy::sdk::{NoToken, Source, source_path};
use crate::project_sources::same_repository;

/// The proxy's name for the workspace root: `_` keeps it out of the source
/// directory names (`[a-z0-9_-]+` from a repository's last path segment never
/// starts with one), and the desktop listing already calls it this.
pub const ROOT_SOURCE: &str = "_root";

/// How a Git source reaches its host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProxyRoute {
    /// Not cloned: a local folder.
    None,
    /// One of the project's sources: the proxy reads it, and its key, from
    /// the project's config by name.
    Project,
    /// Not the project's: the proxy serves it to this session from what the
    /// launch recorded, with this key reference when there is one.
    Extra { token_ref: Option<String> },
}

impl ProxyRoute {
    pub fn is_proxied(&self) -> bool {
        !matches!(self, Self::None)
    }
}

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
    /// The credstore reference the caller named, for a source that is not
    /// the project's. Never resolved here: the proxy decides whether the
    /// organization's connection holds it.
    pub token_ref: Option<String>,
    pub route: ProxyRoute,
    /// Why a project source's connection lends no key, when it lends none
    /// (`project_sources`): what the launch can already say about it.
    pub no_token: Option<NoToken>,
}

/// What a launch says on the project's Sources tab about one source (#1071).
///
/// Since #1095 a session's clones go through Studio's Git proxy, which
/// records each one's outcome itself, as it happens: cloned, or failed with
/// its cause (an unreadable key, a connection not found, a host refusal).
/// So the launch no longer reports a token it could not lend. It says the
/// one thing that is certain before any clone, a project source whose
/// connection is held outside the organization (the proxy refuses it), and
/// otherwise clears what an earlier session recorded against the source: a
/// checkout already on the volume is not cloned again, so no proxy record
/// would replace a failure that no longer holds, and a clone that still
/// fails records its cause again moments later.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchClone {
    /// The proxy will refuse it; the session cannot clone it.
    Failed(CloneCause),
    /// Nothing is known against it: an earlier session's failure goes.
    Clear,
    /// Not the project's source: nothing to say.
    Nothing,
}

/// What the launch of `planned` says before any clone (see [`LaunchClone`]).
pub fn launch_clone(planned: &Planned) -> LaunchClone {
    match (&planned.route, planned.no_token) {
        (ProxyRoute::Project, Some(NoToken::HeldOutside)) => {
            LaunchClone::Failed(CloneCause::HeldOutside)
        }
        (ProxyRoute::Project, _) => LaunchClone::Clear,
        _ => LaunchClone::Nothing,
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
            // Held outside the organization or not: the proxy decides, and
            // refuses that one out loud.
            route: ProxyRoute::Project,
            name: s.name,
            kind: "git".to_owned(),
            url: Some(s.url),
            path: None,
            target: s.target,
            branch: s.branch,
            token_ref: None,
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
        asked.route = if asked.kind == "git" {
            ProxyRoute::Extra {
                token_ref: asked
                    .token_ref
                    .as_deref()
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .map(str::to_owned),
            }
        } else {
            ProxyRoute::None
        };
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

/// The proxy's address for one of this workspace's sources, as the container
/// reaches the gateway. `None` without a gateway.
pub fn proxy_clone_url(gateway_url: &str, workspace_id: Uuid, name: &str) -> Option<String> {
    let gateway = gateway_url.trim().trim_end_matches('/');
    (!gateway.is_empty()).then(|| format!("{gateway}{}", source_path(workspace_id, name)))
}

/// The `STUDIO_SOURCES` entries: `url` is the repository's own address (what
/// the workspace manifest records), `clone_url` the proxy's address for it.
/// There is no credential, and no key reference, in any entry.
pub fn sources_env(
    gateway_url: &str,
    workspace_id: Uuid,
    sources: &[GitSourceEnv<'_>],
) -> Vec<serde_json::Value> {
    sources
        .iter()
        .map(|s| {
            let mut entry = serde_json::json!({
                "name": s.name,
                "dir": s.target.map(str::trim).filter(|t| !t.is_empty()).unwrap_or(s.name),
                "url": s.url.trim(),
                "branch": s.branch.map(str::trim).filter(|b| !b.is_empty()),
            });
            if s.via_proxy
                && let Some(clone_url) = proxy_clone_url(gateway_url, workspace_id, s.name)
            {
                entry["clone_url"] = serde_json::Value::String(clone_url);
            }
            entry
        })
        .collect()
}

/// A source the proxy serves to one session only, as its launch recorded it
/// (`STUDIO_GIT_PROXY_EXTRAS`). The key reference is a credstore name, not a
/// key: reading it needs the organization's connection, which the proxy
/// checks on every request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtraSource {
    pub name: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_ref: Option<String>,
}

/// The extras as the launch writes them into the session's environment.
pub fn extras_env(extras: &[ExtraSource]) -> String {
    serde_json::to_string(extras).unwrap_or_else(|_| "[]".to_owned())
}

/// The extras read back from a session's environment, as the proxy's
/// sources. Unreadable means none: the proxy then serves the project's
/// sources only, and anything else fails to clone, saying it is not there.
pub fn parse_extras(raw: Option<&str>) -> Vec<Source> {
    into_sources(
        raw.and_then(|raw| serde_json::from_str::<Vec<ExtraSource>>(raw).ok())
            .unwrap_or_default(),
    )
}

/// The extras as the proxy's sources; one without a name or an address is
/// nothing the proxy could serve.
pub fn into_sources(extras: Vec<ExtraSource>) -> Vec<Source> {
    extras
        .into_iter()
        .filter(|e| !e.name.trim().is_empty() && !e.url.trim().is_empty())
        .map(|e| Source {
            // Without a reference it goes upstream with no key, and a host
            // that then asks for one is told on the Sources tab why (#1071).
            no_token: e.token_ref.is_none().then_some(NoToken::NoConnection),
            name: e.name,
            url: e.url,
            branch: e.branch,
            target: None,
            token_ref: e.token_ref,
            held_outside: None,
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
            no_token: None,
        }
    }

    fn asked(name: &str, kind: &str, url: Option<&str>, token_ref: Option<&str>) -> Planned {
        Planned {
            name: name.to_owned(),
            kind: kind.to_owned(),
            url: url.map(str::to_owned),
            path: (kind == "local").then(|| "/srv/x".to_owned()),
            target: None,
            branch: None,
            token_ref: token_ref.map(str::to_owned),
            route: ProxyRoute::None,
            no_token: None,
        }
    }

    fn lost(no_token: Option<NoToken>) -> Planned {
        let mut source = project("api", "https://github.com/org/api.git");
        source.token_ref = None;
        source.no_token = no_token;
        plan(vec![source], vec![]).remove(0)
    }

    /// #1067 named a launch that cloned without the token its connection
    /// should lend. No launch lends a token any more (#1095): what it can
    /// still say for certain is a project source the proxy will refuse, held
    /// outside the organization, and it says that as a failed clone.
    #[test]
    fn a_launch_says_a_source_held_outside_the_organization_will_not_clone() {
        assert_eq!(
            launch_clone(&lost(Some(NoToken::HeldOutside))),
            LaunchClone::Failed(CloneCause::HeldOutside)
        );
    }

    /// Everything else is the proxy's to record when the clone happens: a
    /// lost connection may still serve a public repository, an unreadable
    /// key is only found out when the proxy reads it, and a source with its
    /// connection is cloned or not by the host. The launch records nothing
    /// against them and clears an earlier session's failure.
    #[test]
    fn a_launch_leaves_every_other_source_to_the_proxys_record() {
        for no_token in [
            None,
            Some(NoToken::NoConnection),
            Some(NoToken::ConnectionNotFound),
            Some(NoToken::Personal),
        ] {
            assert_eq!(
                launch_clone(&lost(no_token)),
                LaunchClone::Clear,
                "{no_token:?}"
            );
        }
        let with_connection = plan(
            vec![project("api", "https://github.com/org/api.git")],
            vec![],
        )
        .remove(0);
        assert_eq!(launch_clone(&with_connection), LaunchClone::Clear);
        // What the caller added is not the project's to report on, even when
        // its reference would be refused: the proxy records that clone too.
        let extra = plan(
            vec![],
            vec![asked(
                "corpus",
                "git",
                Some("https://github.com/org/corpus.git"),
                Some("ref-outside"),
            )],
        )
        .remove(0);
        assert_eq!(launch_clone(&extra), LaunchClone::Nothing);
    }

    #[test]
    fn a_project_source_goes_through_the_proxy_by_name_and_carries_no_key() {
        let got = plan(
            vec![project(
                "studio-web",
                "https://github.com/org/studio-web.git",
            )],
            vec![],
        );
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "studio-web");
        assert_eq!(got[0].route, ProxyRoute::Project);
        assert_eq!(got[0].token_ref, None, "the proxy reads it from the config");
        assert_eq!(got[0].branch.as_deref(), Some("main"));
    }

    /// Held outside the organization: still the proxy's to decide, so the
    /// clone fails with the proxy's reason instead of going anonymous.
    #[test]
    fn a_source_held_outside_the_organization_goes_to_the_proxy_too() {
        let mut outside = project("api", "https://github.com/org/api");
        outside.token_ref = None;
        outside.held_outside = Some(Uuid::nil());
        let got = plan(vec![outside], vec![]);
        assert_eq!(got[0].route, ProxyRoute::Project);
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
                Some("someone-elses-ref"),
            )],
        );
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "studio-web");
        assert_eq!(got[0].route, ProxyRoute::Project);
        assert_eq!(got[0].token_ref, None);
    }

    #[test]
    fn the_corpus_and_other_added_sources_are_proxied_as_extras_with_their_own_reference() {
        let got = plan(
            vec![project("api", "https://github.com/org/api")],
            vec![
                asked(
                    "gears-rust",
                    "git",
                    Some("https://github.com/org/gears-rust"),
                    None,
                ),
                asked(
                    "private",
                    "git",
                    Some("https://github.com/org/private"),
                    Some(" ref-private "),
                ),
                asked("scratch", "local", None, None),
            ],
        );
        let names: Vec<_> = got.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["api", "gears-rust", "private", "scratch"]);
        assert_eq!(got[0].route, ProxyRoute::Project);
        assert_eq!(got[1].route, ProxyRoute::Extra { token_ref: None });
        assert_eq!(
            got[2].route,
            ProxyRoute::Extra {
                token_ref: Some("ref-private".to_owned())
            }
        );
        assert_eq!(got[3].route, ProxyRoute::None);
        assert_eq!(got[3].path.as_deref(), Some("/srv/x"));
    }

    #[test]
    fn an_added_source_whose_name_is_taken_is_renamed() {
        let got = plan(
            vec![project("api", "https://github.com/org/api")],
            vec![
                asked("api", "git", Some("https://github.com/other/api"), None),
                asked("api", "local", None, None),
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
                    via_proxy: true,
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
        assert_eq!(got[1]["branch"], serde_json::Value::Null);
        assert_eq!(
            got[1]["clone_url"],
            format!(
                "http://host.docker.internal:8090/cf/studio-git/v1/workspaces/{ws}/sources/corpus"
            )
        );
        let text = serde_json::Value::Array(got).to_string();
        assert!(!text.contains("token"), "{text}");
    }

    #[test]
    fn without_a_gateway_nothing_has_a_proxy_address() {
        let got = sources_env(
            " ",
            Uuid::nil(),
            &[GitSourceEnv {
                name: "api",
                target: None,
                url: "https://github.com/org/api",
                branch: None,
                via_proxy: true,
            }],
        );
        assert!(got[0].get("clone_url").is_none());
        assert_eq!(proxy_clone_url("", Uuid::nil(), ROOT_SOURCE), None);
    }

    #[test]
    fn the_extras_round_trip_through_the_environment_as_proxy_sources() {
        let raw = extras_env(&[
            ExtraSource {
                name: ROOT_SOURCE.to_owned(),
                url: "https://github.com/org/root".to_owned(),
                branch: Some("main".to_owned()),
                token_ref: Some("ref-root".to_owned()),
            },
            ExtraSource {
                name: "gears-rust".to_owned(),
                url: "https://github.com/org/gears-rust".to_owned(),
                branch: None,
                token_ref: None,
            },
        ]);
        let got = parse_extras(Some(&raw));
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].name, "_root");
        assert_eq!(got[0].token_ref.as_deref(), Some("ref-root"));
        assert_eq!(
            got[0].held_outside, None,
            "the proxy checks ownership itself"
        );
        assert_eq!(got[1].token_ref, None);
        assert!(parse_extras(Some("{not json")).is_empty());
        assert!(parse_extras(None).is_empty());
        assert!(parse_extras(Some(r#"[{"name":"","url":"x"}]"#)).is_empty());
    }
}
