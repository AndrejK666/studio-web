//! One list-pagination contract for the Studio REST surface.
//!
//! Every collection endpoint takes the same two query parameters and reports
//! the same total, so a caller that can page one list can page all of them:
//!
//! ```text
//! ?offset=<0..>&limit=<1..=200, default 50>   ->   { <items>, total }
//! ```
//!
//! `total` counts the matches across every page (filters applied, pagination
//! not), so a client can render "N of M" and knows another page exists exactly
//! when `offset + returned < total`. There is no cursor: these collections are
//! sorted by a stable key and re-read cheaply, and an offset survives a client
//! reload in a way an opaque cursor does not. `/studio-artifact-ingest/v1/nodes`
//! predates this module and additionally accepts a legacy `cursor`; new
//! endpoints do not grow one.
//!
//! [`page_of`] slices a collection the handler has already materialised. That
//! bounds the RESPONSE, not the read — a handler whose store can page natively
//! should push `offset`/`limit` down instead of calling this.

/// Page size used when the caller does not ask for one. Matches the default
/// `/studio-artifact-ingest/v1/nodes` has served since it was written.
pub const DEFAULT_LIMIT: usize = 50;

/// Ceiling on `limit`. A larger value is clamped rather than refused: a client
/// asking for "everything" should get a large page and an honest `total`, not
/// a 400 it has no way to anticipate.
pub const MAX_LIMIT: usize = 200;

/// The `?offset=&limit=` pair, flattened into an endpoint's own query struct:
///
/// ```ignore
/// #[derive(serde::Deserialize)]
/// pub struct ObjectsQuery {
///     #[serde(default)]
///     pub r#type: Option<String>,
///     #[serde(flatten)]
///     pub page: PageQuery,
/// }
/// ```
#[derive(Debug, Default, Clone, Copy, serde::Deserialize)]
pub struct PageQuery {
    /// Zero-based index of the first item to return. Past the end yields an
    /// empty page and the real `total`, not an error.
    #[serde(default, deserialize_with = "number_or_numeric_string")]
    pub offset: Option<usize>,
    /// Number of items to return, clamped to `1..=`[`MAX_LIMIT`].
    #[serde(default, deserialize_with = "number_or_numeric_string")]
    pub limit: Option<usize>,
}

/// Accept `20` and `"20"` for the same parameter, and treat `?limit=` as unset.
///
/// This is what makes `#[serde(flatten)]` usable. `axum::extract::Query`
/// decodes through `serde_urlencoded`, which coerces `"20"` to a number only
/// while deserializing a field directly; a flattened struct is buffered first
/// and the value reaches the inner type still a string, so a plain
/// `Option<usize>` fails with `invalid type: string "20", expected usize` —
/// a 400 on every paged request that carries a filter.
fn number_or_numeric_string<'de, D>(deserializer: D) -> Result<Option<usize>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::Deserialize as _;

    #[derive(serde::Deserialize)]
    #[serde(untagged)]
    enum NumberOrString {
        Number(usize),
        Text(String),
    }

    match Option::<NumberOrString>::deserialize(deserializer)? {
        None => Ok(None),
        Some(NumberOrString::Number(value)) => Ok(Some(value)),
        Some(NumberOrString::Text(text)) => {
            let text = text.trim();
            if text.is_empty() {
                return Ok(None);
            }
            text.parse().map(Some).map_err(serde::de::Error::custom)
        }
    }
}

impl PageQuery {
    /// Requested page size, defaulted and clamped.
    #[must_use]
    pub fn limit(self) -> usize {
        self.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)
    }

    /// Requested start offset, defaulted to the first item.
    #[must_use]
    pub fn offset(self) -> usize {
        self.offset.unwrap_or(0)
    }
}

