//! Building and running a product on Constructor Research (ADR-0049 §3, §4),
//! through the Research connector and Research's own public API.
//!
//! **Build.** Studio prepares the product on its own server -- the same
//! `prepare` a cluster build's Job runs: clone, `gearbox generate`, a
//! buildable tree -- and renders its chart as the deploy will, to learn what
//! each image must carry that a Research service cannot be given: the files
//! the chart mounts from ConfigMaps, the command and the scratch folders
//! (`research_app`). Each generated Dockerfile gains those lines, the tree
//! goes into a desk of the Research project (WebDAV), and Research builds one
//! image per Dockerfile there. The build's record says `where: research` and
//! names each image as `research-image/<bake>/<name>:<id>`. Research keeps no
//! chart, so none is published.
//!
//! **Deploy.** A deploy prepares the product again at the build's commit,
//! renders its chart with the build's images (`helm template`) and makes the
//! environment's application run exactly those services, one call each. The
//! deploy's record ends with where the product opens.
//!
//! The connection is the member's own, signed in personally (ADR-0049 §5).
//! A background run is the organization's service, which cannot read a
//! personal sign-in, so a run carries who asked ([`Requester`]) and reads
//! that member's connection as them -- that one credential, for the build or
//! deploy they asked for, and nothing else.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context as _, anyhow, bail};
use async_trait::async_trait;
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::build::{self, RepoRef};
use super::research_app::{self, Application, Inputs};
use super::research_keys::{self, Laid};
use super::research_progress::Reporter;
use crate::connectors::sdk::research::{
    AppDeploy, Built, DeskBuild, Followed, HandOver, ImageBuild, Measured, Pace, Renew,
    ResearchApi, Service, Watched,
};
use crate::tasks::sdk::{TaskContext, TaskHandler, TaskOutcome};

pub const BUILD_TASK_TYPE: &str = "environments.research.build";

/// Where in the build context Studio lays out what an image carries.
pub(super) const OVERLAY_DIR: &str = "studio-research";

/// The member a Research run acts for: whose sign-in it reads, in the tenant
/// they asked in (where their personal connection's token was stored).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Requester {
    pub subject_id: Uuid,
    pub tenant_id: Uuid,
}

impl Requester {
    pub fn of(ctx: &SecurityContext) -> Self {
        Self {
            subject_id: ctx.subject_id(),
            tenant_id: ctx.subject_tenant_id(),
        }
    }

    /// The member as a reader of their own connection.
    fn context(&self) -> anyhow::Result<SecurityContext> {
        SecurityContext::builder()
            .subject_id(self.subject_id)
            .subject_type("user")
            .subject_tenant_id(self.tenant_id)
            .build()
            .map_err(|e| anyhow!("cannot act for the member who asked: {e}"))
    }
}

/// The Research sign-in a run uses: the requester's own connection and the
/// tenant it is found from (ADR-0049 §1). Each member builds and deploys with
/// their own, so it is chosen when they ask, not kept on the environment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignIn {
    pub tenant: Uuid,
    pub connection_id: Uuid,
}

/// The access token of connection `connection_id`, read as `ctx`: each read
/// trades the stored refresh token for a fresh one.
async fn token(
    hub: Arc<ClientHub>,
    ctx: &SecurityContext,
    org: Uuid,
    connection_id: Uuid,
) -> anyhow::Result<(String, String)> {
    let connectors = crate::connectors::sdk::Connectors::new(hub)
        .get()
        .ok_or_else(|| anyhow!("connections are not available in this deployment"))?;
    let (_, auth, connection) = connectors
        .driver_and_auth(ctx, org, connection_id)
        .await
        .map_err(|e| anyhow!("the Constructor Research connection cannot be used: {e:#}"))?;
    if connection.provider != crate::connectors::sdk::RESEARCH_PROVIDER {
        bail!(
            "connection '{}' is not a Constructor Research one",
            connection.label
        );
    }
    Ok((auth.root().to_owned(), auth.token))
}

/// The Research connector's calls through connection `connection_id`, read
/// as `ctx` -- or, for a background run, as the member who asked. A token
/// Research stops accepting (they last an hour; a build may take longer) is
/// renewed from the connection.
pub async fn api(
    hub: &Arc<ClientHub>,
    ctx: &SecurityContext,
    org: Uuid,
    connection_id: Uuid,
    requester: Option<&Requester>,
) -> anyhow::Result<ResearchApi> {
    let ctx = match requester {
        Some(r) => r.context()?,
        None => ctx.clone(),
    };
    let (root, first) = token(Arc::clone(hub), &ctx, org, connection_id).await?;
    let hub = Arc::clone(hub);
    let renew: Renew = Arc::new(move || -> BoxFuture<'static, anyhow::Result<String>> {
        let (hub, ctx) = (Arc::clone(&hub), ctx.clone());
        Box::pin(async move { Ok(token(hub, &ctx, org, connection_id).await?.1) })
    });
    Ok(ResearchApi::new(reqwest::Client::new(), &root, first).renewing(renew))
}

/// A product prepared on this server, in a folder removed with it.
struct Tree {
    work: PathBuf,
    prepared: build::Prepared,
}

impl Drop for Tree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.work);
    }
}

/// Clone the product's repository at `git_ref` and prepare it, as a cluster
/// build's `prepare` step does.
async fn prepare(
    hub: &Arc<ClientHub>,
    ctx: &SecurityContext,
    repo: &RepoRef,
    git_ref: Option<String>,
    description: Option<(Option<i64>, String)>,
    product_file: &str,
    profile: &str,
) -> anyhow::Result<Tree> {
    let connectors = crate::connectors::sdk::Connectors::new(Arc::clone(hub))
        .get()
        .ok_or_else(|| anyhow!("connections are not available in this deployment"))?;
    let (driver, auth, _) = connectors
        .driver_and_auth(ctx, repo.tenant, repo.connection_id)
        .await
        .map_err(|e| anyhow!("the repository's connection cannot be used by the server: {e:#}"))?;
    let url = driver.clone_url(&auth.base_url, &repo.repo)?;
    let (username, password) = driver.clone_credentials(&auth.token);
    let (username, password) = (username.to_owned(), password.to_owned());
    // A product branch lends only its description; the code is the base
    // branch's (ADR-0053 §4).
    let (git_ref, description_ref) =
        build::code_and_description_refs(git_ref.as_deref(), &repo.branch);
    let (product_file, profile) = (product_file.to_owned(), profile.to_owned());
    let work = std::env::temp_dir().join(format!("studio-research-{}", Uuid::new_v4().simple()));
    let at = work.clone();
    let prepared = tokio::task::spawn_blocking(move || -> anyhow::Result<build::Prepared> {
        std::fs::create_dir_all(&at)?;
        build::prepare_as(
            &at,
            &url,
            (&username, &password),
            Some(&git_ref),
            // Studio's revision first (ADR-0053 §2), else a product
            // branch's file (§4), else the checkout's.
            &match (&description, description_ref.as_deref()) {
                (Some((revision, text)), _) => build::DescriptionFrom::Text {
                    revision: *revision,
                    text,
                },
                (None, Some(r)) => build::DescriptionFrom::Ref(r),
                (None, None) => build::DescriptionFrom::Checkout,
            },
            &product_file,
            &profile,
            &build::SourceOptions::default(),
        )?;
        serde_json::from_slice(&std::fs::read(at.join("build.json"))?)
            .context("prepare left no build.json")
    })
    .await
    .context("the prepare step stopped")
    .and_then(|r| r);
    match prepared {
        Ok(prepared) => Ok(Tree { work, prepared }),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&work);
            Err(e)
        }
    }
}

/// The prepared chart rendered as `release` in `namespace` with `values`.
/// The values `helm template` gets: Studio's own keys taken out. A database
/// image rides in the values under `studio-database-<host>`
/// ([`research_app::database_key`]) so the deploy can give the database
/// service its image; the generated chart's schema allows no such key and
/// `helm template` refuses it ("Additional property studio-database-postgres
/// is not allowed", Research DEV, 2026-11-24).
fn chart_values(values: &serde_json::Value) -> serde_json::Value {
    let mut out = values.clone();
    if let Some(map) = out.as_object_mut() {
        map.retain(|k, _| !k.starts_with("studio-database-"));
    }
    out
}

