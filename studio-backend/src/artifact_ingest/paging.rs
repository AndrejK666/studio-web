//! Walking a provider's paged listing to its end.
//!
//! A sync reads a repository's issues, pull requests, comments and commits
//! whole: page after page until the provider answers an empty one. There used
//! to be a ceiling of pages per listing, and a repository past it -- 5,000
//! merge requests and 5,000 commits on platform/alms/core -- came in cut
//! short, with nothing on the run to say so.
//!
//! What is left is a guard against a provider that never ends, which no real
//! repository can reach: a page that repeats the one before it (a provider
//! ignoring the page number answers the same page forever), or a page number
//! no listing has. Either one stops the walk and is logged as an error naming
//! the repository and the listing.

use tracing::error;

/// Pages a listing may run to before it is taken for one that never ends:
/// ten million items at 100 a page. A bound against a broken provider, not a
/// limit on a repository.
pub(super) const RUNAWAY_PAGES: u32 = 100_000;

/// One walk of one paged listing.
pub(super) struct Pages<'a> {
    repo: &'a str,
    listing: &'static str,
    limit: u32,
    page: u32,
    /// The keys of the last page that had any.
    last: Option<Vec<String>>,
}

impl<'a> Pages<'a> {
    /// A walk of `listing` ("issues", "commits") of `repo`, from page 1.
    pub(super) fn new(repo: &'a str, listing: &'static str) -> Self {
        Self::with_limit(repo, listing, RUNAWAY_PAGES)
    }

    pub(super) fn with_limit(repo: &'a str, listing: &'static str, limit: u32) -> Self {
        Self {
            repo,
            listing,
            limit,
            page: 0,
            last: None,
        }
    }

    /// The next page to ask for, or `None` past the runaway bound -- which
    /// is logged as an error, since only a broken provider gets there.
    pub(super) fn next_page(&mut self) -> Option<u32> {
        if self.page >= self.limit {
            error!(
                repo = self.repo,
                listing = self.listing,
                pages = self.limit,
                "studio-artifact-ingest: the listing did not end after this many pages — the provider is taken to be looping, and the rest is not read"
            );
            return None;
        }
        self.page += 1;
        Some(self.page)
    }

    /// Whether the page just read, by its items' keys, is the one before it
    /// again: then the provider is answering the same page whatever is asked,
    /// and the walk stops (logged as an error). A page without items never
    /// counts -- the walk ends on one anyway, or the provider dropped what was
    /// on it (`ConnectorDriver::list_issue_page`).
    pub(super) fn repeats<I, S>(&mut self, keys: I) -> bool
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let keys: Vec<String> = keys.into_iter().map(Into::into).collect();
        if keys.is_empty() {
            return false;
        }
        if self.last.as_ref() == Some(&keys) {
            error!(
                repo = self.repo,
                listing = self.listing,
                page = self.page,
                "studio-artifact-ingest: the provider answered the same page twice — it is taken to be looping, and the rest is not read"
            );
            return true;
        }
        self.last = Some(keys);
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_count_from_one_to_the_bound_and_no_further() {
        let mut pages = Pages::with_limit("acme/app", "issues", 3);
        let walked: Vec<u32> = std::iter::from_fn(|| pages.next_page()).collect();
        assert_eq!(walked, vec![1, 2, 3]);
        assert_eq!(pages.next_page(), None, "still past it when asked again");
    }

    #[test]
    fn the_bound_is_no_limit_a_repository_can_reach() {
        // Ten million items at the sync's 100 a page.
        assert!(u64::from(RUNAWAY_PAGES) * 100 >= 10_000_000);
    }

    #[test]
    fn a_page_answered_twice_stops_the_walk_and_a_new_one_does_not() {
        let mut pages = Pages::new("acme/app", "commits");
        assert!(!pages.repeats(["a", "b"]));
        assert!(!pages.repeats(["c", "d"]));
        assert!(pages.repeats(["c", "d"]));
    }

    #[test]
    fn pages_without_items_are_never_taken_for_a_repeat() {
        // A GitHub page of nothing but pull requests is no issues, twice in a
        // row, and the listing still goes on.
        let mut pages = Pages::new("acme/app", "issues");
        assert!(!pages.repeats(Vec::<String>::new()));
        assert!(!pages.repeats(Vec::<String>::new()));
        assert!(!pages.repeats(["a"]));
        assert!(!pages.repeats(Vec::<String>::new()));
        assert!(!pages.repeats(["b"]));
    }
}
