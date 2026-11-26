//! The Git kit's answer to the core's rollup counts port (ADR-0079 §4): a
//! project's review and pull request signals, as its row in the projects
//! table says them.

use std::collections::HashMap;

use async_trait::async_trait;
use toolkit_security::SecurityContext;

use super::port::{ProjectSignalSource, ProjectSignals};
use super::service::IngestService;
use crate::organizations::port::{LastEvent, PullCounts, RowSignalSource, RowSignals};

/// A project's signals as its row says them: pull requests only when any
/// was ever synced, the last event as the feed words it.
pub fn row_of(s: ProjectSignals) -> RowSignals {
    RowSignals {
        open_findings: s.open_findings,
        open_comments: s.open_comments,
        pulls: s.pulls_known.then_some(PullCounts {
            open: s.pulls.open,
            merged: s.pulls.merged,
            days: s.pulls.days,
        }),
        last_event: s.last_event.map(|e| LastEvent {
            event: e.event,
            subject: e.subject,
            recorded: e.recorded,
        }),
    }
}

#[async_trait]
impl RowSignalSource for IngestService {
    async fn row_signals_in(
        &self,
        ctx: &SecurityContext,
        projects: &[String],
        days: usize,
    ) -> HashMap<String, RowSignals> {
        ProjectSignalSource::project_signals_in(self, ctx, projects, days)
            .await
            .into_iter()
            .map(|(project, s)| (project, row_of(s)))
            .collect()
    }
}