#[cfg(test)]
mod chart_values_tests {
    #[test]
    fn database_images_stay_out_of_the_chart_values() {
        let v = serde_json::json!({
            "api-gateway": {"image": {"repository": "r", "tag": "t"}},
            "studio-database-postgres": {"image": "x"},
        });
        let out = super::chart_values(&v);
        assert!(out.get("studio-database-postgres").is_none());
        assert!(out.get("api-gateway").is_some());
        // The values the deploy keeps for the services are not touched.
        assert!(v.get("studio-database-postgres").is_some());
    }
}

async fn render(
    tree: &Tree,
    release: &str,
    namespace: &str,
    values: &serde_json::Value,
) -> anyhow::Result<String> {
    let file = tree
        .work
        .join(format!("values-{}.json", Uuid::new_v4().simple()));
    tokio::fs::write(&file, serde_json::to_vec(&chart_values(values))?).await?;
    let out = tokio::process::Command::new(super::deploy::helm_binary())
        .args([
            "template",
            release,
            &tree.prepared.chart_dir,
            "--namespace",
            namespace,
            "--values",
        ])
        .arg(&file)
        .env("HELM_CACHE_HOME", tree.work.join(".helm/cache"))
        .env("HELM_CONFIG_HOME", tree.work.join(".helm/config"))
        .env("HELM_DATA_HOME", tree.work.join(".helm/data"))
        .output()
        .await
        .context("helm could not be run")?;
    if !out.status.success() {
        bail!(
            "helm template failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    String::from_utf8(out.stdout).context("helm's output is not text")
}

/// One image `prepare` listed: its Dockerfile and context, relative to the
/// work folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildImage {
    pub app: String,
    pub name: String,
    pub dockerfile: String,
    pub context: String,
}

/// The images `prepare` listed in `apps` (`app name dockerfile-dir context`),
/// their paths made relative to the work folder.
pub fn build_images(apps: &str, work: &Path) -> anyhow::Result<Vec<BuildImage>> {
    let rel = |p: &str| -> anyhow::Result<String> {
        let rel = Path::new(p)
            .strip_prefix(work)
            .map_err(|_| anyhow!("{p} is outside the prepared tree"))?;
        Ok(rel.to_string_lossy().replace('\\', "/"))
    };
    apps.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|line| {
            let f: Vec<&str> = line.split_whitespace().collect();
            let [app, name, dockerfile, context] = f.as_slice() else {
                bail!("'{line}' is not an application prepare listed");
            };
            let dir = rel(dockerfile)?;
            Ok(BuildImage {
                app: (*app).to_owned(),
                name: (*name).to_owned(),
                dockerfile: if dir.is_empty() {
                    "Dockerfile".into()
                } else {
                    format!("{dir}/Dockerfile")
                },
                context: match rel(context)? {
                    c if c.is_empty() => ".".into(),
                    c => c,
                },
            })
        })
        .collect()
}

/// The values a build renders the chart with: the binding's, each
/// application at a placeholder image, and the configuration secret --
/// what the deploy's values are but for the images (`model::deploy_values`).
fn build_values(
    binding: Option<&serde_json::Value>,
    images: &[BuildImage],
    secret_keys: &[String],
    release: &str,
) -> serde_json::Value {
    let mut values = binding
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    for i in images {
        // A generated product's UI reads its image as one string, `ui.image`,
        // and its values allow no configuration secret: a table there makes
        // `helm template` refuse the chart's schema (as `model::image_values`
        // gives a cluster's deploy).
        if is_generated_ui(i) {
            super::model::merge(
                &mut values,
                serde_json::json!({ i.app.clone(): { "image":
                    format!("{}/{}:build", research_app::PENDING_IMAGE, i.app),
                }}),
            );
            continue;
        }
        super::model::merge(
            &mut values,
            serde_json::json!({ i.app.clone(): { "image": {
                "repository": format!("{}/{}", research_app::PENDING_IMAGE, i.app),
                "tag": "build",
            }}}),
        );
        if !secret_keys.is_empty() {
            super::model::merge(
                &mut values,
                serde_json::json!({ i.app.clone(): {
                    "existingSecret": super::model::config_secret_name(release),
                    "secretKeys": secret_keys,
                }}),
            );
        }
    }
    values
}

/// Gearbox's generated UI application (`gbx-…` image, app `ui`).
fn is_generated_ui(i: &BuildImage) -> bool {
    i.app == super::build::UI_APP
        && i.name
            .rsplit('/')
            .next()
            .is_some_and(|name| name.starts_with("gbx-"))
}

/// Write `text` at `path`, making its folder.
fn write(path: &Path, text: &str) -> anyhow::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, text).with_context(|| format!("{} could not be written", path.display()))
}

/// The images to build, each one's bake, and where each was laid out.
type LaidOut = (Vec<ImageBuild>, BTreeMap<String, String>, Vec<Laid>);

/// What a build lays out for Research in `root` (the uploaded folder): per
/// image a Dockerfile in its context folder -- Research builds with the
/// Dockerfile's folder as the context -- with what the chart mounts and runs
/// baked in, and the database servers' Postgres images. The images to build
/// and the digest of what each carries.
fn lay_out(
    work: &Path,
    root: &Path,
    images: &[BuildImage],
    app: &Application,
    database_image: &str,
) -> anyhow::Result<LaidOut> {
    let rel = |p: &Path| -> anyhow::Result<String> {
        Ok(p.strip_prefix(root)
            .map_err(|_| anyhow!("{} is outside the uploaded tree", p.display()))?
            .to_string_lossy()
            .replace('\\', "/"))
    };
    let mut builds = Vec::new();
    let mut bakes = BTreeMap::new();
    let mut laid = Vec::new();
    for i in images {
        let pending = format!("{}/{}:build", research_app::PENDING_IMAGE, i.app);
        let spec = app.services.iter().find(|s| s.image == pending);
        let context = work.join(&i.context);
        let source = work.join(&i.dockerfile);
        let text = std::fs::read_to_string(&source)
            .with_context(|| format!("no Dockerfile for {}", i.app))?;
        let mut text = qualified_bases(&text);
        let dir = format!("{OVERLAY_DIR}/{}", i.app);
        if let Some(spec) = spec {
            text.push_str(&spec.overlay(&dir));
            for (path, content) in spec.overlay_files() {
                write(&context.join(&dir).join(path), &content)?;
            }
        }
        // Research takes only `Dockerfile` or `<name>.dockerfile`.
        let dockerfile = context.join(format!("studio-{}.dockerfile", i.app));
        write(&dockerfile, &text)?;
        // The generated ignore file sits beside the generated Dockerfile; it
        // goes beside this one, and keeps what Studio lays out.
        let keep = format!("\n!{OVERLAY_DIR}/\n!{OVERLAY_DIR}/**\n");
        let generated = source.with_file_name("Dockerfile.dockerignore");
        let ignore = std::fs::read_to_string(&generated).ok();
        if let Some(ignore) = &ignore {
            write(
                &dockerfile.with_file_name(format!("studio-{}.dockerfile.dockerignore", i.app)),
                &format!("{ignore}{keep}"),
            )?;
        }
        let context_ignore = context.join(".dockerignore");
        match std::fs::read_to_string(&context_ignore) {
            Ok(own) if !own.contains(&keep) => write(&context_ignore, &format!("{own}{keep}"))?,
            Ok(_) => {}
            Err(_) => {
                if let Some(ignore) = &ignore {
                    write(&context_ignore, &format!("{ignore}{keep}"))?;
                }
            }
        }
        builds.push(ImageBuild {
            key: i.app.clone(),
            name: research_app::image_name(&i.name),
            dockerfile: rel(&dockerfile)?,
        });
        laid.push(Laid {
            key: i.app.clone(),
            context: context.clone(),
            dockerfile: dockerfile.clone(),
        });
        bakes.insert(
            i.app.clone(),
            spec.map(|s| s.bake()).unwrap_or_else(|| "none".into()),
        );
    }
    for db in app.services.iter().filter(|s| s.database) {
        let dir = root.join(format!("{OVERLAY_DIR}-db")).join(&db.name);
        let mut text = qualified_bases(&format!("FROM {database_image}\n"));
        text.push_str(&db.overlay("."));
        for (path, content) in db.overlay_files() {
            write(&dir.join(path), &content)?;
        }
        let dockerfile = dir.join("Dockerfile");
        write(&dockerfile, &text)?;
        let key = research_app::database_key(&db.name);
        builds.push(ImageBuild {
            key: key.clone(),
            name: research_app::image_name(&format!("studio-db-{}", db.name)),
            dockerfile: rel(&dockerfile)?,
        });
        laid.push(Laid {
            key: key.clone(),
            context: dir.clone(),
            dockerfile: dockerfile.clone(),
        });
        bakes.insert(key, db.bake());
    }
    Ok((builds, bakes, laid))
}

