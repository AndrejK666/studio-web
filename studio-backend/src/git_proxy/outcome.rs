//! What a clone or fetch through this proxy says about its source (#1071):
//! cloned, or failed with the cause the Sources tab names. A plain function
//! of what the proxy saw, so each case has its test; `rest` records the
//! result through `artifact_ingest::port::CloneOutcomes`.

use crate::artifact_ingest::port::{CloneCause, CloneFailure};

use super::sources::NoToken;

/// What the source host did with one upload-pack request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Upstream {
    /// It answered with this status.
    Answered(u16),
    /// It refused the credential, 401 or 403 (the proxy answers `git` 403
    /// either way, so which of the two is not kept).
    Refused,
    /// It could not be reached.
    Unreachable,
}

/// The cause a missing token stands for.
pub fn cause_of(no_token: NoToken) -> CloneCause {
    match no_token {
        NoToken::NoConnection => CloneCause::NoConnection,
        NoToken::ConnectionNotFound => CloneCause::ConnectionNotFound,
        NoToken::Personal => CloneCause::ConnectionPersonal,
        NoToken::HeldOutside => CloneCause::HeldOutside,
    }
}

/// `None` when the source host served the request; otherwise why not.
///
/// A host that asks for credentials the proxy did not send is not refusing
/// the connection's token, there was none: the cause is why there was none.
/// A 404 to a request without a token is read the same way, because a host
/// may hide a private repository behind "not found" (GitHub does, to the
/// API). For a source with no connection at all that stays ambiguous, so the
/// failure keeps the connection remedy and its detail names both readings.
pub fn failure_of(upstream: Upstream, no_token: Option<NoToken>) -> Option<CloneFailure> {
    let missing = no_token.map(cause_of);
    match upstream {
        Upstream::Answered(status) if (200..300).contains(&status) => None,
        Upstream::Refused => Some(
            CloneFailure::new(missing.unwrap_or(CloneCause::ProviderRefused))
                .with_detail("The repository's host answered 401 or 403."),
        ),
        Upstream::Answered(status @ (401 | 403)) => Some(
            CloneFailure::new(missing.unwrap_or(CloneCause::ProviderRefused)).with_status(status),
        ),
        Upstream::Answered(404) => Some(match missing {
            Some(CloneCause::NoConnection) => CloneFailure::new(CloneCause::NoConnection)
                .with_status(404)
                .with_detail(
                    "The repository's host answered 404: the repository does not exist, \
                     or it is private and needs a connection.",
                ),
            Some(cause) => CloneFailure::new(cause).with_status(404),
            None => CloneFailure::new(CloneCause::RepositoryNotFound).with_status(404),
        }),
        Upstream::Answered(status) => {
            Some(CloneFailure::new(CloneCause::ProviderError).with_status(status))
        }
        Upstream::Unreachable => Some(CloneFailure::new(CloneCause::Unreachable)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cause(upstream: Upstream, no_token: Option<NoToken>) -> Option<CloneCause> {
        failure_of(upstream, no_token).map(|f| f.cause)
    }

    #[test]
    fn a_served_request_is_a_clone() {
        assert_eq!(cause(Upstream::Answered(200), None), None);
        assert_eq!(
            cause(Upstream::Answered(200), Some(NoToken::NoConnection)),
            None
        );
    }

    #[test]
    fn a_refused_token_is_the_providers_refusal() {
        assert_eq!(
            cause(Upstream::Refused, None),
            Some(CloneCause::ProviderRefused)
        );
        let f = failure_of(Upstream::Answered(401), None).unwrap();
        assert_eq!(f.cause, CloneCause::ProviderRefused);
        assert_eq!(f.upstream_status, Some(401));
    }

    /// #1067: the connection was not found, so the clone went without a
    /// token and the host asked for one.
    #[test]
    fn credentials_asked_for_and_not_sent_name_why_there_were_none() {
        assert_eq!(
            cause(Upstream::Refused, Some(NoToken::ConnectionNotFound)),
            Some(CloneCause::ConnectionNotFound)
        );
        assert_eq!(
            cause(Upstream::Answered(401), Some(NoToken::NoConnection)),
            Some(CloneCause::NoConnection)
        );
        assert_eq!(
            cause(Upstream::Refused, Some(NoToken::Personal)),
            Some(CloneCause::ConnectionPersonal)
        );
        assert_eq!(
            cause(Upstream::Answered(404), Some(NoToken::HeldOutside)),
            Some(CloneCause::HeldOutside)
        );
    }

    #[test]
    fn a_missing_repository_and_a_failing_host_are_said_apart() {
        assert_eq!(
            cause(Upstream::Answered(404), None),
            Some(CloneCause::RepositoryNotFound)
        );
        let f = failure_of(Upstream::Answered(502), None).unwrap();
        assert_eq!(f.cause, CloneCause::ProviderError);
        assert_eq!(f.upstream_status, Some(502));
        assert_eq!(
            cause(Upstream::Unreachable, None),
            Some(CloneCause::Unreachable)
        );
    }

    /// #1070 review: a private repository behind a source with no
    /// connection can answer 404. The remedy stays "connect", and the detail
    /// says the repository may also not exist.
    #[test]
    fn a_404_without_a_connection_keeps_the_connection_remedy() {
        let f = failure_of(Upstream::Answered(404), Some(NoToken::NoConnection)).unwrap();
        assert_eq!(f.cause, CloneCause::NoConnection);
        assert_eq!(f.cause.action().as_str(), "connect");
        assert_eq!(f.upstream_status, Some(404));
        assert!(f.detail.contains("does not exist"), "{}", f.detail);
        assert!(f.detail.contains("needs a connection"), "{}", f.detail);
        assert!(
            !f.cause.text().contains("asked for credentials"),
            "a 404 asks for nothing: {}",
            f.cause.text()
        );
    }
}
