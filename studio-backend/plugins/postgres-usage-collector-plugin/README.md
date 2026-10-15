# postgres-usage-collector-plugin

The storage backend of the platform's `usage-collector` gear, on plain
PostgreSQL. Studio meters what its model calls and IDE sessions use through
`usage-collector` (issue #781), and this is where those records are kept.

## Where it comes from

A copy of `cf-gears-timescaledb-usage-collector-plugin` **0.3.0**
(constructorfabric/gears-rust,
`gears/system/usage-collector/plugins/timescaledb-usage-collector-plugin`,
Apache-2.0). That plugin needs TimescaleDB, and the Studio's shared Postgres
cannot have it yet: it runs PostgreSQL 19 beta for graph-storage, and
TimescaleDB does not support a beta. The plugin's queries are plain SQL, so it
runs on an ordinary table once TimescaleDB is taken out of its setup.

## What differs from the published plugin

Only what TimescaleDB provides. Everything else — the SPI adapter, the stores,
the query translation, the metrics — is the published code.

| | TimescaleDB plugin | This one |
|---|---|---|
| `migrations/0001_init.sql` | `CREATE EXTENSION timescaledb`; `usage_records` made a hypertable | neither: `usage_records` is an ordinary table, same columns, constraints and indexes |
| Retention (`pool::apply_retention_policy`) | a TimescaleDB retention policy drops whole chunks | a `DELETE` of the rows past the window, at start and then daily (`gear.rs`) |
| Gear name, GTS instance | `timescaledb-usage-collector-plugin`, `cf.core._.timescaledb_usage_collector.v1` | `postgres-usage-collector-plugin`, `cf.studio._.postgres_usage_collector.v1` |

The integration tests (`tests/`) are not copied: they start a TimescaleDB
container. The unit tests in `src/` are.

## Retiring it

When the shared Postgres is an ordinary release with TimescaleDB installed
(`shared_preload_libraries = timescaledb`), depend on the published plugin
instead, point its `database_url` at a new database and delete this
directory. What is recorded here then is not carried over: a fresh database is
the published plugin's own schema history.
