//! The Research connector's calls to Constructor Research's own public API
//! (ADR-0049 §6), with the access token of the member whose connection it
//! is. Studio calls the routes Research's web client calls -- the ones an
//! `rk-` access key may call too -- and nothing else.
//!
//! The connection's address is the account API, `https://<stand>/api/
//! platform-account/v1`. Two more services sit beside it on the same origin
//! and take the same token: the desk's files over WebDAV
//! (`/api/platform-storage`) and the log streams (`/api/platform-keeper`).
//!
//! Research answers JSON. An error is `{"detail": {"msg", "error_code"}}`
//! (status 421 for most refusals), or FastAPI's `{"detail": [{"msg", "loc"}]}`
//! for a body it does not accept; the message is what the person sees.
//! Research has no upload, no single "put the application" call and no event
//! stream: a build is a desk's files and an image per Dockerfile, a deploy is
//! one call per service, and both are polled.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context as _, anyhow, bail};
use futures_util::StreamExt as _;
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use sha2::Digest as _;

/// A fresh access token, when the one in hand is no longer accepted. The
/// connection's refresh token is traded for it (ADR-0049 §1): a build can
/// outlast an access token's hour.
pub type Renew = Arc<dyn Fn() -> BoxFuture<'static, anyhow::Result<String>> + Send + Sync>;

/// Where a long call says what it is doing.
pub type Progress<'a> = &'a (dyn Fn(String) -> BoxFuture<'a, ()> + Send + Sync);

/// How far a desk build is, counted: what a progress bar is drawn from
/// (the text lines of [`Progress`] stay the log under it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Measured {
    /// The desk is starting, or busy with another build: no total is known.
    Desk,
    /// The prepared tree going up to the desk: files and bytes, done of total.
    Upload {
        files_done: u64,
        files_total: u64,
        bytes_done: u64,
        bytes_total: u64,
    },
    /// The images Research builds, done of total.
    Images { done: u64, total: u64 },
}

/// Where a long call says how far it is, counted.
pub type Measure<'a> = &'a (dyn Fn(Measured) -> BoxFuture<'a, ()> + Send + Sync);

/// A [`Measure`] nobody reads.
#[cfg(test)]
pub fn unmeasured(_: Measured) -> BoxFuture<'static, ()> {
    Box::pin(async {})
}

/// Whether the person stopped the run.
pub type Cancelled<'a> = &'a (dyn Fn() -> bool + Send + Sync);

/// What a member's Research access key starts with, and the header it is
/// sent in (`X-Research-AccessKey: Bearer rk-…`).
pub const ACCESS_KEY_PREFIX: &str = "rk-";
const ACCESS_KEY_HEADER: &str = "X-Research-AccessKey";

pub const SIGN_IN_AGAIN: &str =
    "Constructor Research did not accept the sign-in: sign in to it again";

/// The desk Studio builds in when the project may have one of its own.
pub const STUDIO_DESK: &str = "studio";

/// Where in a desk's project folder Studio puts what it builds. It is kept
/// out of the project's git (`.git/info/exclude`) and removed after a build.
pub const BUILD_FOLDER: &str = "studio-build";

/// How a WebDAV call to a desk's files is asked again, by Research's rules
/// for uploading to a desk (`studio-research-webdav-upload.md`, 2026-11):
///
/// - a 502 or 503 means the desk's file service is not running, which no
///   blind retry fixes: the filesystem is started
///   (`POST /desks/{id}/filesystem`), Studio waits up to `start_for` for
///   `filesystem.status: running`, `poll` apart, and asks again (twice at
///   most);
/// - a 504 or a request that does not reach Research is asked again `first`
///   apart, doubling up to `cap`, until `for_` has passed since the first try.
///
/// Every DAV call Studio makes is idempotent (MKCOL, PUT of the same bytes
/// or of the same part at the same place, GET, DELETE).
#[derive(Debug, Clone, Copy)]
pub struct DavRetry {
    pub for_: Duration,
    pub first: Duration,
    pub cap: Duration,
    pub start_for: Duration,
    pub poll: Duration,
}

impl DavRetry {
    pub const RESEARCH: DavRetry = DavRetry {
        for_: Duration::from_secs(3 * 60),
        first: Duration::from_secs(1),
        cap: Duration::from_secs(15),
        start_for: Duration::from_secs(30 * 60),
        poll: Duration::from_secs(5),
    };
}

/// How many times one call starts the desk's filesystem before it gives up.
const FILESYSTEM_RESTARTS: u32 = 2;

/// The desk's file service is not running (Research's rules, §2 and §9).
fn file_service_down(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 502 | 503)
}

/// How many files are written to a desk at once.
const UPLOAD_CONCURRENCY: usize = 8;

/// A file bigger than this goes up in parts of exactly this size, the last
/// one shorter (Research's rules §5: an S3-backed desk refuses any other part
/// size with `400 Invalid chunk size`).
pub const PART_SIZE: usize = 5_242_880;

/// No request body may be bigger than this: nginx answers 413 before the
/// desk (8 MB, Research's rules §1). Parts stay well under it.
pub const MAX_BODY: usize = 8 * 1024 * 1024;

/// How many parts of one file go up at once.
const PART_CONCURRENCY: usize = 4;

/// How many times one part is sent before the file's upload fails.
const PART_TRIES: u32 = 3;

/// The file in a desk's `BUILD_FOLDER` that says which Studio build is using
/// the desk now: one build at a time per desk, the next one waits.
const DESK_LOCK: &str = "studio-build/.studio-desk-lock";

/// A lock not written again for this long belongs to a build that is gone.
const DESK_LOCK_STALE: Duration = Duration::from_secs(20 * 60);

/// How often a build that holds the desk writes its lock again.
const DESK_LOCK_REFRESH: Duration = Duration::from_secs(4 * 60);

/// How long a build waits for the desk before it gives up.
const DESK_WAIT_FOR: Duration = Duration::from_secs(3 * 60 * 60);

/// Research's own public API, as one member reaches it.
pub struct ResearchApi {
    http: reqwest::Client,
    /// `…/api/platform-account/v1`.
    account: String,
    /// The origin (and any prefix) the three services sit under.
    base: String,
    token: Mutex<String>,
    renew: Option<Renew>,
    dav_retry: DavRetry,
    net_retry: NetRetry,
}

/// How a call that did not reach Research is asked again: `tries` more
/// times, `first` apart and doubling.
#[derive(Debug, Clone, Copy)]
pub struct NetRetry {
    pub tries: u32,
    pub first: Duration,
}

impl NetRetry {
    pub const RESEARCH: NetRetry = NetRetry {
        tries: 3,
        first: Duration::from_secs(2),
    };
}

/// What a call that never reached Research says, whatever the network did:
/// the cause a person reads is `RESEARCH_UNAVAILABLE` (`failure.rs` knows
/// this sentence).
pub const NOT_REACHED: &str = "Constructor Research could not be reached";

fn unreachable(what: &str, url: &str, e: &reqwest::Error) -> anyhow::Error {
    let host = reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
        .unwrap_or_else(|| url.to_owned());
    anyhow!("{NOT_REACHED} at {host} ({what}), asked again and again; try again in a while: {e}")
}

/// Whether sending `method` twice changes nothing more than sending it once.
fn idempotent(method: &reqwest::Method) -> bool {
    !matches!(*method, reqwest::Method::POST | reqwest::Method::PATCH)
}

/// A Research project the member owns or collaborates on.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct Project {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// The project's "Deployment" setting: off, Research refuses to build
    /// images there ("Deployment is not enabled for this project"). `None`
    /// where Research did not say.
    #[serde(default)]
    pub deployment_enabled: Option<bool>,
}

/// A hardware configuration a project's services may run on.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Hardware {
    pub id: String,
    pub name: String,
    /// Offered to a trial user: Research ends what runs on it by its own rules.
    pub trial: bool,
    pub cpu_count: f64,
    pub ram_gb: u32,
    pub gpu: bool,
}

#[derive(Deserialize)]
struct RawHardware {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    available_for_trial: bool,
    #[serde(default)]
    cpu_count: f64,
    #[serde(default)]
    ram_gb: u32,
    #[serde(default)]
    gpu: Option<serde_json::Value>,
    #[serde(default)]
    removed: bool,
}

/// The smallest configuration without a GPU (or, with none, the smallest):
/// what a service runs on when the environment names no hardware.
pub fn smallest(hardware: &[Hardware]) -> Option<&Hardware> {
    hardware.iter().min_by(|a, b| {
        (a.gpu, a.ram_gb)
            .cmp(&(b.gpu, b.ram_gb))
            .then(a.cpu_count.total_cmp(&b.cpu_count))
    })
}

/// `POST /access-keys`: a member's key and its id.
#[derive(Clone, Deserialize)]
pub struct AccessKey {
    pub id: String,
    pub key: String,
}

impl std::fmt::Debug for AccessKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AccessKey")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

/// `GET /auth/session`: the member the token is.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Me {
    pub id: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub first_name: Option<String>,
    #[serde(default)]
    pub last_name: Option<String>,
}

impl Me {
    pub fn display_name(&self) -> Option<String> {
        let name = [&self.first_name, &self.last_name]
            .into_iter()
            .flatten()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if name.is_empty() {
            self.email.clone()
        } else {
            Some(name)
        }
    }
}

