//! One PostgreSQL for the whole test process.
//!
//! Gears that keep tables test them against the engine the assembly actually
//! runs. Proving SQL on a different engine proves it about an engine we do not
//! ship, and the two places that tried it paid for it: `studio-documents` lost
//! a migration to `ADD COLUMN IF NOT EXISTS` being a Postgres extension, and to
//! a boolean that defaults `FALSE` here and `0` there.
//!
//! The server comes from Testcontainers — one per test process, started on
//! first use and thrown away with it. `cargo test` therefore needs a Docker
//! daemon and nothing else: no compose stack to remember, no environment to
//! export. `STUDIO_TEST_PG_DSN` still overrides it for pointing at a database
//! you already have.
//!
//! An edited migration always re-applies, which a long-lived server cannot
//! promise: its schema-history ledger says the migration already ran, so the
//! change silently does not take and the test either fails against the old
//! schema or, worse, passes against it.
//!
//! # Which of the two to ask for
//!
//! [`shared_dsn`] hands out one database that every caller shares. Suites whose
//! rows are tenant-scoped want this: they take a fresh tenant per test and
//! never see each other.
//!
//! [`fresh_database`] creates a database of its own. Suites that read a whole
//! table — "exactly one row exists, and its ciphertext does not contain the
//! plaintext" — need it, because a shared table makes that assertion about
//! whatever else happened to be running.

use testcontainers::ContainerAsync;
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::postgres::Postgres;
use tokio::sync::OnceCell;
use uuid::Uuid;

static SERVER: OnceCell<Server> = OnceCell::const_new();

struct Server {
    /// DSN of the database the container comes up with.
    dsn: String,
    /// Everything up to the database name, so another one can be addressed on
    /// the same server.
    base: String,
    /// Held, never read: dropping the handle stops PostgreSQL. `None` when
    /// `STUDIO_TEST_PG_DSN` pointed us at a server somebody else owns.
    _container: Option<ContainerAsync<Postgres>>,
}

async fn server() -> &'static Server {
    SERVER
        .get_or_init(|| async {
            let (dsn, container) = match std::env::var("STUDIO_TEST_PG_DSN") {
                Ok(dsn) => (dsn, None),
                Err(_) => {
                    let container = Postgres::default().start().await.expect(
                        "start a PostgreSQL container -- these tests need a Docker daemon, \
                         or set STUDIO_TEST_PG_DSN to a database you already have",
                    );
                    // Ask the container where it is rather than assuming
                    // localhost: when the tests themselves run inside a
                    // container, the published port is on the host, not on
                    // this loopback.
                    let host = container.get_host().await.expect("container host");
                    let port = container
                        .get_host_port_ipv4(5432)
                        .await
                        .expect("published port");
                    (
                        format!("postgres://postgres:postgres@{host}:{port}/postgres"),
                        Some(container),
                    )
                }
            };
            let base = dsn
                .rsplit_once('/')
                .map_or_else(|| dsn.clone(), |(base, _)| base.to_string());
            Server {
                dsn,
                base,
                _container: container,
            }
        })
        .await
}

/// The one database every caller shares. Scope your rows by tenant.
pub async fn shared_dsn() -> &'static str {
    &server().await.dsn
}

/// A database of this test's own, created on the shared server.
///
/// `prefix` only makes the name legible while the container is alive; a uuid
/// keeps it unique. Nothing drops it — the container goes at the end of the
/// process and takes every database with it.
pub async fn fresh_database(prefix: &str) -> String {
    let server = server().await;
    let name = format!("{prefix}_{}", Uuid::new_v4().simple());

    // Raw tokio-postgres rather than the pool: `CREATE DATABASE` cannot run in
    // a transaction, which is the same reason `database_bootstrap` reaches for
    // this client instead of SeaORM.
    let (client, connection) = tokio_postgres::connect(&server.dsn, tokio_postgres::NoTls)
        .await
        .unwrap_or_else(|e| panic!("connect to {} failed: {e}", server.dsn));
    let pump = tokio::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("test PostgreSQL connection failed: {e}");
        }
    });

    // The name is ours and uuid-shaped, so quoting is enough; there is no
    // parameter form for CREATE DATABASE.
    client
        .batch_execute(&format!("CREATE DATABASE \"{name}\""))
        .await
        .unwrap_or_else(|e| panic!("create test database {name}: {e}"));

    drop(client);
    pump.abort();

    format!("{}/{name}", server.base)
}