/// Research builds images with buildah, which enforces fully qualified
/// image names: a short `FROM pgvector/pgvector:pg18` fails with "short-name
/// resolution enforced but cannot prompt without a TTY" (Research DEV,
/// 2026-11-23). Every `FROM` that names an image by a short name gets Docker
/// Hub's: `rust:1` becomes `docker.io/library/rust:1`, `a/b` becomes
/// `docker.io/a/b`. A name with a registry (a first part with `.` or `:`, or
/// `localhost`), `scratch`, one built from `${...}` and an earlier stage's
/// name stay as they are.
pub(crate) fn qualified_bases(dockerfile: &str) -> String {
    let mut stages: Vec<String> = Vec::new();
    let mut out = String::with_capacity(dockerfile.len() + 64);
    for line in dockerfile.split_inclusive('\n') {
        let trimmed = line.trim_start();
        let is_from = trimmed.len() > 5 && trimmed[..5].eq_ignore_ascii_case("FROM ");
        if !is_from {
            out.push_str(line);
            continue;
        }
        let indent = &line[..line.len() - trimmed.len()];
        let ending = if line.ends_with("\r\n") {
            "\r\n"
        } else if line.ends_with('\n') {
            "\n"
        } else {
            ""
        };
        let body = trimmed.trim_end_matches(['\r', '\n']);
        let mut words: Vec<String> = body.split_whitespace().map(str::to_owned).collect();
        // `FROM [--flag=...]* image [AS name]`
        let at = words
            .iter()
            .skip(1)
            .position(|w| !w.starts_with("--"))
            .map(|i| i + 1);
        if let Some(at) = at {
            let image = words[at].clone();
            let keep = image.contains('$')
                || image.eq_ignore_ascii_case("scratch")
                || stages.iter().any(|s| s.eq_ignore_ascii_case(&image));
            if !keep {
                words[at] = qualified_image(&image);
            }
            if let (Some(kw), Some(name)) = (words.get(at + 1), words.get(at + 2))
                && kw.eq_ignore_ascii_case("AS")
            {
                stages.push(name.clone());
            }
        }
        out.push_str(indent);
        out.push_str(&words.join(" "));
        out.push_str(ending);
    }
    out
}

/// `image` with Docker Hub's registry when it names none.
fn qualified_image(image: &str) -> String {
    let first = image.split('/').next().unwrap_or(image);
    let has_registry =
        image.contains('/') && (first.contains('.') || first.contains(':') || first == "localhost");
    if has_registry {
        image.to_owned()
    } else if image.contains('/') {
        format!("docker.io/{image}")
    } else {
        format!("docker.io/library/{image}")
    }
}

#[cfg(test)]
mod qualified_bases_tests {
    use super::qualified_bases;

    #[test]
    fn short_names_get_docker_hub_and_the_rest_stay() {
        let before = "FROM rust:1.97.0-bookworm AS build\n\
                      RUN cargo build\n\
                      FROM --platform=linux/amd64 debian:bookworm-slim\n\
                      COPY --from=build /a /a\n\
                      FROM build AS again\n\
                      FROM pgvector/pgvector:pg18\n\
                      FROM ghcr.io/org/app:1\n\
                      FROM localhost:5000/x\n\
                      FROM scratch\n\
                      FROM ${BASE}\n";
        let after = qualified_bases(before);
        let lines: Vec<&str> = after.lines().collect();
        assert_eq!(
            lines[0],
            "FROM docker.io/library/rust:1.97.0-bookworm AS build"
        );
        assert_eq!(lines[1], "RUN cargo build");
        assert_eq!(
            lines[2],
            "FROM --platform=linux/amd64 docker.io/library/debian:bookworm-slim"
        );
        assert_eq!(lines[3], "COPY --from=build /a /a");
        assert_eq!(lines[4], "FROM build AS again");
        assert_eq!(lines[5], "FROM docker.io/pgvector/pgvector:pg18");
        assert_eq!(lines[6], "FROM ghcr.io/org/app:1");
        assert_eq!(lines[7], "FROM localhost:5000/x");
        assert_eq!(lines[8], "FROM scratch");
        assert_eq!(lines[9], "FROM ${BASE}");
    }
}

/* ── build ── */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResearchBuildPayload {
    pub build_id: String,
    pub organization_id: Uuid,
    pub project_id: Uuid,
    /// The environment's `research` connection: used only by a run queued
    /// before `sign_in` was recorded.
    pub connection_id: Uuid,
    /// The requester's own sign-in, which the build uses.
    #[serde(default)]
    pub sign_in: Option<SignIn>,
    /// The Research project the images are built in.
    pub research_project: String,
    pub profile: String,
    pub product_file: String,
    pub repo: RepoRef,
    #[serde(default)]
    pub git_ref: Option<String>,
    #[serde(default)]
    pub records_in: Option<Uuid>,
    /// See [`build::BuildPayload::description_revision`] (ADR-0053 §2).
    #[serde(default)]
    pub description_revision: Option<i64>,
    #[serde(default)]
    pub description_text: Option<String>,
    /// Whose Research sign-in the build uses.
    #[serde(default)]
    pub requested_by: Option<Requester>,
    /// The application a deploy puts the build in, which is also the
    /// namespace its chart is rendered for. The build renders the chart as
    /// that deploy will, with the binding's values and secret keys.
    #[serde(default)]
    pub namespace: String,
    #[serde(default)]
    pub values: Option<serde_json::Value>,
    #[serde(default)]
    pub secret_keys: Vec<String>,
    /// What a database server's Postgres image is built from.
    #[serde(default)]
    pub database_image: Option<String>,
}

/// How long one attempt of a build may take before it stops starting an
/// upload: an upload begun before then ends well inside the run queue's
/// fifteen-minute lease.
const UPLOAD_BY: Duration = Duration::from_secs(8 * 60);

/// How long one attempt follows the image builds before it hands them to
/// the next attempt (the way a gear match does), inside the lease.
const FOLLOW_FOR: Duration = Duration::from_secs(12 * 60);

/// Attempts a build gets: the desk's start and a wait for another build
/// holding it, then `Pace::RESEARCH.build_for` (90 minutes) of image builds,
/// twelve minutes an attempt, with room for attempts a restart cut short.
/// The build's own deadlines end it long before an attempt cap would.
const BUILD_ATTEMPTS: i16 = 30;

/// What the prepared tree said, kept once the images are asked for: a later
/// attempt follows them without preparing anything again.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Made {
    pub product: String,
    pub commit: String,
    #[serde(default)]
    pub lock_hash: Option<String>,
    /// Each image's [`research_app::ServiceSpec::bake`], by its key.
    #[serde(default)]
    pub bakes: BTreeMap<String, String>,
    /// Each image's content key ([`research_keys::image_keys`]).
    #[serde(default)]
    pub keys: BTreeMap<String, String>,
}

/// What a Research build keeps on its run between attempts, under
/// `resume` in the run's result.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Resume {
    #[serde(default)]
    pub made: Option<Made>,
    #[serde(default)]
    pub desk: DeskBuild,
}

impl Resume {
    /// What an earlier attempt of this run left; nothing on a first one (or
    /// a run from before builds were resumable).
    fn of(recorded: Option<&serde_json::Value>) -> Self {
        recorded
            .and_then(|r| r.get("resume"))
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default()
    }

    /// The images Research has for this build so far, as a record names
    /// them: each one asked for, built or not -- a build that failed after
    /// they were asked for keeps them, and may be deployed once they are
    /// all built ([`super::EnvironmentService::deploy_built_images`]).
    fn images(&self) -> Vec<(String, String)> {
        let Some(made) = &self.made else {
            return Vec::new();
        };
        self.desk
            .images
            .iter()
            .map(|b| {
                let bake = made.bakes.get(&b.key).cloned().unwrap_or_default();
                (
                    b.key.clone(),
                    research_app::image_reference(&bake, &b.name, &b.id),
                )
            })
            .collect()
    }

