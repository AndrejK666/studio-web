//! Bring an outbox created by toolkit-db before 0.16 up to the schema 0.16
//! expects, before the migrations run.
//!
//! toolkit-db 0.16 added a `trace` column to `<prefix>_outbox_body` and a
//! `<prefix>_outbox_trace` table -- by editing its released migration
//! (`m001_create_toolkit_outbox_schema`) in place instead of adding a new one
//! (constructorfabric/gears-rust#5044). A database whose journal already
//! records m001 never runs the new DDL, and every enqueue then fails with
//! `column "trace" … does not exist` -- the task queue (`studio_tasks`) and
//! mini-chat's outbox alike.
//!
//! The repair is two steps per outbox, and both are safe to repeat:
//!
//! * add the column (`ADD COLUMN IF NOT EXISTS`), because m001's
//!   `CREATE TABLE IF NOT EXISTS` for the body cannot add it to a table that
//!   exists;
//! * when the trace table is missing, forget m001 in the gear's journal, so
//!   the migration runs again. Every statement in it is `IF NOT EXISTS`, so
//!   running it over the existing tables only creates what is missing.
//!
//! The outboxes are found by their table names, not by a list of gears: a
//! gear this backend does not know by name (mini-chat's outbox lives in its
//! own crate) is repaired the same way.
//!
//! Delete this module once no environment has a pre-0.16 outbox left.

use anyhow::{Context, Result};
use tokio_postgres::Client;

/// The journal row toolkit-db records for the outbox migration, with any
/// per-outbox suffix (`…__mini_chat_outbox`).
const OUTBOX_MIGRATION: &str = "m001_create_toolkit_outbox_schema";

/// What one database needed.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Repair {
    /// Body tables the `trace` column was added to.
    pub columns_added: Vec<String>,
    /// Journal rows forgotten so the outbox migration runs again.
    pub migrations_reset: u64,
}

impl Repair {
    pub fn is_empty(&self) -> bool {
        self.columns_added.is_empty() && self.migrations_reset == 0
    }
}

/// Repair every outbox in the database `client` is connected to.
pub async fn repair(client: &Client) -> Result<Repair> {
    let mut out = Repair::default();

    let bodies: Vec<(String, bool)> = client
        .query(
            "SELECT t.table_name::text,
                    EXISTS (SELECT 1 FROM information_schema.columns c
                            WHERE c.table_schema = t.table_schema
                              AND c.table_name = t.table_name
                              AND c.column_name = 'trace')
             FROM information_schema.tables t
             WHERE t.table_schema = current_schema()
               AND t.table_type = 'BASE TABLE'
               AND t.table_name LIKE '%\\_outbox\\_body' ESCAPE '\\'",
            &[],
        )
        .await
        .context("list outbox body tables")?
        .into_iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();

    let mut trace_missing = false;
    for (body, has_trace) in &bodies {
        if !has_trace {
            client
                .batch_execute(&format!(
                    "ALTER TABLE {} ADD COLUMN IF NOT EXISTS trace VARCHAR(256) NULL",
                    quote(body)
                ))
                .await
                .with_context(|| format!("add the trace column to {body}"))?;
            out.columns_added.push(body.clone());
        }
        let prefix = body.strip_suffix("_body").unwrap_or(body);
        let trace_table = format!("{prefix}_trace");
        let exists = client
            .query_opt(
                "SELECT 1 FROM information_schema.tables
                 WHERE table_schema = current_schema() AND table_name = $1",
                &[&trace_table],
            )
            .await
            .with_context(|| format!("look for {trace_table}"))?
            .is_some();
        trace_missing |= !exists;
    }

    if trace_missing {
        let journals: Vec<String> = client
            .query(
                "SELECT table_name::text FROM information_schema.tables
                 WHERE table_schema = current_schema()
                   AND table_name LIKE 'toolkit\\_migrations\\_\\_%' ESCAPE '\\'",
                &[],
            )
            .await
            .context("list migration journals")?
            .into_iter()
            .map(|r| r.get(0))
            .collect();
        let pattern = format!("{OUTBOX_MIGRATION}%");
        for journal in journals {
            out.migrations_reset += client
                .execute(
                    &format!("DELETE FROM {} WHERE version LIKE $1", quote(&journal)),
                    &[&pattern],
                )
                .await
                .with_context(|| format!("forget the outbox migration in {journal}"))?;
        }
    }
    Ok(out)
}

/// A Postgres identifier, quoted. Names come from `information_schema`, so
/// this is belt and braces rather than the only guard.
fn quote(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

#[cfg(test)]
#[path = "outbox_repair_tests.rs"]
mod tests;
