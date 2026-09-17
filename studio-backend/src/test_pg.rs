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

use std::sync::OnceLock;

use testcontainers::ContainerAsync;
use testcontainers::core::ImageExt;
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::postgres::Postgres;
use tokio::sync::OnceCell;
use uuid::Uuid;

static SERVER: OnceCell<Server> = OnceCell::const_new();

/// The name of the container this process started, for [`remove_at_exit`].
static CONTAINER_NAME: OnceLock<String> = OnceLock::new();

/// Prefix every container this harness starts carries, so a leftover can be
/// recognised from outside — `scripts/backend-check.sh` sweeps by it.
const NAME_PREFIX: &str = "cf-studio-test-pg";

struct Server {
    /// DSN of the database the container comes up with.
    dsn: String,
    /// Everything up to the database name, so another one can be addressed on
    /// the same server.
    base: String,
    /// Held so the borrow checker keeps the container alive for the process.
    ///
    /// It used to say "dropping the handle stops PostgreSQL", which was an
    /// intention this code could not carry out: the handle lives in a `static`,
    /// and **Rust never drops a `static`**. So `ContainerAsync::drop` — the
    /// only thing that removes the container — never ran, and every `cargo
    /// test` process that touched Postgres left a `postgres:11-alpine` running
    /// for good. Eighteen of them had accumulated on one machine before anybody
    /// noticed, because nothing about a passing test run says it leaked.
    ///
    /// [`remove_at_exit`] is what actually stops it now. `None` when
    /// `STUDIO_TEST_PG_DSN` pointed us at a server somebody else owns — and
    /// then nothing here removes anything, which is the point of pointing at
    /// one.
    _container: Option<ContainerAsync<Postgres>>,
}

/// Remove the container this process started.
///
/// Registered with the C runtime's exit hook, which the test harness reaches
/// (libtest ends in `std::process::exit`), and which is the only place left to
/// do this once the handle is in a `static`.
///
/// Everything about it is deliberately primitive. An exit hook runs after the
/// tokio runtimes are gone, so testcontainers' own async client is not
/// available to it; and the image the tests run in mounts the Docker socket but
/// ships no `docker` CLI (`scripts/backend-check.sh`), so shelling out would
/// silently do nothing. That leaves one synchronous HTTP request written by
/// hand onto the socket, which needs no dependency at all.
///
/// Best effort throughout: a failure here costs a stray container that the
/// sweep in `backend-check.sh` collects, while a panic in an exit hook would
/// turn a green test run red.
#[cfg(unix)]
extern "C" fn remove_at_exit() {
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;

    let Some(name) = CONTAINER_NAME.get() else {
        return;
    };
    let socket = std::env::var("DOCKER_HOST")
        .ok()
        .and_then(|host| host.strip_prefix("unix://").map(str::to_string))
        .unwrap_or_else(|| "/var/run/docker.sock".to_string());
    let Ok(mut stream) = UnixStream::connect(socket) else {
        return;
    };
    let request = format!(
        "DELETE /containers/{name}?force=1&v=1 HTTP/1.1\r\n\
         Host: docker\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return;
    }
    // Read the answer out rather than dropping the socket on an unread reply:
    // the daemon does the removal while we are still connected, and hanging up
    // early is how "force=1" becomes "sometimes".
    let mut answer = Vec::new();
    let _ = stream.read_to_end(&mut answer);
}

/// Windows cannot run these tests at all (no Docker socket to speak of), so
/// there is nothing to clean up and nothing to register.
#[cfg(not(unix))]
extern "C" fn remove_at_exit() {}

async fn server() -> &'static Server {
    SERVER
        .get_or_init(|| async {
            let (dsn, container) = match std::env::var("STUDIO_TEST_PG_DSN") {
                Ok(dsn) => (dsn, None),
                Err(_) => {
                    /*
                     * Named, and named uniquely.
                     *
                     * The name is what lets anything outside this process
                     * recognise the container as ours -- the exit hook below
                     * addresses it by name, and the sweep in
                     * `scripts/backend-check.sh` matches the prefix. The
                     * nanosecond suffix is not decoration: a stale container
                     * from a run that was killed would otherwise collide with a
                     * new process that happened to be given the same pid, and
                     * the collision surfaces as `start()` failing with "name
                     * already in use" -- a test failure with nothing to do with
                     * the test.
                     */
                    let name = format!(
                        "{NAME_PREFIX}-{}-{}",
                        std::process::id(),
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map_or(0, |since| since.subsec_nanos())
                    );
                    let container = Postgres::default()
                        .with_container_name(&name)
                        .start()
                        .await
                        .expect(
                            "start a PostgreSQL container -- these tests need a Docker daemon, \
                             or set STUDIO_TEST_PG_DSN to a database you already have",
                        );
                    // Registered only once there is something to remove, and
                    // only after the container exists: an exit hook that fires
                    // against a name nothing answers to is a wasted connection
                    // on every test run that never needed a database.
                    let _ = CONTAINER_NAME.set(name);
                    // SAFETY: `atexit` takes a plain `extern "C" fn` with no
                    // arguments and no captured state; ours reads one
                    // `OnceLock` and talks to a socket. Called once, because
                    // `get_or_init` runs this block once.
                    unsafe {
                        libc::atexit(remove_at_exit);
                    }
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