    /// The record of this build ended as `status` (`failed`, `cancelled`)
    /// for `why`, with what it had made.
    fn ended(
        &self,
        p: &ResearchBuildPayload,
        status: &str,
        why: &str,
        step: &str,
    ) -> crate::artifact_ingest::port::BuildOutcome {
        let mut out = crate::artifact_ingest::port::BuildOutcome::failed(
            &p.build_id,
            &p.repo.repo,
            &p.profile,
            why,
            step,
        );
        out.status = status.to_owned();
        out.images = self.images();
        if let Some(made) = &self.made {
            out.product = Some(made.product.clone());
            out.commit = Some(made.commit.clone());
            out.lock_hash.clone_from(&made.lock_hash);
            out.place.image_keys = research_keys::keys_field(&made.keys);
        }
        out
    }
}

/// How one attempt of a build ended.
enum Went {
    Built(Box<crate::artifact_ingest::port::BuildOutcome>),
    /// Not finished: the next attempt goes on from this.
    Later(Resume),
}

/// Why a build failed: its step, the words, and what it had made.
struct Stopped {
    step: String,
    why: String,
    resume: Resume,
}

pub struct ResearchBuildTask {
    hub: Arc<ClientHub>,
}

impl ResearchBuildTask {
    pub fn new(hub: Arc<ClientHub>) -> Self {
        Self { hub }
    }

    async fn record(
        &self,
        ctx: &SecurityContext,
        p: &ResearchBuildPayload,
        outcome: crate::artifact_ingest::port::BuildOutcome,
    ) {
        record_research(&self.hub, ctx, p, outcome).await;
    }

    async fn step(
        &self,
        ctx: &TaskContext,
        report: &Reporter<'_>,
        p: &ResearchBuildPayload,
        step: &'static str,
    ) {
        report.say(step.to_owned()).await;
        report.step(step).await;
        let mut running = crate::artifact_ingest::port::BuildOutcome::running(
            &p.build_id,
            &p.repo.repo,
            &p.profile,
        );
        running.step = Some(step.to_owned());
        self.record(&ctx.security, p, running).await;
    }

    /// The images earlier builds of the project made from the same inputs,
    /// that Research still has built: by key, what this build reuses.
    async fn reusable(
        &self,
        ctx: &TaskContext,
        api: &ResearchApi,
        p: &ResearchBuildPayload,
        keys: &BTreeMap<String, String>,
        report: &Reporter<'_>,
    ) -> Vec<Built> {
        let Ok(records) = self
            .hub
            .get::<dyn crate::artifact_ingest::port::BuildRecords>()
        else {
            return Vec::new();
        };
        let there = match p.records_in {
            Some(t) if t != ctx.security.subject_tenant_id() => {
                match super::store::service_context(t) {
                    Ok(c) => c,
                    Err(_) => return Vec::new(),
                }
            }
            _ => ctx.security.clone(),
        };
        let earlier = records
            .builds(&there, &p.project_id.to_string(), REUSE_LOOKS_AT)
            .await
            .unwrap_or_default();
        let mut found: BTreeMap<String, Built> = BTreeMap::new();
        for (app, image) in reuse_candidates(&p.build_id, keys, &earlier) {
            if found.contains_key(&app) {
                continue;
            }
            // Research's word, not the record's: built, and still there.
            if matches!(api.image(&image.id).await, Ok(i) if i.build_status == "done") {
                found.insert(
                    app.clone(),
                    Built {
                        key: app,
                        name: image.name,
                        id: image.id,
                    },
                );
            }
        }
        for b in found.values() {
            report
                .say(format!(
                    "{} is unchanged since an earlier build: reusing its image {}",
                    b.key, b.name
                ))
                .await;
        }
        found.into_values().collect()
    }

    async fn build(
        &self,
        ctx: &TaskContext,
        p: &ResearchBuildPayload,
        resume: Resume,
        hand_over: HandOver,
    ) -> Result<Went, Stopped> {
        use crate::artifact_ingest::port::BuildOutcome;
        let mut resume = resume;
        let stop = |step: &str, resume: &Resume| {
            let (step, resume) = (step.to_owned(), resume.clone());
            move |e: anyhow::Error| Stopped {
                step,
                why: format!("{e:#}"),
                resume,
            }
        };
        let sign_in = p.sign_in.unwrap_or(SignIn {
            tenant: p.organization_id,
            connection_id: p.connection_id,
        });
        let api = api(
            &self.hub,
            &ctx.security,
            sign_in.tenant,
            sign_in.connection_id,
            p.requested_by.as_ref(),
        )
        .await
        .map_err(stop("start", &resume))?;

        let report = Reporter::new(ctx);
        // The tree, while the images are not all asked for yet: prepared
        // again by every attempt that still needs it.
        let mut tree = None;
        let mut builds = Vec::new();
        if !resume.desk.submitted {
            self.step(ctx, &report, p, "prepare").await;
            let prepared = prepare(
                &self.hub,
                &ctx.security,
                &p.repo,
                p.git_ref.clone(),
                p.description_text
                    .clone()
                    .filter(|t| !t.trim().is_empty())
                    .map(|t| (p.description_revision, t)),
                &p.product_file,
                &p.profile,
            )
            .await
            .map_err(stop("prepare", &resume))?;
            let apps = std::fs::read_to_string(prepared.work.join("apps"))
                .map_err(|e| stop("prepare", &resume)(e.into()))?;
            let images = build_images(&apps, &prepared.work).map_err(stop("prepare", &resume))?;

            // The chart as the deploy will render it: what each image carries.
            let release = prepared.prepared.product.clone();
            let values = build_values(p.values.as_ref(), &images, &p.secret_keys, &release);
            let rendered = render(&prepared, &release, &p.namespace, &values)
                .await
                .map_err(stop("prepare", &resume))?;
            let database_image = p
                .database_image
                .clone()
                .unwrap_or_else(|| super::database::DEFAULT_IMAGE.to_owned());
            let any_secret = |_: &str, _: &str| Some(String::new());
            let no_password = |_: &str| String::new();
            let app = research_app::application_of(
                &rendered,
                &Inputs {
                    hardware: None,
                    secret: &any_secret,
                    database_password: &no_password,
                    database_image: &database_image,
                    namespace: &p.namespace,
                },
            )
            .map_err(|e| stop("prepare", &resume)(e.into()))?;
            let root = prepared.work.join("repo");
            let (all, bakes, laid) = lay_out(&prepared.work, &root, &images, &app, &database_image)
                .map_err(stop("prepare", &resume))?;
            let keys = {
                let (laid, salt) = (laid.clone(), p.research_project.clone());
                tokio::task::spawn_blocking(move || research_keys::image_keys(&laid, &salt))
                    .await
                    .map_err(|e| stop("prepare", &resume)(e.into()))?
                    .map_err(stop("prepare", &resume))?
            };
            resume.made = Some(Made {
                product: prepared.prepared.product.clone(),
                commit: prepared.prepared.commit.clone(),
                lock_hash: prepared.prepared.lock_hash.clone(),
                bakes,
                keys: keys.clone(),
            });
            // An image whose inputs an earlier build had, built: not again.
            if resume.desk.images.is_empty() {
                let reused = self.reusable(ctx, &api, p, &keys, &report).await;
                resume.desk = DeskBuild {
                    waiting_since: resume.desk.waiting_since,
                    started_desk: resume.desk.started_desk,
                    desk: resume.desk.desk.clone(),
                    ..DeskBuild::reusing(reused)
                };
            }
            let reused: std::collections::BTreeSet<&str> =
                resume.desk.images.iter().map(|b| b.key.as_str()).collect();
            builds = all
                .into_iter()
                .filter(|b| !reused.contains(b.key.as_str()))
                .collect();
            tree = Some((prepared, root));
        }

        // The build record's step stays `images` from here: the desk and the
        // upload are where Research builds them. The bar counts them apart.
        self.step(ctx, &report, p, "images").await;
        let made = resume.made.clone();
        let progress = |m: String| -> BoxFuture<'_, ()> { Box::pin(report.say(m)) };
        let measure = |m: Measured| -> BoxFuture<'_, ()> { Box::pin(report.measured(m)) };
        let checkpoint = |d: &DeskBuild| -> BoxFuture<'_, ()> {
            let kept = Resume {
                made: made.clone(),
                desk: d.clone(),
            };
            let value = serde_json::to_value(&kept).unwrap_or_default();
            Box::pin(report.checkpoint(value))
        };
        let cancelled = || ctx.cancel.is_cancelled();
        let went = api
            .desk_build(
                &p.research_project,
                tree.as_ref().map(|(_, root)| root.as_path()),
                &p.build_id,
                &builds,
                resume.desk.clone(),
                Pace::RESEARCH,
                hand_over,
                &progress,
                &measure,
                &checkpoint,
                &cancelled,
            )
            .await
            .map_err(stop("images", &resume))?;
        drop(tree);
        let built = match went {
            Followed::Built(built) => built,
            Followed::Later(desk) => {
                resume.desk = desk;
                report
                    .checkpoint(serde_json::to_value(&resume).unwrap_or_default())
                    .await;
                // Stopped by a person, not by a shutdown: let the desk go.
                if ctx.cancelled() && ctx.stop_requested().await {
                    api.end_desk_build(&resume.desk, &p.build_id, Pace::RESEARCH)
                        .await;
                    return Err(Stopped {
                        step: "images".into(),
                        why: "the build was cancelled".into(),
                        resume,
                    });
                }
                return Ok(Went::Later(resume));
            }
        };
        let made = resume.made.clone().unwrap_or_default();
        Ok(Went::Built(Box::new(BuildOutcome {
            build_id: p.build_id.clone(),
            status: "passed".into(),
            product: Some(made.product.clone()),
            profile: Some(p.profile.clone()),
            repository: Some(p.repo.repo.clone()),
            commit: Some(made.commit.clone()),
            lock_hash: made.lock_hash.clone(),
            images: built
                .into_iter()
                .map(|b| {
                    let bake = made.bakes.get(&b.key).cloned().unwrap_or_default();
                    let reference = research_app::image_reference(&bake, &b.name, &b.id);
                    (b.key, reference)
                })
                .collect(),
            place: crate::artifact_ingest::port::BuildPlace {
                image_keys: research_keys::keys_field(&made.keys),
                ..Default::default()
            },
            ..BuildOutcome::default()
        })))
    }
}

