//! The Insight kit's half of an organization's metrics board (the core's
//! repository metrics port, ADR-0079 §4): git, CI and task figures for the
//! repositories the scope's projects are made of, through studio-insight's
//! [`RepositoryAnalytics`].

use std::collections::BTreeMap;

use async_trait::async_trait;
use toolkit::client_hub::ClientHub;

use super::port::{
    ActivityBucket, ActivityCell, ActivityQuery, ActivityUnavailable, RepositoryActivity,
    RepositoryAnalytics, ReviewSpread,
};
use crate::organizations::port::{
    MetricsBucket, MetricsSpan, OrgMetricsCellDto, OrgMetricsInsightDto, OrgMetricsMeasureDto,
    OrgMetricsPointDto, OrgMetricsReviewsDto, RepositoryMetrics, RepositoryMetricsSource,
    absent_repository_metrics, unanswered_repository_metrics,
};

inventory::submit! {
    RepositoryMetricsSource {
        gear: "studio-insight",
        source: &InsightBoard,
    }
}

struct InsightBoard;

#[async_trait]
impl RepositoryMetrics for InsightBoard {
    fn repository_key(&self, url: &str) -> Option<String> {
        super::port::repository_key(url)
    }

    async fn board(
        &self,
        hub: &ClientHub,
        repositories: &[String],
        span: &MetricsSpan,
    ) -> OrgMetricsInsightDto {
        let answer = match hub.get::<dyn RepositoryAnalytics>() {
            Ok(analytics) => Some(
                analytics
                    .activity(&ActivityQuery {
                        repositories: repositories.to_vec(),
                        previous_from: span.previous_from,
                        current_from: span.current_from,
                        to: span.to,
                        bucket: match span.bucket {
                            MetricsBucket::Day => ActivityBucket::Day,
                            MetricsBucket::Week => ActivityBucket::Week,
                        },
                    })
                    .await,
            ),
            Err(_) => None,
        };
        insight_dto(answer, repositories.len())
    }
}

// ── Insight's answer, grouped per measure ────────────────────────────────────

/// One measure's cells: the current window, the previous one, and the
/// current one per bucket.
type Grouped<'a> = (
    Option<&'a ActivityCell>,
    Option<&'a ActivityCell>,
    Vec<&'a ActivityCell>,
);

/// Cells grouped as `domain.measure` -> (current, previous, series).
fn measures(cells: &[ActivityCell]) -> BTreeMap<String, Grouped<'_>> {
    let mut out: BTreeMap<String, Grouped<'_>> = BTreeMap::new();
    for c in cells {
        let e = out
            .entry(format!("{}.{}", c.domain, c.measure))
            .or_default();
        match c.bucket.as_str() {
            "cur" => e.0 = Some(c),
            "prev" => e.1 = Some(c),
            _ => e.2.push(c),
        }
    }
    for e in out.values_mut() {
        e.2.sort_by(|a, b| a.bucket.cmp(&b.bucket));
    }
    out
}

fn cell(c: &ActivityCell) -> OrgMetricsCellDto {
    OrgMetricsCellDto {
        total: c.total,
        median: c.median,
        count: c.n,
        people: c.people,
    }
}

fn review(r: &ReviewSpread) -> OrgMetricsReviewsDto {
    OrgMetricsReviewsDto {
        period: r.period.clone(),
        reviewers: r.reviewers,
        reviews: r.reviews,
        half: r.half,
        top: r.top.clone(),
    }
}

/// Insight's part of the board, from what it answered.
fn insight_dto(
    answer: Option<Result<RepositoryActivity, ActivityUnavailable>>,
    repositories: usize,
) -> OrgMetricsInsightDto {
    let state = unanswered_repository_metrics;
    match answer {
        None => absent_repository_metrics(),
        Some(Err(ActivityUnavailable::Unconfigured)) => state(
            "unconfigured",
            Some("Insight is not configured here: STUDIO_INSIGHT_API_KEY is not set".into()),
        ),
        Some(Err(ActivityUnavailable::Unreachable(d))) => state("unreachable", Some(d)),
        Some(Err(ActivityUnavailable::Failed(d))) => state("failed", Some(d)),
        Some(Ok(_)) if repositories == 0 => state(
            "no_repositories",
            Some("no project in scope names a repository".into()),
        ),
        Some(Ok(a)) => OrgMetricsInsightDto {
            state: "ok".into(),
            detail: None,
            truncated: a.truncated,
            measures: measures(&a.cells)
                .into_iter()
                .map(|(key, (cur, prev, series))| OrgMetricsMeasureDto {
                    key,
                    current: cur.map(cell),
                    previous: prev.map(cell),
                    series: series
                        .into_iter()
                        .map(|c| OrgMetricsPointDto {
                            bucket: c.bucket.clone(),
                            total: c.total,
                            median: c.median,
                            count: c.n,
                            people: c.people,
                        })
                        .collect(),
                })
                .collect(),
            reviews: a.reviews.iter().map(review).collect(),
            ai_rows: a.ai_rows,
        },
    }
}

#[cfg(test)]
#[path = "metrics_board_tests.rs"]
mod tests;