/// A desk: a work disk and pod for the project's files.
#[derive(Debug, Clone, Deserialize)]
pub struct Desk {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub filesystem: Filesystem,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Filesystem {
    /// `not_started` | `starting` | `running` | `stopping`.
    #[serde(default)]
    pub status: String,
}

/// An image built from a Dockerfile in a desk.
#[derive(Debug, Clone, Deserialize)]
pub struct Image {
    pub id: String,
    /// `not_started` | `snapshot_creation` | `in_progress` | `done` | `error`.
    #[serde(default)]
    pub build_status: String,
}

/// An application: a group of services, a namespace of its own.
#[derive(Debug, Clone, Deserialize)]
pub struct Application {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub services: Vec<Service>,
}

impl Application {
    /// Where the product opens: each service's public link.
    pub fn links(&self) -> Vec<String> {
        self.services
            .iter()
            .filter_map(|s| s.link.clone())
            .collect()
    }
}

/// One service: one container.
#[derive(Debug, Clone, Deserialize)]
pub struct Service {
    pub id: String,
    pub name: String,
    /// `starting` | `running` | `stopping` | `stopped` | `failed`.
    #[serde(default)]
    pub status: String,
    /// The public address of its first port exposed to the internet.
    #[serde(default)]
    pub link: Option<String>,
}

/// The body of `POST /applications/{a}/services` and of its `PATCH`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ServiceBody {
    pub name: String,
    pub image_id: String,
    pub hardware_configuration_id: String,
    pub volumes: Vec<VolumeBody>,
    pub ports: Vec<PortBody>,
    pub environment_variables: Vec<EnvBody>,
}

/// A volume; a `PATCH` keeps the data of the one with the same name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VolumeBody {
    pub name: String,
    pub mount_point: String,
    pub size_gb: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PortBody {
    pub number: u16,
    pub expose_to_internet: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EnvBody {
    pub name: String,
    pub value: String,
}

/// One image a build asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageBuild {
    /// What the build's record names it by (the application).
    pub key: String,
    /// Research's name for it: ASCII letters, digits and hyphens, at most 30.
    pub name: String,
    /// The Dockerfile, relative to the uploaded folder. Research builds with
    /// the Dockerfile's own folder as the context.
    pub dockerfile: String,
}

/// An image a build made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Built {
    pub key: String,
    pub name: String,
    pub id: String,
}

/// Where a desk build has got to: what one attempt of the build's run
/// hands the next, so a build longer than the run queue's lease goes on
/// where it was instead of starting over (and nothing is uploaded or built
/// twice).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeskBuild {
    /// The desk's id, once found.
    #[serde(default)]
    pub desk: Option<String>,
    /// Whether Studio started the desk, and so stops it at the end.
    #[serde(default)]
    pub started_desk: bool,
    /// When the build began waiting for the desk (Unix seconds).
    #[serde(default)]
    pub waiting_since: Option<u64>,
    /// Whether every image is asked for: the tree is no longer needed.
    #[serde(default)]
    pub submitted: bool,
    /// Each image: building, built, or reused from an earlier build.
    #[serde(default)]
    pub images: Vec<Building>,
    /// When the image builds must have ended (Unix seconds).
    #[serde(default)]
    pub build_until: Option<u64>,
}

impl DeskBuild {
    /// A build some of whose images an earlier build made already: those
    /// are not built again.
    pub fn reusing(reused: Vec<Built>) -> Self {
        Self {
            images: reused
                .into_iter()
                .map(|b| Building {
                    key: b.key,
                    name: b.name,
                    id: b.id,
                    dockerfile: String::new(),
                    first_name: None,
                    erred: false,
                    done: true,
                    reused: true,
                })
                .collect(),
            ..Self::default()
        }
    }
}

/// One image of a [`DeskBuild`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Building {
    pub key: String,
    /// The name Research builds it under now (`…-r2` once built again).
    pub name: String,
    /// Research's id of the image.
    pub id: String,
    /// The Dockerfile, relative to the uploaded folder.
    pub dockerfile: String,
    /// The name it failed under first, once it was built again.
    #[serde(default)]
    pub first_name: Option<String>,
    /// Research said `error` once for this id.
    #[serde(default)]
    pub erred: bool,
    #[serde(default)]
    pub done: bool,
    /// Made by an earlier build: not uploaded nor built by this one.
    #[serde(default)]
    pub reused: bool,
}

/// What one attempt at a desk build came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Followed {
    /// Every image built.
    Built(Vec<Built>),
    /// Not yet: the attempt is over (or the run was stopped), and this is
    /// where the next one goes on from.
    Later(DeskBuild),
}

/// When one attempt hands a desk build over to the next.
#[derive(Debug, Clone, Copy)]
pub struct HandOver {
    /// Past this the tree is not uploaded: waiting for the desk is handed
    /// over instead, so an upload is never cut short by the lease.
    pub upload_by: tokio::time::Instant,
    /// Past this, following the image builds is handed over.
    pub follow_until: tokio::time::Instant,
}

impl HandOver {
    /// An attempt that is never over: the whole build in one call.
    #[cfg(test)]
    pub fn never() -> Self {
        let far = tokio::time::Instant::now() + Duration::from_secs(30 * 24 * 60 * 60);
        Self {
            upload_by: far,
            follow_until: far,
        }
    }
}

/// Where a deploy's services have got to: what one attempt of the deploy's
/// run hands the next, so a slow start outlasts the lease without the
/// services being put again.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppDeploy {
    /// The application's Research id, once its services are put.
    #[serde(default)]
    pub application: Option<String>,
    /// Each service put, `(name, Research id)`.
    #[serde(default)]
    pub services: Vec<(String, String)>,
    /// When every service must run (Unix seconds).
    #[serde(default)]
    pub start_until: Option<u64>,
}