/// How many of a project's latest builds a build looks at for images to
/// reuse.
const REUSE_LOOKS_AT: usize = 20;

/// The images of `earlier` builds (newest first) made from what build
/// `build_id`'s images are made of (`keys`): for each image, every earlier
/// one with the same key, newest first. Whether Research still has one
/// built is asked of Research.
pub(super) fn reuse_candidates(
    build_id: &str,
    keys: &BTreeMap<String, String>,
    earlier: &[crate::artifact_ingest::port::BuildRecord],
) -> Vec<(String, research_app::ImageRef)> {
    let mut out = Vec::new();
    for r in earlier
        .iter()
        .filter(|r| r.build_id != build_id && r.r#where.as_deref() == Some("research"))
    {
        let theirs = research_keys::keys_of(r.place.image_keys.as_deref());
        for (app, reference) in &r.images {
            let same = keys.get(app).is_some_and(|k| theirs.get(app) == Some(k));
            if let (true, Some(image)) = (same, research_app::image_ref(reference)) {
                out.push((app.clone(), image));
            }
        }
    }
    out
}

/// Record `outcome` of the Research build `p` on the project.
pub(super) async fn record_research(
    hub: &Arc<ClientHub>,
    ctx: &SecurityContext,
    p: &ResearchBuildPayload,
    outcome: crate::artifact_ingest::port::BuildOutcome,
) {
    let outcome = crate::artifact_ingest::port::BuildOutcome {
        r#where: Some("research".into()),
        description_revision: outcome.description_revision.or(p.description_revision),
        ..outcome
    };
    if let Err(e) = build::record_outcome(hub, ctx, p.records_in, p.project_id, outcome).await {
        tracing::warn!(build = %p.build_id, error = %e, "studio-environments: a Research build could not be recorded");
    }
}

/// What a build whose run ended without it -- given up on by the queue,
/// cancelled, out of attempts -- records: failed (or cancelled), saying
/// Studio stopped following it, with the images it had asked for.
pub(super) fn ended_without_run(
    p: &ResearchBuildPayload,
    recorded: Option<&serde_json::Value>,
    cancelled: bool,
    reason: &str,
) -> crate::artifact_ingest::port::BuildOutcome {
    let resume = Resume::of(recorded);
    if cancelled {
        return resume.ended(p, "cancelled", "the build was cancelled", "images");
    }
    resume.ended(
        p,
        "failed",
        &format!(
            "Studio stopped following the build in Constructor Research: {reason}. Research may \
             still finish its images; build again, or deploy these images once they are built"
        ),
        "images",
    )
}

#[async_trait]
impl TaskHandler for ResearchBuildTask {
    fn task_type(&self) -> &'static str {
        BUILD_TASK_TYPE
    }

    fn max_attempts(&self) -> i16 {
        BUILD_ATTEMPTS
    }

    async fn run(&self, ctx: &TaskContext) -> TaskOutcome {
        let p: ResearchBuildPayload = match serde_json::from_value(ctx.payload.clone()) {
            Ok(p) => p,
            Err(e) => {
                return TaskOutcome::Failed(format!(
                    "this run's payload is not a Research build ({e})"
                ));
            }
        };
        let resume = Resume::of(ctx.recorded.as_ref());
        let now = tokio::time::Instant::now();
        let hand_over = HandOver {
            upload_by: now + UPLOAD_BY,
            follow_until: now + FOLLOW_FOR,
        };
        match self.build(ctx, &p, resume, hand_over).await {
            Ok(Went::Built(outcome)) => {
                let images = outcome.images.len();
                self.record(&ctx.security, &p, *outcome).await;
                TaskOutcome::done_with(
                    format!(
                        "Constructor Research built {images} image(s) of {}",
                        p.repo.repo
                    ),
                    serde_json::json!({}),
                )
            }
            Ok(Went::Later(resume)) if ctx.attempt >= self.max_attempts() => {
                let why = format!(
                    "Constructor Research had not built every image after {} attempts",
                    ctx.attempt
                );
                let ended = resume.ended(&p, "failed", &why, "images");
                self.record(&ctx.security, &p, ended).await;
                TaskOutcome::Failed(why)
            }
            // Handed over: the run goes on in its next attempt, from what
            // this one kept. A shutdown hands over the same way.
            Ok(Went::Later(_)) => TaskOutcome::Retry(
                "still building in Constructor Research; the next attempt follows it".into(),
            ),
            Err(Stopped { step, why, resume }) => {
                let status = if ctx.cancelled() && ctx.stop_requested().await {
                    "cancelled"
                } else {
                    "failed"
                };
                let ended = resume.ended(&p, status, &why, &step);
                self.record(&ctx.security, &p, ended).await;
                TaskOutcome::Failed(why)
            }
        }
    }

    /// The queue gave up on the run (or it was cancelled before it could
    /// say so): the build's record must not say `running` for ever.
    async fn ended_by_queue(&self, ended: &crate::tasks::sdk::EndedByQueue<'_>) {
        let Ok(p) = serde_json::from_value::<ResearchBuildPayload>(ended.payload.clone()) else {
            return;
        };
        let outcome = ended_without_run(&p, ended.recorded, ended.cancelled, ended.reason);
        record_research(&self.hub, ended.security, &p, outcome).await;
    }
}

/* ── deploy ── */

/// What a deploy to a Research environment needs beyond a cluster deploy's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResearchDeploy {
    pub research_project: String,
    #[serde(default)]
    pub hardware: Option<String>,
    /// The product's repository and description, prepared again at `commit`.
    pub repo: RepoRef,
    pub product_file: String,
    pub profile: String,
    pub commit: String,
    /// Whose Research sign-in the deploy uses.
    #[serde(default)]
    pub requested_by: Option<Requester>,
    /// Their own connection; absent in a deploy queued before it was kept,
    /// which uses the environment's.
    #[serde(default)]
    pub sign_in: Option<SignIn>,
    /// The description revision Studio keeps (ADR-0053 §2), as the build
    /// took it: a product whose description lives only in Studio has no file
    /// in the checkout to render the chart from. Absent in a deploy queued
    /// before it was kept, and for a product described only by its file.
    #[serde(default)]
    pub description_revision: Option<i64>,
    #[serde(default)]
    pub description_text: Option<String>,
}