/// Slice one page out of an already-materialised, already-sorted collection.
///
/// Returns the page and the total length before slicing — callers report that
/// as `total` so the client can page without a second request.
#[must_use]
pub fn page_of<T>(items: Vec<T>, page: PageQuery) -> (Vec<T>, u32) {
    let total = u32::try_from(items.len()).unwrap_or(u32::MAX);
    let start = page.offset().min(items.len());
    let end = start.saturating_add(page.limit()).min(items.len());
    let mut items = items;
    items.truncate(end);
    (items.split_off(start), total)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(offset: Option<usize>, limit: Option<usize>) -> PageQuery {
        PageQuery { offset, limit }
    }

    #[test]
    fn defaults_to_the_first_fifty() {
        let page = q(None, None);
        assert_eq!(page.offset(), 0);
        assert_eq!(page.limit(), DEFAULT_LIMIT);
    }

    #[test]
    fn limit_is_clamped_not_refused() {
        assert_eq!(q(None, Some(0)).limit(), 1);
        assert_eq!(q(None, Some(10_000)).limit(), MAX_LIMIT);
    }

    #[test]
    fn slices_the_requested_window_and_reports_the_full_total() {
        let items: Vec<u32> = (0..10).collect();
        let (page, total) = page_of(items, q(Some(3), Some(4)));
        assert_eq!(page, vec![3, 4, 5, 6]);
        assert_eq!(total, 10);
    }

    #[test]
    fn a_short_last_page_is_not_padded() {
        let items: Vec<u32> = (0..10).collect();
        let (page, total) = page_of(items, q(Some(8), Some(50)));
        assert_eq!(page, vec![8, 9]);
        assert_eq!(total, 10);
    }

    #[test]
    fn an_offset_past_the_end_is_an_empty_page_with_the_real_total() {
        let items: Vec<u32> = (0..10).collect();
        let (page, total) = page_of(items, q(Some(99), None));
        assert!(page.is_empty());
        assert_eq!(total, 10);
    }

    /// Guards the `#[serde(flatten)]` embedding used by the endpoints that
    /// carry filters of their own. `axum::extract::Query` decodes through
    /// `serde_urlencoded`, whose support for flattened structs is the one
    /// thing that would make `?offset=&limit=` parse as absent instead of
    /// erroring — a silent "always page one" regression.
    #[derive(Debug, serde::Deserialize)]
    struct Filtered {
        #[serde(default)]
        r#type: Option<String>,
        #[serde(flatten)]
        page: PageQuery,
    }

    fn parse(query: &str) -> Filtered {
        let uri: axum::http::Uri = format!("http://x/list?{query}").parse().expect("uri");
        axum::extract::Query::<Filtered>::try_from_uri(&uri)
            .expect("the extractor decodes the query")
            .0
    }

    #[test]
    fn a_flattened_page_decodes_out_of_a_query_string() {
        let q = parse("type=issue&offset=20&limit=5");
        assert_eq!(q.r#type.as_deref(), Some("issue"));
        assert_eq!(q.page.offset(), 20);
        assert_eq!(q.page.limit(), 5);
    }

    #[test]
    fn a_query_carrying_only_filters_still_gets_the_default_page() {
        let q = parse("type=issue");
        assert_eq!(q.page.offset(), 0);
        assert_eq!(q.page.limit(), DEFAULT_LIMIT);
    }

    #[test]
    fn an_empty_parameter_reads_as_unset_rather_than_a_400() {
        let q = parse("type=issue&offset=&limit=");
        assert_eq!(q.page.offset(), 0);
        assert_eq!(q.page.limit(), DEFAULT_LIMIT);
    }

    #[test]
    fn a_non_numeric_page_parameter_is_rejected() {
        let uri: axum::http::Uri = "http://x/list?limit=lots".parse().expect("uri");
        assert!(axum::extract::Query::<Filtered>::try_from_uri(&uri).is_err());
    }

    #[test]
    fn an_empty_collection_pages_to_nothing() {
        let (page, total) = page_of(Vec::<u32>::new(), q(None, None));
        assert!(page.is_empty());
        assert_eq!(total, 0);
    }
}