/// Where a desk build hands what the next attempt needs, each time it
/// changes.
pub type Checkpoint<'a> = &'a (dyn Fn(&DeskBuild) -> BoxFuture<'a, ()> + Send + Sync);

/// Seconds since the Unix epoch: a deadline that outlives one process.
pub fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// How often Research is asked, and for how long.
#[derive(Debug, Clone, Copy)]
pub struct Pace {
    pub poll: Duration,
    /// A desk's start: about half a minute when Research is quiet; Research
    /// DEV has kept a trial desk `starting` for over ten minutes (2026-11-23).
    pub desk_for: Duration,
    /// An image build: minutes for a small one, 20-40 for a large one.
    pub build_for: Duration,
    /// Every service running.
    pub start_for: Duration,
    /// Between an upload and the builds: a build started at once does not
    /// see the files yet.
    pub settle: Duration,
    /// Every public link answering, after the services run; zero skips it.
    pub ready_for: Duration,
}

impl Pace {
    pub const RESEARCH: Pace = Pace {
        poll: Duration::from_secs(10),
        desk_for: Duration::from_secs(30 * 60),
        build_for: Duration::from_secs(90 * 60),
        start_for: Duration::from_secs(15 * 60),
        settle: Duration::from_secs(30),
        ready_for: Duration::from_secs(60),
    };
}

#[derive(Deserialize)]
struct Results<T> {
    results: Vec<T>,
}

/// A path segment, percent-escaped but for RFC 3986's unreserved characters.
fn seg(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// A relative path, each segment escaped.
fn rel_path(path: &str) -> String {
    path.split('/')
        .filter(|s| !s.is_empty())
        .map(seg)
        .collect::<Vec<_>>()
        .join("/")
}

/// The account API's root and the base the other two services sit under.
/// `…/api/platform-account` gains its `/v1`; an address of another shape
/// (a test's) keeps its origin as the base.
fn roots(api_url: &str) -> (String, String) {
    let t = api_url.trim().trim_end_matches('/');
    let account = if t.ends_with("/api/platform-account") {
        format!("{t}/v1")
    } else {
        t.to_owned()
    };
    let base = match account.strip_suffix("/api/platform-account/v1") {
        Some(base) => base.to_owned(),
        None => {
            let after = account.find("://").map(|i| i + 3).unwrap_or(0);
            let end = account[after..]
                .find('/')
                .map(|i| after + i)
                .unwrap_or(account.len());
            account[..end].to_owned()
        }
    };
    (account, base)
}

/// What Research said, in words.
fn problem(status: reqwest::StatusCode, body: &str) -> String {
    let json: Option<serde_json::Value> = serde_json::from_str(body).ok();
    let said = json.as_ref().and_then(|v| {
        let detail = v.get("detail");
        let text = |v: &serde_json::Value| v.as_str().map(str::to_owned);
        detail
            .and_then(|d| d.get("msg"))
            .and_then(text)
            .map(|msg| {
                match detail
                    .and_then(|d| d.get("info"))
                    .and_then(|i| i.get("details"))
                    .and_then(text)
                {
                    Some(details) => format!("{msg}: {details}"),
                    None => msg,
                }
            })
            .or_else(|| detail.and_then(text))
            .or_else(|| {
                let items = detail?.as_array()?;
                let msgs: Vec<String> = items
                    .iter()
                    .filter_map(|i| {
                        let msg = i.get("msg")?.as_str()?;
                        let at = i
                            .get("loc")
                            .and_then(|l| l.as_array())
                            .map(|l| {
                                l.iter()
                                    .filter_map(|p| match p {
                                        serde_json::Value::String(s) => Some(s.clone()),
                                        serde_json::Value::Number(n) => Some(n.to_string()),
                                        _ => None,
                                    })
                                    .collect::<Vec<_>>()
                                    .join(".")
                            })
                            .unwrap_or_default();
                        Some(if at.is_empty() {
                            msg.to_owned()
                        } else {
                            format!("{at}: {msg}")
                        })
                    })
                    .collect();
                (!msgs.is_empty()).then(|| msgs.join("; "))
            })
            .or_else(|| v.get("message").and_then(text))
            .or_else(|| v.get("msg").and_then(text))
    });
    said.unwrap_or_else(|| {
        // Not Research's own JSON: a gateway's or a proxy's page. Its words,
        // short and without markup, say more than the status alone.
        let plain = plain_text(body);
        if plain.is_empty() {
            status.to_string()
        } else {
            format!("{status}: {plain}")
        }
    })
}

/// `body` without markup, its whitespace folded, at most 200 characters.
fn plain_text(body: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in body.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    let folded = out.split_whitespace().collect::<Vec<_>>().join(" ");
    match folded.char_indices().nth(200) {
        Some((at, _)) => format!("{}…", &folded[..at]),
        None => folded,
    }
}

enum Body<'b> {
    Empty,
    Json(&'b serde_json::Value),
    Bytes(&'b [u8]),
}

impl<'b> Body<'b> {
    /// The same body, for asking again.
    fn again(&self) -> Body<'b> {
        match self {
            Body::Empty => Body::Empty,
            Body::Json(v) => Body::Json(v),
            Body::Bytes(b) => Body::Bytes(b),
        }
    }
}

impl ResearchApi {
    pub fn new(http: reqwest::Client, api_url: &str, token: String) -> Self {
        let (account, base) = roots(api_url);
        Self {
            http,
            account,
            base,
            token: Mutex::new(token),
            renew: None,
            dav_retry: DavRetry::RESEARCH,
            net_retry: NetRetry::RESEARCH,
        }
    }

    /// Ask WebDAV calls again by `retry` (tests make it fast).
    #[cfg(test)]
    pub fn with_dav_retry(mut self, retry: DavRetry) -> Self {
        self.dav_retry = retry;
        self
    }

    #[cfg(test)]
    pub fn with_net_retry(mut self, retry: NetRetry) -> Self {
        self.net_retry = retry;
        self
    }

    /// A WebDAV call to `desk`'s files, by [`DavRetry`]: on 502/503 the
    /// desk's filesystem is started and the call asked again; on 504 or a
    /// request that does not reach Research it is asked again with backoff.
    /// The last answer, or the last error, once that is over.
    async fn send_dav(
        &self,
        desk: &str,
        method: reqwest::Method,
        url: &str,
        body: Body<'_>,
        headers: &[(&'static str, String)],
        what: &str,
    ) -> anyhow::Result<reqwest::Response> {
        let started = tokio::time::Instant::now();
        let mut wait = self.dav_retry.first;
        let mut restarts = 0;
        loop {
            let tried = self
                .send_with(method.clone(), url, body.again(), headers, what)
                .await;
            if let Ok(res) = &tried
                && file_service_down(res.status())
            {
                if restarts >= FILESYSTEM_RESTARTS {
                    return tried;
                }
                restarts += 1;
                self.start_filesystem(desk).await?;
                continue;
            }
            let again = match &tried {
                Ok(res) => res.status() == reqwest::StatusCode::GATEWAY_TIMEOUT,
                Err(e) => !format!("{e:#}").contains(SIGN_IN_AGAIN),
            };
            if !again || started.elapsed() + wait > self.dav_retry.for_ {
                return tried;
            }
            tokio::time::sleep(wait).await;
            wait = (wait * 2).min(self.dav_retry.cap);
        }
    }

    /// Start `desk`'s filesystem and wait until Research says it runs.
    async fn start_filesystem(&self, desk: &str) -> anyhow::Result<()> {
        let until = tokio::time::Instant::now() + self.dav_retry.start_for;
        let mut status: String;
        loop {
            match self.desk(desk).await {
                Ok(d) if d.filesystem.status == "running" => return Ok(()),
                Ok(d) => {
                    if !matches!(d.filesystem.status.as_str(), "starting" | "pending") {
                        self.start_desk(desk).await?;
                    }
                    status = d.filesystem.status;
                }
                Err(e) => status = format!("unreadable: {e:#}"),
            }
            if tokio::time::Instant::now() >= until {
                bail!(
                    "the desk's file service did not start within {} minutes after it \
                     answered 502/503 (Research reports it {})",
                    self.dav_retry.start_for.as_secs().div_ceil(60),
                    if status.is_empty() {
                        "without a status"
                    } else {
                        status.as_str()
                    }
                );
            }
            tokio::time::sleep(self.dav_retry.poll).await;
        }
    }

    /// Renew the access token with `renew` when Research no longer accepts it.
    pub fn renewing(mut self, renew: Renew) -> Self {
        self.renew = Some(renew);
        self
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.account)
    }

    fn dav(&self, desk: &str, path: &str) -> String {
        format!(
            "{}/api/platform-storage/desks/{}/dav/project/{}",
            self.base,
            seg(desk),
            rel_path(path)
        )
    }

    fn token(&self) -> String {
        self.token.lock().map(|t| t.clone()).unwrap_or_default()
    }

    /// `req` made as the member: an `rk-` access key goes in Research's own
    /// header, any other token (a connection signed in before the keys, or
    /// the sign-in's own IDP token) as a bearer.
    fn authorized(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let token = self.token();
        if token.starts_with(ACCESS_KEY_PREFIX) {
            req.header(ACCESS_KEY_HEADER, format!("Bearer {token}"))
        } else {
            req.bearer_auth(token)
        }
    }

    /// The answer, once more with a renewed token if the first was refused.
    async fn send(
        &self,
        method: reqwest::Method,
        url: &str,
        body: Body<'_>,
        what: &str,
    ) -> anyhow::Result<reqwest::Response> {
        self.send_with(method, url, body, &[], what).await
    }

    /// [`Self::send`] with extra headers (a part's `Content-Range`, its
    /// `X-CheckSum`).
    async fn send_with(
        &self,
        method: reqwest::Method,
        url: &str,
        body: Body<'_>,
        headers: &[(&'static str, String)],
        what: &str,
    ) -> anyhow::Result<reqwest::Response> {
        let mut renewed = false;
        let mut tries = 0u32;
        loop {
            let mut req = self.authorized(self.http.request(method.clone(), url));
            for (name, value) in headers {
                req = req.header(*name, value);
            }
            req = match &body {
                Body::Empty => req,
                Body::Json(v) => req.json(v),
                Body::Bytes(b) => req.body(b.to_vec()),
            };
            let res = match req.send().await {
                Ok(res) => res,
                // The network between Studio and Research blinked: ask again
                // a few times. A request that never got through (a refused or
                // failed connection) is safe to send again whatever it does;
                // one that may have got through only when sending it twice
                // changes nothing (not a POST that starts an image build).
                Err(e)
                    if tries < self.net_retry.tries && (e.is_connect() || idempotent(&method)) =>
                {
                    tries += 1;
                    tracing::warn!(error = %e, what, try_no = tries, "research: not reached, asking again");
                    tokio::time::sleep(self.net_retry.first * 2u32.pow(tries - 1)).await;
                    continue;
                }
                Err(e) => return Err(unreachable(what, url, &e)),
            };
            if res.status() != reqwest::StatusCode::UNAUTHORIZED {
                return Ok(res);
            }
            match (&self.renew, renewed) {
                (Some(renew), false) => {
                    let fresh = renew()
                        .await
                        .map_err(|e| anyhow!("{SIGN_IN_AGAIN} ({e:#})"))?;
                    if let Ok(mut t) = self.token.lock() {
                        *t = fresh;
                    }
                    renewed = true;
                }
                _ => bail!(SIGN_IN_AGAIN),
            }
        }
    }

    /// Research's own words for a refusal.
    async fn refused(res: reqwest::Response, what: &str) -> anyhow::Error {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        anyhow!(
            "Constructor Research refused {what}: {}",
            problem(status, &body)
        )
    }

    async fn call<T: serde::de::DeserializeOwned>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Body<'_>,
        what: &str,
    ) -> anyhow::Result<T> {
        let res = self.send(method, &self.url(path), body, what).await?;
        if !res.status().is_success() {
            return Err(Self::refused(res, what).await);
        }
        res.json().await.map_err(|e| {
            anyhow!("Constructor Research's answer to {what} is not what Studio expects: {e}")
        })
    }

    /// A call whose answer is not read (`204`, or a body Studio needs not).
    async fn act(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Body<'_>,
        what: &str,
    ) -> anyhow::Result<()> {
        let res = self.send(method, &self.url(path), body, what).await?;
        if !res.status().is_success() {
            return Err(Self::refused(res, what).await);
        }
        Ok(())
    }

    fn json<T: Serialize>(v: &T) -> anyhow::Result<serde_json::Value> {
        serde_json::to_value(v).context("a request body Studio could not write")
    }

    /* ── who, where, on what ── */

    pub async fn me(&self) -> anyhow::Result<Me> {
        /// The session carries the member under `user`; the bare shape is
        /// accepted too.
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Session {
            Of { user: Me },
            Bare(Me),
        }
        let session: Session = self
            .call(
                reqwest::Method::GET,
                "/auth/session",
                Body::Empty,
                "who is signed in",
            )
            .await?;
        Ok(match session {
            Session::Of { user } | Session::Bare(user) => user,
        })
    }

    /// A new access key of the member's, made with the IDP token of a
    /// sign-in (a key cannot make keys). Research shows the key only in this
    /// answer.
    pub async fn create_access_key(
        &self,
        name: &str,
        expires_at: &str,
    ) -> anyhow::Result<AccessKey> {
        let url = format!("{}/access-keys", self.keys_root());
        let body = serde_json::json!({ "name": name, "expires_at": expires_at });
        let what = "making an access key";
        let res = self
            .send(reqwest::Method::POST, &url, Body::Json(&body), what)
            .await?;
        if !res.status().is_success() {
            return Err(Self::refused(res, what).await);
        }
        let key: AccessKey = res.json().await.map_err(|e| {
            anyhow!("Constructor Research's answer to {what} is not what Studio expects: {e}")
        })?;
        if !key.key.starts_with(ACCESS_KEY_PREFIX) {
            bail!("Constructor Research made no access key");
        }
        Ok(key)
    }

    /// `/access-keys` sits on the account API's root, not under `/v1`.
    fn keys_root(&self) -> &str {
        self.account.strip_suffix("/v1").unwrap_or(&self.account)
    }

    /// Turn on the project's deployments, off in a new project, before its
    /// applications are changed: Research's UI shows a project's applications
    /// only with them on.
    pub async fn enable_deployment(&self, project: &str) -> anyhow::Result<()> {
        #[derive(Deserialize)]
        struct Flag {
            #[serde(default)]
            deployment_enabled: Option<bool>,
        }
        let path = format!("/projects/{}", seg(project));
        let flag: Flag = self
            .call(reqwest::Method::GET, &path, Body::Empty, "the project")
            .await?;
        if flag.deployment_enabled != Some(false) {
            return Ok(());
        }
        self.act(
            reqwest::Method::PATCH,
            &path,
            Body::Json(&serde_json::json!({ "deployment_enabled": true })),
            "turning on the project's deployments",
        )
        .await
    }

    /// The caller's projects, each with whether its Deployment is on: read
    /// from the project itself where the list does not say.
    pub async fn projects(&self) -> anyhow::Result<Vec<Project>> {
        let mut projects = self
            .call::<Results<Project>>(
                reqwest::Method::GET,
                "/projects",
                Body::Empty,
                "the projects",
            )
            .await?
            .results;
        // Owned paths, then boxed asks: a borrowing iterator chain here makes
        // the handlers' futures fail the `Send` bound for every lifetime.
        let missing: Vec<(usize, String)> = projects
            .iter()
            .enumerate()
            .filter(|(_, p)| p.deployment_enabled.is_none())
            .map(|(n, p)| (n, format!("/projects/{}", seg(&p.id))))
            .collect();
        let asks: Vec<BoxFuture<'_, (usize, Option<bool>)>> = missing
            .into_iter()
            .map(|(n, path)| {
                Box::pin(async move {
                    let one = self
                        .call::<Project>(reqwest::Method::GET, &path, Body::Empty, "the project")
                        .await;
                    // Not known stays not known: the list is still worth showing.
                    (n, one.ok().and_then(|p| p.deployment_enabled))
                }) as BoxFuture<'_, _>
            })
            .collect();
        let answers: Vec<(usize, Option<bool>)> = futures_util::stream::iter(asks)
            .buffer_unordered(UPLOAD_CONCURRENCY)
            .collect()
            .await;
        for (n, on) in answers {
            projects[n].deployment_enabled = on;
        }
        Ok(projects)
    }

    /// The project's hardware configurations, but those Research removed.
    pub async fn hardware(&self, project: &str) -> anyhow::Result<Vec<Hardware>> {
        let raw = self
            .call::<Results<RawHardware>>(
                reqwest::Method::GET,
                &format!("/projects/{}/hardware-configurations", seg(project)),
                Body::Empty,
                "the hardware",
            )
            .await?
            .results;
        Ok(raw
            .into_iter()
            .filter(|h| !h.removed)
            .map(|h| Hardware {
                id: h.id,
                name: h.name,
                trial: h.available_for_trial,
                cpu_count: h.cpu_count,
                ram_gb: h.ram_gb,
                gpu: h.gpu.is_some_and(|g| !g.is_null()),
            })
            .collect())
    }

    /* ── desks and their files ── */

    pub async fn desks(&self, project: &str) -> anyhow::Result<Vec<Desk>> {
        Ok(self
            .call::<Results<Desk>>(
                reqwest::Method::GET,
                &format!("/projects/{}/desks", seg(project)),
                Body::Empty,
                "the project's desks",
            )
            .await?
            .results)
    }

    pub async fn create_desk(&self, project: &str, name: &str) -> anyhow::Result<Desk> {
        self.call(
            reqwest::Method::POST,
            &format!("/projects/{}/desks", seg(project)),
            Body::Json(&serde_json::json!({ "name": name })),
            "a desk for Studio's build",
        )
        .await
    }

    pub async fn desk(&self, desk: &str) -> anyhow::Result<Desk> {
        self.call(
            reqwest::Method::GET,
            &format!("/desks/{}", seg(desk)),
            Body::Empty,
            "the desk's state",
        )
        .await
    }

    pub async fn start_desk(&self, desk: &str) -> anyhow::Result<Desk> {
        self.call(
            reqwest::Method::POST,
            &format!("/desks/{}/filesystem", seg(desk)),
            Body::Empty,
            "starting the desk",
        )
        .await
    }

    pub async fn stop_desk(&self, desk: &str) -> anyhow::Result<()> {
        self.act(
            reqwest::Method::DELETE,
            &format!("/desks/{}/filesystem", seg(desk)),
            Body::Empty,
            "stopping the desk",
        )
        .await
    }

    /// Make a folder in the desk's project folder: 201 made, 405 already
    /// there. 409 means its parent is missing, which Studio's upload never
    /// lets happen (parents first), so it is said as Studio's bug.
    pub async fn make_folder(&self, desk: &str, path: &str) -> anyhow::Result<()> {
        let what = format!("making folder {path} in the desk");
        let mkcol = reqwest::Method::from_bytes(b"MKCOL").expect("a method name");
        let res = self
            .send_dav(desk, mkcol, &self.dav(desk, path), Body::Empty, &[], &what)
            .await?;
        match res.status() {
            s if s.is_success() || s == reqwest::StatusCode::METHOD_NOT_ALLOWED => Ok(()),
            reqwest::StatusCode::CONFLICT => bail!(
                "the desk has no parent folder for {path} (MKCOL answered 409): Studio makes \
                 a folder's parents first, so this is a bug in Studio's upload"
            ),
            _ => Err(Self::refused(res, &what).await),
        }
    }

    /// Write a file to the desk: up to [`PART_SIZE`] as one PUT, a bigger
    /// one in parts (Research's rules §4-§6). Its folder must be there.
    pub async fn put_file(&self, desk: &str, path: &str, content: &[u8]) -> anyhow::Result<()> {
        if content.len() > PART_SIZE {
            return self.put_parts(desk, path, content).await;
        }
        let what = format!("writing {path} to the desk");
        let res = self
            .send_dav(
                desk,
                reqwest::Method::PUT,
                &self.dav(desk, path),
                Body::Bytes(content),
                &[],
                &what,
            )
            .await?;
        if res.status().is_success() {
            return Ok(());
        }
        Err(Self::dav_refused(res, &what, path).await)
    }

    /// A file over [`PART_SIZE`]: the old one deleted first (a parts upload
    /// writes into it at the given places, and a shorter new file would keep
    /// the old tail), then each part of exactly [`PART_SIZE`] bytes, the last
    /// shorter, PUT to the same path with `Content-Range: bytes a-b/total` and
    /// `X-CheckSum` (its sha256), a few at once. A part that fails (a
    /// `409 Checksum mismatch` among others) is sent again, up to
    /// [`PART_TRIES`] times.
    async fn put_parts(&self, desk: &str, path: &str, content: &[u8]) -> anyhow::Result<()> {
        self.remove_path(desk, path).await?;
        let total = content.len();
        let url = self.dav(desk, path);
        let parts: Vec<(usize, &[u8])> = content
            .chunks(PART_SIZE)
            .enumerate()
            .map(|(i, part)| (i * PART_SIZE, part))
            .collect();
        let count = parts.len();
        // Boxed: a stream of borrowing futures is otherwise not Send for
        // every lifetime, which a task handler needs.
        let sends: Vec<BoxFuture<'_, anyhow::Result<()>>> = parts
            .into_iter()
            .map(|(start, part)| {
                let url = url.clone();
                Box::pin(async move {
                    debug_assert!(part.len() <= MAX_BODY);
                    let end = start + part.len() - 1;
                    let headers = [
                        ("Content-Range", format!("bytes {start}-{end}/{total}")),
                        ("X-CheckSum", hex::encode(sha2::Sha256::digest(part))),
                    ];
                    let what = format!(
                        "writing part {} of {count} of {path} (bytes {start}-{end}) to the desk",
                        start / PART_SIZE + 1
                    );
                    let mut tries = 0;
                    loop {
                        tries += 1;
                        let res = self
                            .send_dav(
                                desk,
                                reqwest::Method::PUT,
                                &url,
                                Body::Bytes(part),
                                &headers,
                                &what,
                            )
                            .await?;
                        if res.status().is_success() {
                            return anyhow::Ok(());
                        }
                        let status = res.status();
                        let e = Self::dav_refused(res, &what, path).await;
                        // A part the desk will never take as sent (its size, its
                        // range, its length) is not sent again.
                        if tries >= PART_TRIES
                            || status == reqwest::StatusCode::BAD_REQUEST
                            || status == reqwest::StatusCode::PAYLOAD_TOO_LARGE
                        {
                            return Err(e.context(format!("after {tries} tries")));
                        }
                    }
                }) as BoxFuture<'_, _>
            })
            .collect();
        let mut sent = futures_util::stream::iter(sends).buffer_unordered(PART_CONCURRENCY);
        while let Some(done) = sent.next().await {
            done?;
        }
        Ok(())
    }

    /// A refused file write in words that say whose it is: a missing folder
    /// (404 ENOENT) or a body over the cap (413) is Studio's bug, a part of
    /// the wrong size Studio's too; anything else in Research's own words.
    async fn dav_refused(res: reqwest::Response, what: &str, path: &str) -> anyhow::Error {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        let said = problem(status, &body);
        match status.as_u16() {
            404 => anyhow!(
                "Constructor Research refused {what}: the desk has no folder for {path} \
                 ({said}); Studio makes the folders first, so this is a bug in Studio's upload"
            ),
            413 => anyhow!(
                "Constructor Research refused {what}: the body is over the desk's 8 MB cap \
                 ({said}); Studio sends big files in 5 MiB parts, so this is a bug in Studio's \
                 upload"
            ),
            400 if body.to_lowercase().contains("invalid chunk size") => anyhow!(
                "Constructor Research refused {what}: invalid chunk size ({said}); every part \
                 but the last must be exactly {PART_SIZE} bytes, so this is a bug in Studio's \
                 upload"
            ),
            _ => anyhow!("Constructor Research refused {what}: {said}"),
        }
    }

    /// A file of the desk's project folder; `None` when there is none.
    pub async fn get_file(&self, desk: &str, path: &str) -> anyhow::Result<Option<Vec<u8>>> {
        let what = format!("reading {path} in the desk");
        let res = self
            .send_dav(
                desk,
                reqwest::Method::GET,
                &self.dav(desk, path),
                Body::Empty,
                &[],
                &what,
            )
            .await?;
        if res.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !res.status().is_success() {
            return Err(Self::refused(res, &what).await);
        }
        Ok(Some(res.bytes().await?.to_vec()))
    }

    /// Remove a file or a folder and all in it; one not there is fine.
    pub async fn remove_path(&self, desk: &str, path: &str) -> anyhow::Result<()> {
        let what = format!("removing {path} from the desk");
        let res = self
            .send_dav(
                desk,
                reqwest::Method::DELETE,
                &self.dav(desk, path),
                Body::Empty,
                &[],
                &what,
            )
            .await?;
        if res.status().is_success() || res.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(());
        }
        Err(Self::refused(res, &what).await)
    }

    /* ── images ── */

    /// Build an image from `dockerfile`, a path in the project folder.
    pub async fn build_image(
        &self,
        desk: &str,
        name: &str,
        dockerfile: &str,
    ) -> anyhow::Result<Image> {
        self.call(
            reqwest::Method::POST,
            &format!("/desks/{}/images", seg(desk)),
            Body::Json(&serde_json::json!({ "name": name, "dockerfile": dockerfile })),
            &format!("building image {name}"),
        )
        .await
    }

    pub async fn image(&self, image: &str) -> anyhow::Result<Image> {
        self.call(
            reqwest::Method::GET,
            &format!("/images/{}", seg(image)),
            Body::Empty,
            "the image's state",
        )
        .await
    }

    /// The last lines of an image's build log, while Research still has it
    /// (the build's Job; Research keeps no log after it). `Ok(None)` when
    /// the log says nothing; an error when Research could not be asked.
    pub async fn build_log_tail(
        &self,
        image: &str,
        lines: usize,
    ) -> anyhow::Result<Option<String>> {
        let url = format!(
            "{}/api/platform-keeper/image-builds/{}/logs",
            self.base,
            seg(image)
        );
        self.stream_tail(url, lines).await
    }

    /// The last lines of a running service's log: what its newest pod has
    /// written. Research serves it only as a live stream with no tail of its
    /// own, so the stream is read for a few seconds and its end kept.
    /// `Ok(None)` when the log says nothing; an error when Research could
    /// not be asked, so a refused sign-in does not read as an empty log.
    pub async fn service_log_tail(
        &self,
        service: &str,
        lines: usize,
    ) -> anyhow::Result<Option<String>> {
        let url = format!(
            "{}/api/platform-keeper/services/{}/logs",
            self.base,
            seg(service)
        );
        self.stream_tail(url, lines).await
    }

    /// An event stream read for up to ten seconds, its last `lines` data
    /// lines kept. `Ok(None)` when it opens but says nothing; an error when
    /// it cannot be opened (unreachable, refused, no answer in time).
    async fn stream_tail(&self, url: String, lines: usize) -> anyhow::Result<Option<String>> {
        let what = "reading a log";
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let res = tokio::time::timeout_at(
            deadline,
            self.authorized(self.http.get(url))
                .header("accept", "text/event-stream")
                .send(),
        )
        .await
        .map_err(|_| anyhow!("Constructor Research did not answer {what} in time"))?
        .map_err(|e| anyhow!("Constructor Research could not be reached for {what}: {e}"))?;
        if !res.status().is_success() {
            return Err(Self::refused(res, what).await);
        }
        let mut stream = res.bytes_stream();
        let mut buf: Vec<u8> = Vec::new();
        while let Ok(Some(Ok(chunk))) = tokio::time::timeout_at(deadline, stream.next()).await {
            buf.extend_from_slice(&chunk);
            if buf.len() > 1 << 20 {
                buf.drain(..buf.len() - (1 << 19));
            }
        }
        let text = String::from_utf8_lossy(&buf);
        let kept: Vec<&str> = text.lines().filter_map(log_line).collect();
        let tail = kept[kept.len().saturating_sub(lines)..].join("\n");
        Ok((!tail.is_empty()).then_some(tail))
    }

    /// Follow a service's log until `until`, reopening the stream (after
    /// `retry`) whenever it closes, and tell its containers apart. Research
    /// keeps no log of a container once it is gone, and each connection
    /// replays the current one from its start: a connection that begins
    /// with the line the current container began with is a replay; one that
    /// begins otherwise, or a "Container is waiting to start" after the
    /// container's own lines, is a new container.
    pub async fn watch_log(
        &self,
        service: &str,
        until: tokio::time::Instant,
        retry: Duration,
    ) -> Watched {
        let url = format!(
            "{}/api/platform-keeper/services/{}/logs",
            self.base,
            seg(service)
        );
        let mut w = Watched::default();
        // The current container's first line, and how many of its lines were seen.
        let mut first: Option<String> = None;
        let mut seen = 0usize;
        while tokio::time::Instant::now() < until {
            let opened = tokio::time::timeout_at(
                until,
                self.authorized(self.http.get(&url))
                    .header("accept", "text/event-stream")
                    .send(),
            )
            .await;
            if let Ok(Ok(res)) = opened
                && res.status().is_success()
            {
                let mut stream = res.bytes_stream();
                let mut partial = String::new();
                // Lines of this connection, and replayed ones left to skip.
                let mut here = 0usize;
                let mut skip = 0usize;
                while let Ok(Some(Ok(chunk))) = tokio::time::timeout_at(until, stream.next()).await
                {
                    partial.push_str(&String::from_utf8_lossy(&chunk));
                    let Some(end) = partial.rfind('\n') else {
                        continue;
                    };
                    let complete: String = partial.drain(..=end).collect();
                    for line in complete.lines().filter_map(log_line) {
                        if line.starts_with(WAITING) {
                            if here > 0 && !w.lines.is_empty() {
                                w.restarted();
                                (first, seen) = (None, 0);
                            }
                            continue;
                        }
                        if here == 0 {
                            match &first {
                                Some(f) if f == line => skip = seen,
                                Some(_) => {
                                    w.restarted();
                                    (first, seen) = (None, 0);
                                }
                                None => {}
                            }
                        }
                        here += 1;
                        if first.is_none() {
                            first = Some(line.to_owned());
                        }
                        if skip > 0 {
                            skip -= 1;
                            continue;
                        }
                        seen += 1;
                        w.lines.push(line.to_owned());
                        if w.lines.len() > WATCHED_LINES {
                            w.lines.remove(0);
                        }
                    }
                }
            }
            let next = tokio::time::Instant::now() + retry;
            tokio::time::sleep_until(next.min(until)).await;
        }
        w
    }

    /* ── applications and services ── */

    pub async fn applications(&self, project: &str) -> anyhow::Result<Vec<Application>> {
        Ok(self
            .call::<Results<Application>>(
                reqwest::Method::GET,
                &format!("/projects/{}/applications", seg(project)),
                Body::Empty,
                "the project's applications",
            )
            .await?
            .results)
    }

    /// The project's application of that name, if there is one.
    pub async fn application_named(
        &self,
        project: &str,
        name: &str,
    ) -> anyhow::Result<Option<Application>> {
        Ok(self
            .applications(project)
            .await?
            .into_iter()
            .find(|a| a.name == name))
    }

    pub async fn create_application(
        &self,
        project: &str,
        name: &str,
    ) -> anyhow::Result<Application> {
        self.call(
            reqwest::Method::POST,
            &format!("/projects/{}/applications", seg(project)),
            Body::Json(&serde_json::json!({ "name": name })),
            &format!("creating application {name}"),
        )
        .await
    }

    pub async fn application(&self, application: &str) -> anyhow::Result<Application> {
        self.call(
            reqwest::Method::GET,
            &format!("/applications/{}", seg(application)),
            Body::Empty,
            "the application's state",
        )
        .await
    }

    /// Remove an application and its services.
    pub async fn delete_application(&self, application: &str) -> anyhow::Result<()> {
        self.act(
            reqwest::Method::DELETE,
            &format!("/applications/{}", seg(application)),
            Body::Empty,
            "removing the application",
        )
        .await
    }

    pub async fn create_service(
        &self,
        application: &str,
        body: &ServiceBody,
    ) -> anyhow::Result<Service> {
        self.call(
            reqwest::Method::POST,
            &format!("/applications/{}/services", seg(application)),
            Body::Json(&Self::json(body)?),
            &format!("creating service {}", body.name),
        )
        .await
    }

    /// Change a service to `body`: ports by number, volumes and variables by
    /// name, so a volume of the same name keeps its data.
    pub async fn patch_service(
        &self,
        application: &str,
        service: &str,
        body: &ServiceBody,
    ) -> anyhow::Result<()> {
        self.act(
            reqwest::Method::PATCH,
            &format!(
                "/applications/{}/services/{}",
                seg(application),
                seg(service)
            ),
            Body::Json(&Self::json(body)?),
            &format!("changing service {}", body.name),
        )
        .await
    }

    pub async fn service(&self, service: &str) -> anyhow::Result<Service> {
        self.call(
            reqwest::Method::GET,
            &format!("/services/{}", seg(service)),
            Body::Empty,
            "the service's state",
        )
        .await
    }

    pub async fn start_service(&self, service: &str) -> anyhow::Result<Service> {
        self.call(
            reqwest::Method::POST,
            &format!("/services/{}/start", seg(service)),
            Body::Empty,
            "starting the service",
        )
        .await
    }

    /// Research stops only a running service, and starts only a stopped or
    /// failed one.
    pub async fn stop_service(&self, service: &str) -> anyhow::Result<Service> {
        self.call(
            reqwest::Method::POST,
            &format!("/services/{}/stop", seg(service)),
            Body::Empty,
            "stopping the service",
        )
        .await
    }

    pub async fn delete_service(&self, service: &str) -> anyhow::Result<()> {
        self.act(
            reqwest::Method::DELETE,
            &format!("/services/{}", seg(service)),
            Body::Empty,
            "removing the service",
        )
        .await
    }

    /* ── a build: the files into a desk, an image per Dockerfile ── */

    /// The desk Studio builds in: its own (`studio`) where the project may
    /// have more than one, or else the project's one desk.
    async fn build_desk(&self, project: &str) -> anyhow::Result<Desk> {
        let desks = self.desks(project).await?;
        if let Some(d) = desks.iter().find(|d| d.name == STUDIO_DESK) {
            return Ok(d.clone());
        }
        match self.create_desk(project, STUDIO_DESK).await {
            Ok(d) => Ok(d),
            Err(e) => {
                // Another build made Studio's desk a moment ago: build in it.
                let now = self.desks(project).await.unwrap_or_default();
                if let Some(d) = now.iter().find(|d| d.name == STUDIO_DESK) {
                    return Ok(d.clone());
                }
                // One desk per project (Research's `multi_desk` off): build in it.
                desks.into_iter().next().ok_or(e)
            }
        }
    }

    /// Wait for the desk's files to be reachable: whether they are (`false`
    /// when the run was stopped or `stop_at` came first), and whether Studio
    /// started the desk.
    async fn desk_running(
        &self,
        desk: &str,
        pace: Pace,
        cancelled: Cancelled<'_>,
        stop_at: tokio::time::Instant,
    ) -> anyhow::Result<(bool, bool)> {
        let until = tokio::time::Instant::now() + pace.desk_for;
        let mut started = false;
        let mut last = String::new();
        loop {
            let state = self.desk(desk).await?;
            last.clone_from(&state.filesystem.status);
            match state.filesystem.status.as_str() {
                "running" => return Ok((true, started)),
                // On its way: wait for it.
                "starting" | "stopping" | "pending" => {}
                // Not running, whatever Research calls it (`not_started`,
                // `stopped` after another build stopped it, ...): start it.
                // A status left out here once kept a second build waiting
                // ten minutes for a desk the first had stopped.
                _ => {
                    self.start_desk(desk).await?;
                    started = true;
                }
            }
            if cancelled() || tokio::time::Instant::now() >= stop_at {
                return Ok((false, started));
            }
            if tokio::time::Instant::now() >= until {
                bail!(
                    "the desk did not start within {} minutes (Research reports it {})",
                    pace.desk_for.as_secs() / 60,
                    if last.is_empty() {
                        "without a status"
                    } else {
                        last.as_str()
                    }
                );
            }
            tokio::time::sleep(pace.poll).await;
        }
    }

    /// Keep `folder` out of the project's git: the desk's repository may
    /// commit what is in its files.
    async fn exclude_from_git(&self, desk: &str, folder: &str) {
        let path = ".git/info/exclude";
        let line = format!("/{folder}/");
        if let Ok(Some(existing)) = self.get_file(desk, path).await {
            let text = String::from_utf8_lossy(&existing);
            if !text.lines().any(|l| l.trim() == line) {
                let mut text = text.into_owned();
                if !text.is_empty() && !text.ends_with('\n') {
                    text.push('\n');
                }
                text.push_str(&line);
                text.push('\n');
                if let Err(e) = self.put_file(desk, path, text.as_bytes()).await {
                    tracing::warn!(error = %e, "research: the build folder could not be kept out of git");
                }
            }
        }
    }

    /// Write the tree at `local` into the desk at `remote`, but for `.git`
    /// and `target` folders; how many files.
    #[cfg(test)]
    async fn upload(
        &self,
        desk: &str,
        local: &Path,
        remote: &str,
        lock: Option<&str>,
    ) -> anyhow::Result<usize> {
        self.upload_measured(desk, local, remote, lock, &unmeasured)
            .await
    }

    /// Upload the tree at `local` to `remote` on the desk, counting the files
    /// and bytes as they go up.
    async fn upload_measured(
        &self,
        desk: &str,
        local: &Path,
        remote: &str,
        lock: Option<&str>,
        measure: Measure<'_>,
    ) -> anyhow::Result<usize> {
        let root = local.to_path_buf();
        let (dirs, files) = tokio::task::spawn_blocking(move || walk(&root))
            .await
            .context("the prepared tree could not be read")??;
        // The sizes for the byte count; a file that cannot be read now fails
        // its upload below, with its own error.
        let sized: Vec<(String, u64)> = {
            let root = local.to_path_buf();
            tokio::task::spawn_blocking(move || {
                files
                    .into_iter()
                    .map(|rel| {
                        let size = std::fs::metadata(root.join(&rel)).map_or(0, |m| m.len());
                        (rel, size)
                    })
                    .collect()
            })
            .await
            .context("the prepared tree could not be read")?
        };
        let files_total = sized.len() as u64;
        let bytes_total: u64 = sized.iter().map(|(_, n)| n).sum();
        let (mut files_done, mut bytes_done) = (0u64, 0u64);
        measure(Measured::Upload {
            files_done,
            files_total,
            bytes_done,
            bytes_total,
        })
        .await;
        let mut at = String::new();
        for part in remote.split('/').filter(|p| !p.is_empty()) {
            if !at.is_empty() {
                at.push('/');
            }
            at.push_str(part);
            self.make_folder(desk, &at).await?;
        }
        // A folder after its parent: level by level, each level at once.
        let mut levels: BTreeMap<usize, Vec<String>> = BTreeMap::new();
        for dir in dirs {
            levels
                .entry(dir.matches('/').count())
                .or_default()
                .push(format!("{remote}/{dir}"));
        }
        for level in levels.into_values() {
            let folders: Vec<BoxFuture<'_, anyhow::Result<()>>> = level
                .into_iter()
                .map(|path| {
                    Box::pin(async move { self.make_folder(desk, &path).await }) as BoxFuture<'_, _>
                })
                .collect();
            let mut made = futures_util::stream::iter(folders).buffer_unordered(UPLOAD_CONCURRENCY);
            while let Some(done) = made.next().await {
                done?;
            }
        }
        let count = sized.len();
        let mut writes = futures_util::stream::iter(sized.into_iter().map(|(rel, _)| {
            let path = local.join(&rel);
            async move {
                let content = tokio::fs::read(&path)
                    .await
                    .with_context(|| format!("{} could not be read", path.display()))?;
                self.put_file(desk, &format!("{remote}/{rel}"), &content)
                    .await
                    .map(|()| content.len() as u64)
            }
        }))
        .buffer_unordered(UPLOAD_CONCURRENCY);
        let mut refreshed = tokio::time::Instant::now();
        while let Some(done) = writes.next().await {
            // A file that grew since it was sized does not count past the total.
            bytes_done = (bytes_done + done?).min(bytes_total);
            files_done += 1;
            measure(Measured::Upload {
                files_done,
                files_total,
                bytes_done,
                bytes_total,
            })
            .await;
            if let Some(lock) = lock
                && refreshed.elapsed() >= DESK_LOCK_REFRESH
            {
                self.write_desk_lock(desk, lock).await?;
                refreshed = tokio::time::Instant::now();
            }
        }
        Ok(count)
    }

    /// Put the tree at `local` into a desk of `project` (under
    /// [`BUILD_FOLDER`]`/{name}`), build each of `images` there and wait for
    /// all of them. The desk is stopped afterwards if Studio started it, and
    /// the folder removed.
    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    pub async fn build_in_desk(
        &self,
        project: &str,
        local: &Path,
        name: &str,
        images: &[ImageBuild],
        pace: Pace,
        progress: Progress<'_>,
        cancelled: Cancelled<'_>,
    ) -> anyhow::Result<Vec<Built>> {
        self.build_in_desk_measured(
            project,
            local,
            name,
            images,
            pace,
            progress,
            &unmeasured,
            cancelled,
        )
        .await
    }

    /// [`Self::desk_build`] in one go, never handed over: the whole build in
    /// one call, as a test drives it.
    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    pub async fn build_in_desk_measured(
        &self,
        project: &str,
        local: &Path,
        name: &str,
        images: &[ImageBuild],
        pace: Pace,
        progress: Progress<'_>,
        measure: Measure<'_>,
        cancelled: Cancelled<'_>,
    ) -> anyhow::Result<Vec<Built>> {
        let nowhere = |_: &DeskBuild| -> BoxFuture<'_, ()> { Box::pin(async {}) };
        match self
            .desk_build(
                project,
                Some(local),
                name,
                images,
                DeskBuild::default(),
                pace,
                HandOver::never(),
                progress,
                measure,
                &nowhere,
                cancelled,
            )
            .await?
        {
            Followed::Built(built) => Ok(built),
            Followed::Later(state) => {
                self.end_desk_build(&state, name, pace).await;
                bail!("the build was cancelled")
            }
        }
    }

    /// One attempt at a desk build: take up `state` where the last attempt
    /// left it, and go on until the images are built, the run is stopped,
    /// or `hand_over` says this attempt is over.
    ///
    /// Before the images are asked for, the build needs the prepared tree
    /// (`local`): it takes the desk (waiting while another build holds it),
    /// uploads the tree and asks Research for each image. From then on it
    /// needs only `state`, which `checkpoint` is given whenever it changes:
    /// a later attempt follows the same images without uploading or building
    /// anything again.
    ///
    /// Ends with [`Followed::Built`] once every image is built (the folder
    /// removed and the desk let go), or [`Followed::Later`] with what the
    /// next attempt continues from -- nothing is cleaned then; a run that
    /// will not continue calls [`Self::end_desk_build`]. An error has
    /// cleaned up already.
    #[allow(clippy::too_many_arguments)]
    pub async fn desk_build(
        &self,
        project: &str,
        local: Option<&Path>,
        name: &str,
        images: &[ImageBuild],
        state: DeskBuild,
        pace: Pace,
        hand_over: HandOver,
        progress: Progress<'_>,
        measure: Measure<'_>,
        checkpoint: Checkpoint<'_>,
        cancelled: Cancelled<'_>,
    ) -> anyhow::Result<Followed> {
        let mut state = state;
        // Every image made by an earlier build: no desk, no upload.
        if !state.submitted && images.is_empty() {
            state.submitted = true;
        }
        if state.submitted && state.desk.is_none() {
            return match self
                .follow_images(
                    "", "", &mut state, pace, hand_over, progress, measure, checkpoint, cancelled,
                    name,
                )
                .await?
            {
                Some(built) => Ok(Followed::Built(built)),
                None => Ok(Followed::Later(state)),
            };
        }
        let desk = match &state.desk {
            Some(id) => self.desk(id).await?,
            None => self.build_desk(project).await?,
        };
        state.desk = Some(desk.id.clone());
        let folder = format!("{BUILD_FOLDER}/{name}");
        let went = self
            .desk_build_steps(
                &desk, local, name, images, &folder, &mut state, pace, hand_over, progress,
                measure, checkpoint, cancelled,
            )
            .await;
        match went {
            Ok(Some(built)) => {
                self.end_desk_build(&state, name, pace).await;
                Ok(Followed::Built(built))
            }
            Ok(None) => Ok(Followed::Later(state)),
            Err(e) => {
                self.end_desk_build(&state, name, pace).await;
                Err(e)
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn desk_build_steps(
        &self,
        desk: &Desk,
        local: Option<&Path>,
        name: &str,
        images: &[ImageBuild],
        folder: &str,
        state: &mut DeskBuild,
        pace: Pace,
        hand_over: HandOver,
        progress: Progress<'_>,
        measure: Measure<'_>,
        checkpoint: Checkpoint<'_>,
        cancelled: Cancelled<'_>,
    ) -> anyhow::Result<Option<Vec<Built>>> {
        if !state.submitted {
            measure(Measured::Desk).await;
            let waiting_since = *state.waiting_since.get_or_insert_with(unix_now);
            let (taken, started) = self
                .take_desk(
                    desk,
                    name,
                    pace,
                    progress,
                    cancelled,
                    hand_over.upload_by,
                    waiting_since,
                )
                .await?;
            state.started_desk |= started;
            if !taken {
                return Ok(None);
            }
            let local = local.ok_or_else(|| {
                anyhow!("the build has no prepared tree to put on the desk (an internal error)")
            })?;
            let building = self
                .submit_images(
                    &desk.id, local, folder, images, pace, progress, measure, name,
                )
                .await?;
            state.images.extend(building);
            state.submitted = true;
            state.build_until = Some(unix_now() + pace.build_for.as_secs());
            checkpoint(state).await;
        }
        self.follow_images(
            &desk.id, folder, state, pace, hand_over, progress, measure, checkpoint, cancelled,
            name,
        )
        .await
    }

    /// Let a desk build go: its folder removed, the desk released and, if
    /// Studio started it, stopped. What a build that ends, or will not be
    /// continued, does; harmless where there is nothing to remove.
    pub async fn end_desk_build(&self, state: &DeskBuild, name: &str, pace: Pace) {
        let Some(desk) = state.desk.as_deref() else {
            return;
        };
        let folder = format!("{BUILD_FOLDER}/{name}");
        if let Err(e) = self.remove_path(desk, &folder).await {
            tracing::warn!(error = %e, "research: the build folder could not be removed");
        }
        self.release_desk(desk, name).await;
        // A build waiting for the desk looks every three polls: give it the
        // time to take the desk, and leave the desk running for it if it did
        // (it stops it then, having waited).
        if state.started_desk {
            tokio::time::sleep(pace.poll * 4).await;
            let taken = matches!(self.desk_holder(desk).await, Ok(Some(_)));
            if !taken && let Err(e) = self.stop_desk(desk).await {
                tracing::warn!(error = %e, "research: the desk Studio started could not be stopped");
            }
        }
    }

    /// Start the desk and take it for build `name`: while another Studio
    /// build holds it (its lock written within [`DESK_LOCK_STALE`]), wait
    /// and say so, then take it. Whether it was taken -- not when the run was
    /// stopped, or `stop_at` came first, while it waited -- and whether
    /// Studio started the desk. The wait began at `waiting_since` (Unix
    /// seconds), perhaps in an earlier attempt.
    #[allow(clippy::too_many_arguments)]
    async fn take_desk(
        &self,
        desk: &Desk,
        name: &str,
        pace: Pace,
        progress: Progress<'_>,
        cancelled: Cancelled<'_>,
        stop_at: tokio::time::Instant,
        waiting_since: u64,
    ) -> anyhow::Result<(bool, bool)> {
        let until = waiting_since + DESK_WAIT_FOR.as_secs();
        let mut said: Option<String> = None;
        let mut started = false;
        loop {
            if said.is_none() {
                progress(format!("starting desk {}", desk.name)).await;
            }
            let (running, start) = self
                .desk_running(&desk.id, pace, cancelled, stop_at)
                .await?;
            started |= start;
            if !running {
                return Ok((false, started));
            }
            match self.desk_holder(&desk.id).await? {
                Some(other) if other != name => {
                    // Having waited, this build stops the desk at its end:
                    // the one before leaves it running for it.
                    started = true;
                    if said.as_deref() != Some(other.as_str()) {
                        progress(format!(
                            "waiting for build {other}, which is using desk {} of this \
                             Research project; this build starts when it ends",
                            desk.name
                        ))
                        .await;
                        said = Some(other.clone());
                    }
                    if cancelled() || tokio::time::Instant::now() >= stop_at {
                        return Ok((false, started));
                    }
                    if unix_now() >= until {
                        bail!(
                            "desk {} of this Research project stayed in use by build {other} \
                             for {} hours",
                            desk.name,
                            DESK_WAIT_FOR.as_secs() / 3600
                        );
                    }
                    tokio::time::sleep(pace.poll.max(Duration::from_millis(1)) * 3).await;
                }
                _ => {
                    self.write_desk_lock(&desk.id, name).await?;
                    // Two builds that read an empty lock at once: the later
                    // write wins, and the other one waits.
                    match self.desk_holder(&desk.id).await? {
                        Some(holder) if holder != name => continue,
                        _ => return Ok((true, started)),
                    }
                }
            }
        }
    }

    /// The build holding the desk, if its lock is fresh.
    async fn desk_holder(&self, desk: &str) -> anyhow::Result<Option<String>> {
        let Some(bytes) = self.get_file(desk, DESK_LOCK).await? else {
            return Ok(None);
        };
        let lock: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_default();
        let at = lock
            .get("at")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        if now.saturating_sub(at) > DESK_LOCK_STALE.as_secs() {
            return Ok(None);
        }
        Ok(lock
            .get("build")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned))
    }

    async fn write_desk_lock(&self, desk: &str, name: &str) -> anyhow::Result<()> {
        let at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        self.make_folder(desk, BUILD_FOLDER).await?;
        let body = serde_json::json!({ "build": name, "at": at }).to_string();
        self.put_file(desk, DESK_LOCK, body.as_bytes()).await
    }

    /// Let the desk go, if this build still holds it.
    async fn release_desk(&self, desk: &str, name: &str) {
        match self.desk_holder(desk).await {
            Ok(Some(holder)) if holder == name => {
                if let Err(e) = self.remove_path(desk, DESK_LOCK).await {
                    tracing::warn!(error = %e, "research: the desk's lock could not be removed");
                }
            }
            Ok(_) => {}
            Err(e) => tracing::warn!(error = %e, "research: the desk's lock could not be read"),
        }
    }

    /// Put the tree at `local` into `folder` of the desk and ask Research
    /// for each of `images` there: the images it is building.
    #[allow(clippy::too_many_arguments)]
    async fn submit_images(
        &self,
        desk: &str,
        local: &Path,
        folder: &str,
        images: &[ImageBuild],
        pace: Pace,
        progress: Progress<'_>,
        measure: Measure<'_>,
        lock: &str,
    ) -> anyhow::Result<Vec<Building>> {
        self.exclude_from_git(desk, BUILD_FOLDER).await;
        self.remove_path(desk, folder).await?;
        progress("uploading the prepared tree to the desk".into()).await;
        let files = self
            .upload_measured(desk, local, folder, Some(lock), measure)
            .await?;
        progress(format!(
            "uploaded {files} files; building {} image(s)",
            images.len()
        ))
        .await;
        if !pace.settle.is_zero() {
            progress(format!(
                "waiting {} s for the files to reach the builder",
                pace.settle.as_secs()
            ))
            .await;
            tokio::time::sleep(pace.settle).await;
        }
        let mut building = Vec::new();
        for i in images {
            let image = self
                .build_image(desk, &i.name, &format!("{folder}/{}", i.dockerfile))
                .await?;
            building.push(Building {
                key: i.key.clone(),
                name: i.name.clone(),
                id: image.id,
                dockerfile: i.dockerfile.clone(),
                first_name: None,
                erred: false,
                done: false,
                reused: false,
            });
        }
        Ok(building)
    }

    /// Follow the images `state` names until all are built (`Some`), the run
    /// is stopped or `hand_over` ends this attempt (`None`).
    ///
    /// Research reports `error` for a moment while it retries a build
    /// itself, so an error counts once seen twice for the same image. A
    /// confirmed one is built once more, under a new name, before the build
    /// gives up.
    #[allow(clippy::too_many_arguments)]
    async fn follow_images(
        &self,
        desk: &str,
        folder: &str,
        state: &mut DeskBuild,
        pace: Pace,
        hand_over: HandOver,
        progress: Progress<'_>,
        measure: Measure<'_>,
        checkpoint: Checkpoint<'_>,
        cancelled: Cancelled<'_>,
        lock: &str,
    ) -> anyhow::Result<Option<Vec<Built>>> {
        let total = state.images.len() as u64;
        let done = |s: &DeskBuild| s.images.iter().filter(|b| b.done).count() as u64;
        measure(Measured::Images {
            done: done(state),
            total,
        })
        .await;
        let until = state
            .build_until
            .unwrap_or_else(|| unix_now() + pace.build_for.as_secs());
        // The desk stays this build's while its images build: its lock is
        // written at once (an earlier attempt may have written it minutes
        // ago), then every few minutes.
        let mut refreshed: Option<tokio::time::Instant> = None;
        loop {
            if !desk.is_empty() && refreshed.is_none_or(|at| at.elapsed() >= DESK_LOCK_REFRESH) {
                self.write_desk_lock(desk, lock).await?;
                refreshed = Some(tokio::time::Instant::now());
            }
            let mut changed = false;
            for n in 0..state.images.len() {
                if state.images[n].done {
                    continue;
                }
                let id = state.images[n].id.clone();
                let status = self.image(&id).await?.build_status;
                let b = &mut state.images[n];
                match status.as_str() {
                    "done" => {
                        b.done = true;
                        changed = true;
                        let shown = b.first_name.clone().unwrap_or_else(|| b.name.clone());
                        let now = done(state);
                        progress(format!("built {shown} ({now}/{total})")).await;
                        measure(Measured::Images { done: now, total }).await;
                    }
                    "error" if !b.erred => {
                        b.erred = true;
                        changed = true;
                    }
                    "error" if b.first_name.is_none() => {
                        let again = retry_name(&b.name);
                        progress(format!(
                            "{} failed; building it once more as {again}",
                            b.name
                        ))
                        .await;
                        let dockerfile = format!("{folder}/{}", b.dockerfile);
                        let image = self.build_image(desk, &again, &dockerfile).await?;
                        let b = &mut state.images[n];
                        b.first_name = Some(std::mem::replace(&mut b.name, again));
                        b.id = image.id;
                        b.erred = false;
                        changed = true;
                    }
                    "error" => {
                        let tail = self.build_log_tail(&id, 30).await.ok().flatten();
                        bail!(
                            "Constructor Research could not build image {} ({}), nor again as {}{}",
                            b.first_name.as_deref().unwrap_or_default(),
                            b.dockerfile,
                            b.name,
                            tail.map(|t| format!(":\n{t}")).unwrap_or_default()
                        );
                    }
                    _ => {}
                }
            }
            if changed {
                checkpoint(state).await;
            }
            if state.images.iter().all(|b| b.done) {
                return Ok(Some(
                    state
                        .images
                        .iter()
                        .map(|b| Built {
                            key: b.key.clone(),
                            name: b.name.clone(),
                            id: b.id.clone(),
                        })
                        .collect(),
                ));
            }
            if cancelled() || tokio::time::Instant::now() >= hand_over.follow_until {
                return Ok(None);
            }
            if unix_now() >= until {
                bail!(
                    "Constructor Research did not build every image within {} minutes",
                    pace.build_for.as_secs() / 60
                );
            }
            tokio::time::sleep(pace.poll).await;
        }
    }

    /* ── a deploy: an application whose services are exactly these ── */

    /// Make application `name` of `project` run exactly `services`: create
    /// it if need be, create or change each service and (re)start it, remove
    /// the services it no longer has, and wait for all to run.
    #[cfg(test)]
    pub async fn put_application(
        &self,
        project: &str,
        name: &str,
        services: &[ServiceBody],
        pace: Pace,
        progress: Progress<'_>,
    ) -> anyhow::Result<Application> {
        let state = self
            .put_services(project, name, services, pace, progress)
            .await?;
        match self
            .follow_start(&state, pace, HandOver::never().follow_until, progress)
            .await?
        {
            Some(app) => Ok(app),
            None => bail!("the services were never followed to the end"),
        }
    }

    /// The first half of a deploy: application `name` of `project` made to
    /// have exactly `services`, each created or changed and (re)started.
    /// What [`Self::follow_start`] follows, in this attempt or a later one.
    pub async fn put_services(
        &self,
        project: &str,
        name: &str,
        services: &[ServiceBody],
        pace: Pace,
        progress: Progress<'_>,
    ) -> anyhow::Result<AppDeploy> {
        self.enable_deployment(project).await?;
        let app = match self.application_named(project, name).await? {
            Some(app) => app,
            None => {
                progress(format!("creating application {name}")).await;
                self.create_application(project, name).await?
            }
        };
        let mut existing: BTreeMap<String, Service> = app
            .services
            .iter()
            .map(|s| (s.name.clone(), s.clone()))
            .collect();
        let mut ids = Vec::new();
        for body in services {
            match existing.remove(&body.name) {
                // Changed while stopped, as Research's own deployment MCP
                // does: a running service would take the change half-way.
                Some(s) => {
                    progress(format!("changing service {}", body.name)).await;
                    self.settled(&s.id, pace).await?;
                    if self.service(&s.id).await?.status == "running" {
                        self.stop_service(&s.id).await?;
                        self.settled(&s.id, pace).await?;
                    }
                    self.patch_service(&app.id, &s.id, body).await?;
                    self.start_service(&s.id).await?;
                    ids.push((body.name.clone(), s.id));
                }
                None => {
                    progress(format!("creating service {}", body.name)).await;
                    let s = self.create_service(&app.id, body).await?;
                    self.start_service(&s.id).await?;
                    ids.push((body.name.clone(), s.id));
                }
            }
        }
        for (gone, s) in existing {
            progress(format!(
                "removing service {gone}, which the product no longer has"
            ))
            .await;
            self.delete_service(&s.id).await?;
        }
        Ok(AppDeploy {
            application: Some(app.id),
            services: ids,
            start_until: Some(unix_now() + pace.start_for.as_secs()),
        })
    }

    /// Wait for the services `state` put to run: the application once they
    /// all do, `None` when `follow_until` came first (a later attempt goes on
    /// from the same `state`).
    pub async fn follow_start(
        &self,
        state: &AppDeploy,
        pace: Pace,
        follow_until: tokio::time::Instant,
        progress: Progress<'_>,
    ) -> anyhow::Result<Option<Application>> {
        let Some(app) = state.application.as_deref() else {
            bail!("the deploy has no application to follow (an internal error)");
        };
        let ids = &state.services;
        progress(format!("waiting for {} service(s) to run", ids.len())).await;
        let until = state
            .start_until
            .unwrap_or_else(|| unix_now() + pace.start_for.as_secs());
        loop {
            let mut running = 0;
            for (svc, id) in ids {
                let s = self.service(id).await?;
                match s.status.as_str() {
                    "running" => running += 1,
                    "failed" => {
                        let tail = self.service_log_tail(id, 20).await.ok().flatten();
                        bail!(
                            "service {svc} did not start in Constructor Research{}",
                            tail.map(|t| format!(
                                "; its last log lines:
{t}"
                            ))
                            .unwrap_or_default()
                        )
                    }
                    _ => {}
                }
            }
            if running == ids.len() {
                return self.application(app).await.map(Some);
            }
            if unix_now() >= until {
                let mut waiting = Vec::new();
                for (n, id) in ids {
                    if !matches!(self.service(id).await, Ok(s) if s.status == "running") {
                        waiting.push(n.as_str());
                    }
                }
                bail!(
                    "{} did not start in Constructor Research within {} minutes",
                    waiting.join(", "),
                    pace.start_for.as_secs() / 60
                );
            }
            if tokio::time::Instant::now() >= follow_until {
                return Ok(None);
            }
            tokio::time::sleep(pace.poll).await;
        }
    }

    /// The services of `app` whose public link has not answered within
    /// `pace.ready_for`: running is not ready. Any answer below 500 counts,
    /// as Research's own deployment MCP counts it.
    pub async fn unanswered(&self, app: &Application, pace: Pace) -> Vec<Service> {
        let mut waiting: Vec<Service> = app
            .services
            .iter()
            .filter(|s| s.link.is_some())
            .cloned()
            .collect();
        if pace.ready_for.is_zero() {
            return Vec::new();
        }
        let until = tokio::time::Instant::now() + pace.ready_for;
        loop {
            let mut still = Vec::new();
            for s in waiting {
                let url = s.link.clone().unwrap_or_default();
                let answer =
                    tokio::time::timeout(Duration::from_secs(10), self.http.get(&url).send()).await;
                if !matches!(answer, Ok(Ok(r)) if r.status().as_u16() < 500) {
                    still.push(s);
                }
            }
            waiting = still;
            if waiting.is_empty() || tokio::time::Instant::now() >= until {
                return waiting;
            }
            tokio::time::sleep(pace.poll).await;
        }
    }

    /// Wait while a service is starting or stopping: Research stops only a
    /// running service, and starts only a stopped or failed one.
    async fn settled(&self, service: &str, pace: Pace) -> anyhow::Result<()> {
        let until = tokio::time::Instant::now() + pace.start_for;
        loop {
            let s = self.service(service).await?;
            if !matches!(s.status.as_str(), "starting" | "stopping") {
                return Ok(());
            }
            if tokio::time::Instant::now() >= until {
                bail!("service {} stayed {} too long", s.name, s.status);
            }
            tokio::time::sleep(pace.poll).await;
        }
    }
}

/// The platform's line before a service's container starts.
const WAITING: &str = "Container is waiting to start";

/// Lines kept of a watched container.
const WATCHED_LINES: usize = 50;

/// What following a service's log for a while saw.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Watched {
    /// The current container's last lines.
    pub lines: Vec<String>,
    /// New containers started while it was watched.
    pub restarts: u32,
    /// The last lines of the container before the newest one: why it stopped.
    pub before: Vec<String>,
}

impl Watched {
    fn restarted(&mut self) {
        self.restarts += 1;
        self.before = std::mem::take(&mut self.lines);
    }
}

/// A log line of an event stream: its `data`, or a plain line; `None` for the
/// stream's own fields and blank lines.
fn log_line(l: &str) -> Option<&str> {
    let l = if let Some(d) = l.strip_prefix("data:") {
        d.strip_prefix(' ').unwrap_or(d)
    } else if l.starts_with(':')
        || l.starts_with("event:")
        || l.starts_with("id:")
        || l.starts_with("retry:")
    {
        return None;
    } else {
        l
    };
    (!l.trim().is_empty()).then_some(l)
}

/// The name an image is built again under: Research's 30 characters at most.
fn retry_name(name: &str) -> String {
    let base: String = name.chars().take(27).collect();
    format!("{}-r2", base.trim_end_matches('-'))
}

/// The folders and files under `root`, relative and `/`-separated, parents
/// first; `.git` and `target` folders and symbolic links to folders left out.
fn walk(root: &Path) -> anyhow::Result<(Vec<String>, Vec<String>)> {
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    let mut todo: Vec<PathBuf> = vec![PathBuf::new()];
    while let Some(rel) = todo.pop() {
        let mut entries: Vec<_> = std::fs::read_dir(root.join(&rel))
            .with_context(|| format!("{} could not be listed", root.join(&rel).display()))?
            .collect::<Result<_, _>>()?;
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name();
            let child = rel.join(&name);
            let shown = child.to_string_lossy().replace('\\', "/");
            let kind = e.file_type()?;
            let is_dir = if kind.is_symlink() {
                std::fs::metadata(e.path())
                    .map(|m| m.is_dir())
                    .unwrap_or(true)
            } else {
                kind.is_dir()
            };
            if is_dir {
                if kind.is_symlink() || name == ".git" || name == "target" {
                    continue;
                }
                dirs.push(shown);
                todo.push(child);
            } else {
                files.push(shown);
            }
        }
    }
    dirs.sort();
    files.sort();
    Ok((dirs, files))
}

#[cfg(test)]
#[path = "research_api_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "research_emulator_tests.rs"]
mod emulator_tests;