/// The credstore reference of a database server's password: kept, since the
/// Postgres volume keeps the password it was first started with.
fn database_password_ref(project: Uuid, environment: Uuid, host: &str) -> String {
    format!("studio-env-database-{project}-{environment}-{host}")
}

async fn credstore_text(
    credstore: &dyn credstore_sdk::CredStoreClientV1,
    ctx: &SecurityContext,
    reference: &str,
) -> anyhow::Result<Option<String>> {
    let sref = credstore_sdk::SecretRef::new(reference)
        .map_err(|e| anyhow!("bad secret reference {reference}: {e}"))?;
    let value = credstore
        .get(ctx, &sref)
        .await
        .map_err(|e| anyhow!("credstore: {e}"))?;
    value
        .map(|v| {
            String::from_utf8(v.value.as_bytes().to_vec())
                .map_err(|_| anyhow!("{reference} is not text"))
        })
        .transpose()
}

/// The password of each database server the chart names, made once and kept.
async fn database_passwords(
    hub: &Arc<ClientHub>,
    ctx: &SecurityContext,
    project: Uuid,
    environment: Uuid,
    rendered: &str,
) -> anyhow::Result<BTreeMap<String, String>> {
    let credstore = hub
        .get::<dyn credstore_sdk::CredStoreClientV1>()
        .map_err(|_| anyhow!("credstore is not available in this deployment"))?;
    let mut out = BTreeMap::new();
    for need in super::database::needs(rendered)? {
        let reference = database_password_ref(project, environment, &need.host);
        let password = match credstore_text(credstore.as_ref(), ctx, &reference).await? {
            Some(p) => p,
            None => {
                let fresh = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
                let sref = credstore_sdk::SecretRef::new(&reference).map_err(|e| anyhow!("{e}"))?;
                credstore
                    .create(
                        ctx,
                        &sref,
                        credstore_sdk::SecretValue::new(fresh.clone().into_bytes()),
                        credstore_sdk::SharingMode::Tenant,
                    )
                    .await
                    .map_err(|e| anyhow!("the database password could not be kept: {e}"))?;
                fresh
            }
        };
        out.insert(need.host, password);
    }
    Ok(out)
}

/// The image a deploy's values give `key` (`{key: {image: {repository, tag}}}`).
fn values_image(values: &serde_json::Value, key: &str) -> Option<String> {
    let image = values.get(key)?.get("image")?;
    let repository = image.get("repository")?.as_str()?;
    Some(match image.get("tag").and_then(|t| t.as_str()) {
        Some(tag) => format!("{repository}:{tag}"),
        None => repository.to_owned(),
    })
}

/// Each service of `app` as Research's API takes it, on `hardware`, with its
/// image read back from the build: what the person should know beside.
fn service_bodies(
    app: &Application,
    values: &serde_json::Value,
    hardware: &str,
) -> anyhow::Result<(
    Vec<crate::connectors::sdk::research::ServiceBody>,
    Vec<String>,
)> {
    let mut bodies = Vec::new();
    let mut notes = Vec::new();
    let mut secrets = 0;
    for spec in &app.services {
        let reference = if spec.database {
            values_image(values, &research_app::database_key(&spec.name))
        } else {
            Some(spec.image.clone())
        };
        let image = reference
            .as_deref()
            .and_then(research_app::image_ref)
            .ok_or_else(|| {
                anyhow!(
                    "{} would run {}, which is not an image Constructor Research built for this \
                     product: deploy a build made in Research (a build made before Studio called \
                     Research's own API must be made again)",
                    spec.name,
                    reference.as_deref().unwrap_or("no image")
                )
            })?;
        if image.bake != spec.bake() {
            bail!(
                "what {} carries in its image -- the files the chart mounts, its command, its \
                 scratch folders -- is not what this deploy's chart asks for: the product's \
                 configuration for this environment changed since the build. Build again, then \
                 deploy that build",
                spec.name
            );
        }
        secrets += spec.secret_env.len();
        let (body, more) = spec.body(&image.id, hardware)?;
        notes.extend(more);
        bodies.push(body);
    }
    if secrets > 0 {
        notes.insert(
            0,
            format!(
                "{secrets} secret value(s) are plain environment variables in Constructor \
                 Research: its public API keeps no secret variables, and shows them to whoever \
                 can open the service"
            ),
        );
    }
    Ok((bodies, notes))
}

/// What a deploy keeps on its run between attempts, under `resume`: once
/// its services are put, a later attempt only follows them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeployResume {
    #[serde(default)]
    pub app: AppDeploy,
    /// What the person should know beside, said when it ends.
    #[serde(default)]
    pub notes: Vec<String>,
}

/// How one attempt of a deploy ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Deployed {
    /// Where the product opens, in words.
    Done(String),
    /// The services are not all running yet (or the run was stopped): the
    /// next attempt follows them from what this one kept.
    Later,
}

/// How long one attempt of a deploy follows its services before it hands
/// them to the next, inside the queue's lease (with the minute the
/// readiness watch takes after).
const DEPLOY_FOLLOW_FOR: Duration = Duration::from_secs(11 * 60);

/// Install `p` into its Research environment; where the product opens.
pub async fn deploy(
    hub: &Arc<ClientHub>,
    ctx: &TaskContext,
    p: &super::deploy::DeployPayload,
    r: &ResearchDeploy,
) -> anyhow::Result<Deployed> {
    let follow_until = tokio::time::Instant::now() + DEPLOY_FOLLOW_FOR;
    deploy_until(hub, ctx, p, r, follow_until).await
}

async fn deploy_until(
    hub: &Arc<ClientHub>,
    ctx: &TaskContext,
    p: &super::deploy::DeployPayload,
    r: &ResearchDeploy,
    follow_until: tokio::time::Instant,
) -> anyhow::Result<Deployed> {
    let sign_in = r.sign_in.unwrap_or(SignIn {
        tenant: p.organization_id,
        connection_id: p.connection_id,
    });
    let api = api(
        hub,
        &ctx.security,
        sign_in.tenant,
        sign_in.connection_id,
        r.requested_by.as_ref(),
    )
    .await?;
    let progress = |m: String| -> BoxFuture<'_, ()> { Box::pin(ctx.progress(m)) };
    if p.action == super::model::DeploymentAction::Uninstall {
        ctx.progress(format!("removing application {}", p.namespace))
            .await;
        return match api
            .application_named(&r.research_project, &p.namespace)
            .await?
        {
            Some(app) => {
                api.delete_application(&app.id).await?;
                Ok(Deployed::Done(format!(
                    "{} removed from Constructor Research",
                    p.namespace
                )))
            }
            None => Ok(Deployed::Done(format!(
                "{} was not in Constructor Research: nothing to remove",
                p.namespace
            ))),
        };
    }

    let report = Reporter::new(ctx);
    let mut resume: DeployResume = super::research_progress::resumed(ctx)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    if resume.app.application.is_none() {
        resume = put(hub, ctx, p, r, &api, &report).await?;
        report
            .checkpoint(serde_json::to_value(&resume).unwrap_or_default())
            .await;
    } else {
        report
            .say("following the services an earlier attempt started".to_owned())
            .await;
        report.step("deploy").await;
    }
    // A stop (a person's, or a shutdown) ends the attempt here; the run
    // says which.
    let followed = tokio::select! {
        f = api.follow_start(&resume.app, Pace::RESEARCH, follow_until, &progress) => f?,
        () = ctx.cancel.cancelled() => None,
    };
    let Some(running) = followed else {
        return Ok(Deployed::Later);
    };
    let notes = resume.notes;
    let links = running.links();
    let at = if links.is_empty() {
        "no public address".to_owned()
    } else {
        links.join(", ")
    };
    let noted = if notes.is_empty() {
        String::new()
    } else {
        format!(" (note: {})", notes.join("; "))
    };
    // Running is not ready, and a container that crashes is replaced with
    // its log: for a minute, ask the public links and follow every log.
    report
        .say(
            "watching the services for a minute: whether their public addresses answer and \
             whether they restart"
                .to_owned(),
        )
        .await;
    report.step("ready").await;
    let until = tokio::time::Instant::now() + Pace::RESEARCH.ready_for;
    let (silent, watched) = tokio::join!(
        api.unanswered(&running, Pace::RESEARCH),
        futures_util::future::join_all(running.services.iter().map(|s| api.watch_log(
            &s.id,
            until,
            std::time::Duration::from_secs(2)
        ))),
    );
    let watched: BTreeMap<&str, Watched> = running
        .services
        .iter()
        .map(|s| s.id.as_str())
        .zip(watched)
        .collect();
    let mut seen = Vec::new();
    for s in &running.services {
        if let Some(w) = watched.get(s.id.as_str())
            && w.restarts > 0
        {
            seen.push(restarted(&s.name, w));
        }
    }
    for s in &silent {
        let log = watched
            .get(s.id.as_str())
            .and_then(|w| last_lines(&w.lines));
        seen.push(not_answering(s, log));
    }
    let watch = if seen.is_empty() {
        String::new()
    } else {
        format!(". After it started: {}", seen.join("; "))
    };
    Ok(Deployed::Done(format!(
        "{} runs in Constructor Research: {at}{noted}{watch}",
        p.namespace
    )))
}

/// The first half of a deploy: the product prepared at the build's commit,
/// its chart rendered, and the application's services put and started.
async fn put(
    hub: &Arc<ClientHub>,
    ctx: &TaskContext,
    p: &super::deploy::DeployPayload,
    r: &ResearchDeploy,
    api: &ResearchApi,
    report: &Reporter<'_>,
) -> anyhow::Result<DeployResume> {
    let progress = |m: String| -> BoxFuture<'_, ()> { Box::pin(ctx.progress(m)) };
    report
        .say(format!(
            "preparing {} at {}",
            r.repo.repo,
            &r.commit[..r.commit.len().min(12)]
        ))
        .await;
    report.step("deploy").await;
    let tree = prepare(
        hub,
        &ctx.security,
        &r.repo,
        Some(r.commit.clone()),
        // The chart is rendered from the revision the build took, laid at
        // the product's path, as the build laid it (ADR-0053 §2); else from
        // the checkout's file at the build's commit.
        r.description_text
            .clone()
            .filter(|t| !t.trim().is_empty())
            .map(|t| (r.description_revision, t)),
        &r.product_file,
        &r.profile,
    )
    .await?;

    ctx.progress("rendering the chart").await;
    let rendered = render(&tree, &p.release, &p.namespace, &p.values).await?;

    let credstore = hub
        .get::<dyn credstore_sdk::CredStoreClientV1>()
        .map_err(|_| anyhow!("credstore is not available in this deployment"))?;
    let config_name = super::model::config_secret_name(&p.release);
    let mut config = BTreeMap::new();
    for key in &p.secret_keys {
        let reference = super::model::config_secret_ref(p.project_id, p.environment_id, key);
        let value = credstore_text(credstore.as_ref(), &ctx.security, &reference)
            .await?
            .ok_or_else(|| anyhow!("configuration secret {key} has no value: set it again"))?;
        config.insert(key.clone(), value);
    }
    let passwords = database_passwords(
        hub,
        &ctx.security,
        p.project_id,
        p.environment_id,
        &rendered,
    )
    .await?;
    let secret = |name: &str, key: &str| {
        (name == config_name)
            .then(|| config.get(key).cloned())
            .flatten()
    };
    let password = |host: &str| passwords.get(host).cloned().unwrap_or_default();
    let image = p
        .database_image
        .clone()
        .unwrap_or_else(|| super::database::DEFAULT_IMAGE.to_owned());
    let app: Application = research_app::application_of(
        &rendered,
        &Inputs {
            hardware: r.hardware.as_deref(),
            secret: &secret,
            database_password: &password,
            database_image: &image,
            namespace: &p.namespace,
        },
    )?;

    let hardware = match &r.hardware {
        Some(h) => h.clone(),
        None => {
            let offered = api.hardware(&r.research_project).await?;
            let h = crate::connectors::sdk::research::smallest(&offered).ok_or_else(|| {
                anyhow!("the Research project offers no hardware to run the services on")
            })?;
            ctx.progress(format!(
                "the environment names no hardware: the services run on {}",
                h.name
            ))
            .await;
            h.id.clone()
        }
    };
    let (bodies, notes) = service_bodies(&app, &p.values, &hardware)?;
    for note in &notes {
        ctx.progress(note.clone()).await;
    }
    let app = api
        .put_services(
            &r.research_project,
            &p.namespace,
            &bodies,
            Pace::RESEARCH,
            &progress,
        )
        .await?;
    Ok(DeployResume { app, notes })
}

/// The last twenty of `lines`, one string; `None` for none.
fn last_lines(lines: &[String]) -> Option<String> {
    (!lines.is_empty()).then(|| lines[lines.len().saturating_sub(20)..].join("\n"))
}

/// What a service whose container was replaced while watched says: how often,
/// and what the container before printed, which Research no longer has.
fn restarted(name: &str, w: &Watched) -> String {
    let times = if w.restarts == 1 {
        "once".to_owned()
    } else {
        format!("{} times", w.restarts)
    };
    match last_lines(&w.before) {
        Some(log) => format!(
            "{name} restarted {times} within a minute; the container before it printed:\n{log}"
        ),
        None => format!(
            "{name} restarted {times} within a minute, and the container before it printed nothing"
        ),
    }
}

/// What a service whose public link does not answer says, with what its log
/// says. A service whose log is empty has a container that stops before it
/// prints anything: Research keeps no log of a container once it is gone.
fn not_answering(s: &Service, log: Option<String>) -> String {
    let at = s.link.as_deref().unwrap_or_default();
    match log {
        Some(log) => format!(
            "{} does not answer at {at} within a minute; its last log lines:\n{log}",
            s.name
        ),
        None => format!(
            "{} does not answer at {at} within a minute, and its log is empty: \
             a container that exits before it prints anything (an entrypoint \
             script that is not executable, a wrong entrypoint path), or one \
             that listens on 127.0.0.1 or on another port than the service's",
            s.name
        ),
    }
}

/// A Research application as a release's rollout: each service a workload,
/// its public links the hosts.
pub async fn rollout(
    api: &ResearchApi,
    project: &str,
    application: &str,
) -> anyhow::Result<super::deploy::Rollout> {
    let Some(app) = api.application_named(project, application).await? else {
        return Ok(super::deploy::Rollout {
            hosts: Vec::new(),
            workloads: Vec::new(),
            problems: Vec::new(),
        });
    };
    Ok(super::deploy::Rollout {
        problems: Vec::new(),
        hosts: app.links(),
        workloads: app
            .services
            .into_iter()
            .map(|s| super::deploy::Workload {
                ready: i32::from(s.status == "running"),
                desired: 1,
                name: s.name,
                images: Vec::new(),
            })
            .collect(),
    })
}

/// The end of each service's log of the environment's application, read with
/// the caller's sign-in. A service Research has no log for yet says so rather
/// than being left out, so the reader sees every service. The services are
/// read at once (each read takes up to ten seconds) and listed in their own
/// order. A read Research refused says so, not that there is no log; when
/// every read failed, the first failure is the answer.
pub async fn logs(
    api: &ResearchApi,
    project: &str,
    application: &str,
    lines: usize,
) -> anyhow::Result<Vec<super::deploy::ContainerLog>> {
    let Some(app) = api.application_named(project, application).await? else {
        bail!("Constructor Research has no application {application} in this project");
    };
    let tails = futures_util::future::join_all(
        app.services
            .iter()
            .map(|s| api.service_log_tail(&s.id, lines)),
    )
    .await;
    if !tails.is_empty() && tails.iter().all(Result::is_err) {
        let first = tails.into_iter().find_map(Result::err);
        return Err(first
            .unwrap_or_else(|| anyhow!("no service log could be read"))
            .context("reading the environment's logs"));
    }
    Ok(app
        .services
        .into_iter()
        .zip(tails)
        .map(|(s, tail)| super::deploy::ContainerLog {
            text: log_text(&s.name, tail),
            pod: s.name,
            container: "main".to_owned(),
            previous: false,
        })
        .collect())
}

/// What a service's log entry says: its tail, that Research has none, or
/// why it could not be read.
fn log_text(service: &str, tail: anyhow::Result<Option<String>>) -> String {
    match tail {
        Ok(Some(text)) => text,
        Ok(None) => format!("(Constructor Research has no log of {service} now)"),
        Err(e) => format!("(Studio could not read the log of {service}: {e:#})"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_generated_ui_gets_its_image_as_one_string_and_no_configuration_secret() {
        // Seen on Research DEV, 2026-11-18: `helm template` refused
        // `ui.image: Invalid type. Expected: string, given: object`.
        let image = |app: &str, name: &str| BuildImage {
            app: app.into(),
            name: name.into(),
            dockerfile: "Dockerfile".into(),
            context: ".".into(),
        };
        let images = [
            image("api-gateway", "gbx-studioweb-api-gateway"),
            image("ui", "gbx-studioweb-frontend"),
        ];
        let v = build_values(None, &images, &["K".into()], "studioweb");
        assert_eq!(
            v["ui"],
            serde_json::json!({ "image": format!("{}/ui:build", research_app::PENDING_IMAGE) })
        );
        assert_eq!(
            v["api-gateway"]["image"]["repository"],
            format!("{}/api-gateway", research_app::PENDING_IMAGE)
        );
        assert!(v["api-gateway"]["existingSecret"].is_string());
        // A repository's own `ui` image keeps the usual keys.
        let own = build_values(None, &[image("ui", "shop-web")], &[], "shop");
        assert_eq!(own["ui"]["image"]["tag"], "build");
    }

    #[test]
    fn a_restarted_service_says_how_often_and_what_the_container_before_printed() {
        let w = Watched {
            lines: vec!["10:11 up".into()],
            restarts: 2,
            before: vec!["10:00 up".into(), "10:01 panic: no config".into()],
        };
        assert_eq!(
            restarted("web", &w),
            "web restarted 2 times within a minute; the container before it printed:\n\
             10:00 up\n10:01 panic: no config"
        );
        let quiet = Watched {
            restarts: 1,
            ..Watched::default()
        };
        assert_eq!(
            restarted("web", &quiet),
            "web restarted once within a minute, and the container before it printed nothing"
        );
    }

    #[test]
    fn a_service_that_does_not_answer_says_its_log_or_why_it_has_none() {
        let s: Service = serde_json::from_value(serde_json::json!({
            "id": "s-web", "name": "web", "status": "running", "link": "https://web.example"
        }))
        .unwrap();
        assert_eq!(
            not_answering(&s, Some("listening on 127.0.0.1:8080".into())),
            "web does not answer at https://web.example within a minute; its last log lines:\nlistening on 127.0.0.1:8080"
        );
        let empty = not_answering(&s, None);
        assert!(
            empty.starts_with(
                "web does not answer at https://web.example within a minute, and its log is empty: "
            ),
            "{empty}"
        );
        assert!(empty.contains("not executable"), "{empty}");
    }

    #[test]
    fn the_images_prepare_listed_are_named_inside_the_tree() {
        let work = Path::new("/tmp/studio-research-1");
        let apps = "api-gateway gbx-api-gateway /tmp/studio-research-1/repo/.gearbox/out/docker/api-gateway /tmp/studio-research-1/repo\n";
        let images = build_images(apps, work).unwrap();
        assert_eq!(
            images,
            [BuildImage {
                app: "api-gateway".into(),
                name: "gbx-api-gateway".into(),
                dockerfile: "repo/.gearbox/out/docker/api-gateway/Dockerfile".into(),
                context: "repo".into(),
            }]
        );
        assert!(build_images("api /elsewhere/docker /elsewhere x\n", work).is_err());
        assert!(build_images("api gbx /tmp/studio-research-1/a /etc\n", work).is_err());
    }

    const CHART: &str = r#"
apiVersion: v1
kind: ConfigMap
metadata: { name: shop-config }
data:
  shop.yaml: |
    database:
      host: postgres
      port: 5432
    listen: 0.0.0.0:8087
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: shop }
spec:
  template:
    metadata: { labels: { app: shop } }
    spec:
      securityContext: { runAsUser: 65532 }
      containers:
        - name: shop
          image: studio-research-pending/shop:build
          command: [gbx-shop]
          args: [--config, /etc/shop/shop.yaml]
          ports: [{ name: rest, containerPort: 8087 }]
          env:
            - { name: DATABASE_URL, value: "postgres://app@postgres:5432/shop" }
          volumeMounts:
            - { name: config, mountPath: /etc/shop/shop.yaml, subPath: shop.yaml }
            - { name: home, mountPath: /var/lib/shop }
      volumes:
        - { name: config, configMap: { name: shop-config } }
        - { name: home, emptyDir: {} }
"#;

    fn shop(image: &str) -> Application {
        let none = |_: &str, _: &str| None;
        let pw = |_: &str| "pw".to_owned();
        research_app::application_of(
            &CHART.replace("studio-research-pending/shop:build", image),
            &Inputs {
                hardware: None,
                secret: &none,
                database_password: &pw,
                database_image: "postgres:18",
                namespace: "shop-dev",
            },
        )
        .unwrap()
    }

    #[test]
    fn a_build_lays_out_a_dockerfile_in_the_context_with_what_the_chart_mounts_baked_in() {
        let work = std::env::temp_dir().join(format!("research-lay-{}", Uuid::new_v4().simple()));
        let docker = work.join("repo/out/docker/shop");
        std::fs::create_dir_all(&docker).unwrap();
        std::fs::write(docker.join("Dockerfile"), "FROM debian:bookworm-slim\n").unwrap();
        std::fs::write(docker.join("Dockerfile.dockerignore"), "*\n!src\n").unwrap();
        let images = [BuildImage {
            app: "shop".into(),
            name: "gbx-shop".into(),
            dockerfile: "repo/out/docker/shop/Dockerfile".into(),
            context: "repo".into(),
        }];
        let app = shop("studio-research-pending/shop:build");
        let (builds, bakes, _) =
            lay_out(&work, &work.join("repo"), &images, &app, "postgres:18").unwrap();
        let read = |p: &str| std::fs::read_to_string(work.join(p)).unwrap();
        let dockerfile = read("repo/studio-shop.dockerfile");
        let config = read("repo/studio-research/shop/files/etc/shop/shop.yaml");
        let ignore = read("repo/.dockerignore");
        let _ = std::fs::remove_dir_all(&work);

        assert_eq!(
            builds,
            [ImageBuild {
                key: "shop".into(),
                name: "gbx-shop".into(),
                dockerfile: "studio-shop.dockerfile".into(),
            }]
        );
        assert_eq!(bakes["shop"], app.services[0].bake());
        assert!(dockerfile.starts_with("FROM docker.io/library/debian:bookworm-slim\n"));
        assert!(
            dockerfile.contains("COPY [\"studio-research/shop/files/\",\"/\"]\n"),
            "{dockerfile}"
        );
        assert!(
            dockerfile.contains(
                "COPY --chown=65532:65532 [\"studio-research/shop/scratch/\",\"/var/lib/shop/\"]\n"
            ),
            "{dockerfile}"
        );
        assert!(
            dockerfile.ends_with(
                "ENTRYPOINT [\"gbx-shop\"]\nCMD [\"--config\",\"/etc/shop/shop.yaml\"]\n"
            )
        );
        assert!(config.contains("listen: 0.0.0.0:8087"));
        assert!(ignore.starts_with("*\n!src\n") && ignore.contains("!studio-research/**"));
    }

    #[test]
    fn a_deploy_runs_the_build_s_image_and_refuses_one_whose_baked_files_changed() {
        let built = shop("studio-research-pending/shop:build");
        let bake = built.services[0].bake();
        let app = shop(&research_app::image_reference(&bake, "gbx-shop", "img-7"));
        assert_eq!(
            app.services[0].bake(),
            bake,
            "the image does not change what is baked"
        );
        let (bodies, notes) = service_bodies(&app, &serde_json::json!({}), "cpu-s").unwrap();
        assert_eq!(bodies[0].image_id, "img-7");
        assert_eq!(bodies[0].hardware_configuration_id, "cpu-s");
        assert_eq!(
            bodies[0].environment_variables[0].value, "postgres://app@postgres:5432/shop",
            "postgres is not one of this chart's services"
        );
        assert!(notes.is_empty(), "{notes:?}");

        let stale = shop(&research_app::image_reference(
            "0badbeef0bad",
            "gbx-shop",
            "img-7",
        ));
        let e = service_bodies(&stale, &serde_json::json!({}), "cpu-s")
            .unwrap_err()
            .to_string();
        assert!(e.contains("Build again"), "{e}");

        let foreign = shop("ghcr.io/acme/shop:1");
        let e = service_bodies(&foreign, &serde_json::json!({}), "cpu-s")
            .unwrap_err()
            .to_string();
        assert!(e.contains("not an image Constructor Research built"), "{e}");
    }
}
