//! The steps that make a project, and what each one asks before doing it.
//!
//! The order is the only order that works, and each probe reads the world
//! rather than remembering: that is what lets a second attempt heal a
//! half-finished project instead of building another beside it. The engine in
//! [`super::plan`] knows none of this — it only knows that a step can be
//! asked and can be run.
//!
//! ## The context keys
//!
//! These are the contract between one step and the next:
//!
//! | key | written by | read by |
//! |---|---|---|
//! | `tenant` | `tenant` | every step after it |
//! | `repo` | `repo` | `scaffold`, and the configuration's source url |
//! | `branch` | `repo` | — |
//! | `clone_url` | `repo` | `config`, as `source_git_url` |
//! | `document` | `spec` | — |

use std::sync::Arc;

use serde::Deserialize;
use uuid::Uuid;

use super::plan::{Context, Step};

/// What kind of project is being made, which decides which steps there are.
///
/// A gear project's whole purpose is a gear, and a gear needs a directory in a
/// repository before it is anything at all. A product ends at its App Spec
/// rather than at a list of components, because the questionnaire is what
/// turns prose into capabilities and capabilities are what the matcher reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// A gear, written into a repository of its own or an existing store.
    NewGears,
    /// A product assembled from gears.
    Product,
    /// An existing codebase brought in as it is.
    Existing,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::NewGears => "new_gears",
            Kind::Product => "product",
            Kind::Existing => "existing",
        }
    }
}

/// Everything the card asked for, as the run receives it.
#[derive(Debug, Clone, Deserialize)]
pub struct Request {
    /// The workspace the project hangs from.
    pub workspace_id: Uuid,
    pub name: String,
    pub kind: Kind,
    #[serde(default)]
    pub brief: String,
    /// `new` creates a repository; `existing` records one the person picked.
    #[serde(default)]
    pub repo_mode: Option<String>,
    #[serde(default)]
    pub repo_name: Option<String>,
    #[serde(default)]
    pub repo_owner: Option<String>,
    #[serde(default)]
    pub repo_is_org: bool,
    #[serde(default)]
    pub repo_private: bool,
    /// The repository to record, when one is being recorded rather than made.
    #[serde(default)]
    pub existing_repo: Option<String>,
    #[serde(default)]
    pub existing_branch: Option<String>,
    #[serde(default)]
    pub connection_id: Option<Uuid>,
    /// Where in the repository the starter gear goes, and what it is called.
    #[serde(default)]
    pub gear_dir: Option<String>,
    #[serde(default)]
    pub gear_slug: Option<String>,
    #[serde(default)]
    pub open_pr: bool,
    /// The document type a product project starts from.
    #[serde(default)]
    pub spec_type: Option<String>,
    /// Kits the card ticked. Part of creating the project, not something done
    /// to it afterwards — which is why they are a step rather than a follow-up.
    #[serde(default)]
    pub kits: Vec<String>,
}

impl Request {
    fn is_gear(&self) -> bool {
        self.kind == Kind::NewGears
    }
}

/// What the steps reach the rest of the assembly through, and as whom.
///
/// Every gear optional, and each absence costs ONE step rather than the run: a
/// deployment with no connector driver cannot make a repository, and saying so
/// on that step is more useful than refusing to create the project at all.
///
/// `security` is the caller's, carried from the run. A provisioning run acts
/// as the PERSON WHO ASKED FOR IT — there is no fabricating a context here,
/// and that is the point: every write it makes is one they could have made.
#[derive(Clone)]
pub struct Gears {
    pub security: toolkit_security::SecurityContext,
    pub tenants: Arc<dyn TenantWriter>,
    pub repos: Option<Arc<dyn crate::components_catalog::port::ProjectRepos>>,
    pub documents: Option<Arc<dyn crate::documents::port::DocumentAuthor>>,
    pub kits: Option<Arc<dyn crate::kit_registry::port::KitInstaller>>,
}

/// Making the tenant and writing its configuration.
///
/// Its own trait rather than the account-management client directly, so the
/// steps can be tested without one — the sequence is the thing being tested,
/// and a fake tenant writer is how the probes get exercised at all.
#[async_trait::async_trait]
pub trait TenantWriter: Send + Sync + 'static {
    /// A project of this name already under this workspace, if there is one.
    ///
    /// Reusing a same-named sibling is what heals a prior half-run and closes
    /// the "duplicate tenant on retry" race: the tenant is the one write that
    /// cannot be undone from here.
    async fn find_project(&self, workspace_id: Uuid, name: &str) -> anyhow::Result<Option<Uuid>>;

    async fn create_project(&self, workspace_id: Uuid, name: &str) -> anyhow::Result<Uuid>;

    /// Merge into the project's configuration. An overwriting write, so it is
    /// safe to repeat and needs no probe.
    async fn write_config(&self, project_id: Uuid, config: serde_json::Value)
    -> anyhow::Result<()>;
}

// ── the steps ────────────────────────────────────────────────────────────────

struct Tenant {
    gears: Gears,
    request: Request,
}

#[async_trait::async_trait]
impl Step for Tenant {
    fn key(&self) -> &str {
        "tenant"
    }
    fn label(&self) -> String {
        "Project tenant".to_owned()
    }

    async fn satisfied(&self, ctx: &mut Context) -> anyhow::Result<bool> {
        // A tenant this run already made, or one a previous attempt left.
        if ctx.contains_key("tenant") {
            return Ok(true);
        }
        // Found is not enough: every step after this one is ABOUT this id, so
        // the probe records it. Skipping the work and dropping what the work
        // would have produced is worse than not skipping it.
        match self
            .gears
            .tenants
            .find_project(self.request.workspace_id, &self.request.name)
            .await?
        {
            Some(found) => {
                ctx.insert("tenant".to_owned(), found.to_string());
                Ok(true)
            }
            None => Ok(false),
        }
    }

    async fn run(&self, ctx: &mut Context) -> anyhow::Result<()> {
        // Find-or-create rather than create: the probe above answers `false`
        // when it could not ask, and creating a second project of the same
        // name is the one mistake here that cannot be taken back.
        let id = match self
            .gears
            .tenants
            .find_project(self.request.workspace_id, &self.request.name)
            .await
        {
            Ok(Some(found)) => found,
            _ => {
                self.gears
                    .tenants
                    .create_project(self.request.workspace_id, &self.request.name)
                    .await?
            }
        };
        ctx.insert("tenant".to_owned(), id.to_string());
        Ok(())
    }
}

struct Config {
    gears: Gears,
    request: Request,
}

#[async_trait::async_trait]
impl Step for Config {
    fn key(&self) -> &str {
        "config"
    }
    fn label(&self) -> String {
        "Project config".to_owned()
    }

    // No probe: an overwriting write is cheap and re-running it is safe, and a
    // probe that read the config back would only tell us what we are about to
    // decide anyway.

    async fn run(&self, ctx: &mut Context) -> anyhow::Result<()> {
        let project = tenant_of(ctx)?;
        let mode = if self.request.kind == Kind::Existing {
            "modernize"
        } else {
            "greenfield"
        };
        let mut config = serde_json::json!({
            "mode": mode,
            "kind": self.request.kind.as_str(),
            "status": "draft",
        });
        if let Some(object) = config.as_object_mut() {
            if !self.request.brief.trim().is_empty() {
                object.insert(
                    "brief".to_owned(),
                    serde_json::Value::String(self.request.brief.trim().to_owned()),
                );
            }
            // Written only when the repository step has already found one —
            // the configuration is written BEFORE the repository, so on a
            // first run this is absent and a resume fills it in.
            if let Some(url) = ctx.get("clone_url") {
                object.insert(
                    "source_git_url".to_owned(),
                    serde_json::Value::String(url.clone()),
                );
            }
        }
        self.gears.tenants.write_config(project, config).await
    }
}

struct Repository {
    gears: Gears,
    request: Request,
}

#[async_trait::async_trait]
impl Step for Repository {
    fn key(&self) -> &str {
        "repo"
    }
    fn label(&self) -> String {
        match self.request.repo_mode.as_deref() {
            Some("existing") => "Gear store".to_owned(),
            _ => match &self.request.repo_name {
                Some(name) => format!("Repository · {name}"),
                None => "Repository".to_owned(),
            },
        }
    }

    async fn satisfied(&self, ctx: &mut Context) -> anyhow::Result<bool> {
        let project = tenant_of(ctx)?;
        let repos = self.repos()?;
        // An `Err` here propagates deliberately: "it has none" and "I could
        // not ask" must not be the same answer when the consequence of being
        // wrong is a second repository nobody asked for.
        match repos.attached_repo(&self.gears.security, project).await? {
            Some(repo) if !repo.is_empty() => {
                // Recorded, because the starter gear is written into THIS
                // repository and a skipped step that says nothing leaves it
                // with nowhere to go.
                ctx.insert("repo".to_owned(), repo);
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    async fn run(&self, ctx: &mut Context) -> anyhow::Result<()> {
        let project = tenant_of(ctx)?;
        let repos = self.repos()?;

        if self.request.repo_mode.as_deref() == Some("existing") {
            let repo = self
                .request
                .existing_repo
                .as_deref()
                .filter(|r| !r.is_empty())
                .ok_or_else(|| anyhow::anyhow!("no gear store was chosen"))?;
            let branch = self
                .request
                .existing_branch
                .as_deref()
                .filter(|b| !b.is_empty())
                .unwrap_or("main");
            repos
                .attach_repo(
                    &self.gears.security,
                    project,
                    self.request.workspace_id,
                    self.request.connection_id,
                    repo,
                    branch,
                )
                .await?;
            ctx.insert("repo".to_owned(), repo.to_owned());
            ctx.insert("branch".to_owned(), branch.to_owned());
            return Ok(());
        }

        let name = self
            .request
            .repo_name
            .as_deref()
            .filter(|n| !n.is_empty())
            .ok_or_else(|| anyhow::anyhow!("no repository name was given"))?;
        let created = repos
            .create_repo(
                &self.gears.security,
                project,
                &crate::components_catalog::port::NewRepo {
                    // The WORKSPACE's connection: a project made a minute ago
                    // has none of its own.
                    connection_tenant: self.request.workspace_id,
                    connection_id: self.request.connection_id,
                    owner: self
                        .request
                        .repo_owner
                        .clone()
                        .filter(|o| !o.trim().is_empty()),
                    is_org: self.request.repo_is_org,
                    name: name.to_owned(),
                    private: self.request.repo_private,
                },
            )
            .await?;
        ctx.insert("repo".to_owned(), created.full_name);
        ctx.insert("branch".to_owned(), created.default_branch);
        ctx.insert("clone_url".to_owned(), created.html_url);
        Ok(())
    }
}

impl Repository {
    fn repos(&self) -> anyhow::Result<Arc<dyn crate::components_catalog::port::ProjectRepos>> {
        self.gears.repos.clone().ok_or_else(|| {
            anyhow::anyhow!(
                "this deployment cannot create repositories \
                 (no connector driver is registered)"
            )
        })
    }
}

struct Starter {
    gears: Gears,
    request: Request,
}

#[async_trait::async_trait]
impl Step for Starter {
    fn key(&self) -> &str {
        "scaffold"
    }
    fn label(&self) -> String {
        match (&self.request.gear_dir, &self.request.gear_slug) {
            (Some(dir), Some(slug)) => format!("Starter gear · {dir}/{slug}"),
            _ => "Starter gear".to_owned(),
        }
    }

    // No probe, and this is the one step where that is a KNOWN limitation
    // rather than a decision: asking "is there already a gear in there?" means
    // reading the repository's tree, and the answer is a judgement about what
    // counts as this gear. A resume writes the skeleton onto a branch of its
    // own, so a second attempt costs a branch rather than a broken repository.

    async fn run(&self, ctx: &mut Context) -> anyhow::Result<()> {
        let project = tenant_of(ctx)?;
        let repos = self
            .gears
            .repos
            .clone()
            .ok_or_else(|| anyhow::anyhow!("this deployment cannot write to repositories"))?;
        let slug = self
            .request
            .gear_slug
            .as_deref()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| anyhow::anyhow!("no gear name was given"))?;
        repos
            .scaffold(
                &self.gears.security,
                project,
                &crate::components_catalog::port::Scaffold {
                    slug: slug.to_owned(),
                    app_title: self.request.name.clone(),
                    problem: self.request.brief.trim().to_owned(),
                    origin: "Scaffolded when the project was created.".to_owned(),
                    parent_dir: self.request.gear_dir.clone().unwrap_or_default(),
                    open_pr: self.request.open_pr,
                },
            )
            .await
    }
}

struct Spec {
    gears: Gears,
    request: Request,
}

#[async_trait::async_trait]
impl Step for Spec {
    fn key(&self) -> &str {
        "spec"
    }
    fn label(&self) -> String {
        "App Spec".to_owned()
    }

    async fn satisfied(&self, ctx: &mut Context) -> anyhow::Result<bool> {
        let project = tenant_of(ctx)?;
        let Some(documents) = self.gears.documents.clone() else {
            // Nothing to write it with; the step will say so when it runs.
            return Ok(false);
        };
        documents
            .has_document(&self.gears.security, project, self.spec_type())
            .await
    }

    async fn run(&self, ctx: &mut Context) -> anyhow::Result<()> {
        let project = tenant_of(ctx)?;
        let documents = self.gears.documents.clone().ok_or_else(|| {
            anyhow::anyhow!("this deployment has no documents database to write the spec into")
        })?;
        let id = documents
            .author(
                &self.gears.security,
                project,
                self.spec_type(),
                &self.request.name,
                Some(self.request.brief.clone()),
            )
            .await?;
        ctx.insert("document".to_owned(), id);
        Ok(())
    }
}

impl Spec {
    fn spec_type(&self) -> &str {
        self.request
            .spec_type
            .as_deref()
            .filter(|t| !t.is_empty())
            .unwrap_or("app_spec")
    }
}

struct Kits {
    gears: Gears,
    request: Request,
}

#[async_trait::async_trait]
impl Step for Kits {
    fn key(&self) -> &str {
        "kits"
    }
    fn label(&self) -> String {
        match self.request.kits.len() {
            1 => "Kit".to_owned(),
            n => format!("{n} kits"),
        }
    }

    async fn satisfied(&self, ctx: &mut Context) -> anyhow::Result<bool> {
        let project = tenant_of(ctx)?;
        let Some(kits) = self.gears.kits.clone() else {
            return Ok(false);
        };
        let already = kits.wanted(&self.gears.security, project).await?;
        // Every one of them, not any: a run interrupted after the second of
        // three must ask for the third.
        Ok(self
            .request
            .kits
            .iter()
            .all(|slug| already.iter().any(|w| w == slug)))
    }

    async fn run(&self, ctx: &mut Context) -> anyhow::Result<()> {
        let project = tenant_of(ctx)?;
        let kits = self.gears.kits.clone().ok_or_else(|| {
            anyhow::anyhow!("this deployment has no kit registry to install from")
        })?;
        // What is already wanted is skipped rather than re-requested, so a
        // resumed run does not reset a kit somebody has since changed.
        let already = kits
            .wanted(&self.gears.security, project)
            .await
            .unwrap_or_default();
        for slug in &self.request.kits {
            if already.iter().any(|w| w == slug) {
                continue;
            }
            // The catalogue decides the version, so a project made today and
            // one made tomorrow both get what the kit says is current.
            kits.want(&self.gears.security, project, slug, "").await?;
        }
        Ok(())
    }
}

/// The project id every step after the first is about.
fn tenant_of(ctx: &Context) -> anyhow::Result<Uuid> {
    let raw = ctx
        .get("tenant")
        .ok_or_else(|| anyhow::anyhow!("the project tenant was not created"))?;
    Ok(Uuid::parse_str(raw)?)
}

/// The plan for one request, in the order that works.
#[must_use]
pub fn plan_for(request: &Request, gears: &Gears) -> Vec<Box<dyn Step>> {
    let mut steps: Vec<Box<dyn Step>> = vec![
        Box::new(Tenant {
            gears: gears.clone(),
            request: request.clone(),
        }),
        Box::new(Config {
            gears: gears.clone(),
            request: request.clone(),
        }),
    ];

    // A gear project and a product both end in a repository; only a gear
    // project writes a starter gear into it, and only a product starts from a
    // document. An `existing` project brings its own and needs neither.
    if request.is_gear() || request.kind == Kind::Product {
        steps.push(Box::new(Repository {
            gears: gears.clone(),
            request: request.clone(),
        }));
    }
    if request.is_gear() {
        steps.push(Box::new(Starter {
            gears: gears.clone(),
            request: request.clone(),
        }));
    }
    if request.kind == Kind::Product && !request.brief.trim().is_empty() {
        steps.push(Box::new(Spec {
            gears: gears.clone(),
            request: request.clone(),
        }));
    }
    // Last, because a kit is installed INTO a project that already has its
    // repository — and because a person who ticked none should not see a step
    // that does nothing.
    if !request.kits.is_empty() {
        steps.push(Box::new(Kits {
            gears: gears.clone(),
            request: request.clone(),
        }));
    }
    steps
}

/// How many steps a payload's plan will have.
///
/// Read from the plan itself rather than counted a second time: a checklist
/// drawn from one count and filled by another is a checklist that can
/// disagree with itself halfway through.
///
/// `None` when the payload is not a project to create — the caller then says
/// nothing about the shape rather than guessing at it.
#[must_use]
pub fn step_count(payload: &serde_json::Value) -> Option<u32> {
    let request: Request = serde_json::from_value(payload.clone()).ok()?;
    // The gears are only consulted for what a step DOES; how many there are is
    // decided by the kind, so a count needs no gear at all.
    let gears = Gears {
        security: toolkit_security::SecurityContext::anonymous(),
        tenants: Arc::new(NoTenants),
        repos: None,
        documents: None,
        kits: None,
    };
    u32::try_from(plan_for(&request, &gears).len()).ok()
}

/// A tenant writer for a plan nobody is going to run.
struct NoTenants;

#[async_trait::async_trait]
impl TenantWriter for NoTenants {
    async fn find_project(&self, _: Uuid, _: &str) -> anyhow::Result<Option<Uuid>> {
        anyhow::bail!("counting a plan does not create anything")
    }
    async fn create_project(&self, _: Uuid, _: &str) -> anyhow::Result<Uuid> {
        anyhow::bail!("counting a plan does not create anything")
    }
    async fn write_config(&self, _: Uuid, _: serde_json::Value) -> anyhow::Result<()> {
        anyhow::bail!("counting a plan does not create anything")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeTenants {
        existing: Option<Uuid>,
        created: Mutex<Vec<String>>,
        configs: Mutex<Vec<serde_json::Value>>,
        find_fails: bool,
    }

    #[async_trait::async_trait]
    impl TenantWriter for FakeTenants {
        async fn find_project(&self, _: Uuid, _: &str) -> anyhow::Result<Option<Uuid>> {
            if self.find_fails {
                anyhow::bail!("account-management unreachable");
            }
            Ok(self.existing)
        }
        async fn create_project(&self, _: Uuid, name: &str) -> anyhow::Result<Uuid> {
            self.created
                .lock()
                .expect("not poisoned")
                .push(name.to_owned());
            Ok(Uuid::from_u128(7))
        }
        async fn write_config(&self, _: Uuid, config: serde_json::Value) -> anyhow::Result<()> {
            self.configs.lock().expect("not poisoned").push(config);
            Ok(())
        }
    }

    fn request(kind: Kind) -> Request {
        Request {
            workspace_id: Uuid::from_u128(1),
            name: "Billing".to_owned(),
            kind,
            brief: "A product that bills people.".to_owned(),
            repo_mode: Some("new".to_owned()),
            repo_name: Some("billing".to_owned()),
            repo_owner: None,
            repo_is_org: false,
            repo_private: true,
            existing_repo: None,
            existing_branch: None,
            connection_id: None,
            gear_dir: Some("gears/bss".to_owned()),
            gear_slug: Some("billing".to_owned()),
            open_pr: false,
            spec_type: None,
            kits: Vec::new(),
        }
    }

    fn gears(tenants: Arc<FakeTenants>) -> Gears {
        Gears {
            security: test_security(),
            tenants,
            repos: None,
            documents: None,
            kits: None,
        }
    }

    /// A context for the steps that do not reach a gear. The ones that do are
    /// exercised through their absence here, which is the case that matters:
    /// a deployment missing a gear must fail one step, not the run.
    fn test_security() -> toolkit_security::SecurityContext {
        toolkit_security::SecurityContext::anonymous()
    }

    // ---- which steps a kind gets -------------------------------------------

    #[test]
    fn a_gear_project_makes_a_repository_and_a_starter_gear() {
        let steps = plan_for(&request(Kind::NewGears), &gears(Arc::default()));
        let keys: Vec<&str> = steps.iter().map(|s| s.key()).collect();
        assert_eq!(keys, vec!["tenant", "config", "repo", "scaffold"]);
    }

    #[test]
    fn a_product_ends_at_its_spec_rather_than_at_a_list_of_components() {
        let steps = plan_for(&request(Kind::Product), &gears(Arc::default()));
        let keys: Vec<&str> = steps.iter().map(|s| s.key()).collect();
        assert_eq!(keys, vec!["tenant", "config", "repo", "spec"]);
    }

    #[test]
    fn a_product_with_nothing_written_in_the_brief_has_nothing_to_seed() {
        // The brief IS the answer to the questionnaire's first question, so an
        // empty one is not a document with an empty answer — it is no
        // document. The repository is not conditional on it: a product needs
        // somewhere to be assembled whatever anybody typed.
        let mut req = request(Kind::Product);
        req.brief = "   ".to_owned();
        let steps = plan_for(&req, &gears(Arc::default()));
        assert_eq!(
            steps.iter().map(|s| s.key()).collect::<Vec<_>>(),
            vec!["tenant", "config", "repo"]
        );
    }

    #[test]
    fn an_existing_codebase_brings_its_own_and_needs_neither() {
        let steps = plan_for(&request(Kind::Existing), &gears(Arc::default()));
        assert_eq!(
            steps.iter().map(|s| s.key()).collect::<Vec<_>>(),
            vec!["tenant", "config"]
        );
    }

    // ---- the tenant step ----------------------------------------------------

    #[tokio::test]
    async fn a_same_named_project_is_reused_rather_than_duplicated() {
        // This is what heals a prior half-run: the tenant is the one write
        // that cannot be taken back from here.
        let tenants = Arc::new(FakeTenants {
            existing: Some(Uuid::from_u128(42)),
            ..FakeTenants::default()
        });
        let steps = plan_for(&request(Kind::Existing), &gears(tenants.clone()));
        let mut ctx = Context::new();
        let outcome = super::super::plan::run(&steps, &mut ctx, &|_| {}).await;
        assert!(outcome.ok, "{:?}", outcome.failure());
        assert!(
            tenants.created.lock().expect("not poisoned").is_empty(),
            "nothing was created"
        );
    }

    #[tokio::test]
    async fn a_probe_that_cannot_reach_account_management_still_finds_before_creating() {
        // The step runs (the engine does not skip an unanswerable probe), and
        // the run itself asks again rather than creating blind.
        let tenants = Arc::new(FakeTenants {
            find_fails: true,
            ..FakeTenants::default()
        });
        let steps = plan_for(&request(Kind::Existing), &gears(tenants.clone()));
        let mut ctx = Context::new();
        let outcome = super::super::plan::run(&steps, &mut ctx, &|_| {}).await;
        assert!(outcome.ok, "{:?}", outcome.failure());
        // It could not find one, so it made one — which is the right answer
        // when the alternative is a project that does not exist.
        assert_eq!(tenants.created.lock().expect("not poisoned").len(), 1);
    }

    #[tokio::test]
    async fn a_tenant_already_in_the_context_is_not_looked_for_again() {
        let tenants = Arc::new(FakeTenants::default());
        let steps = plan_for(&request(Kind::Existing), &gears(tenants.clone()));
        let mut ctx = Context::new();
        ctx.insert("tenant".to_owned(), Uuid::from_u128(9).to_string());
        let outcome = super::super::plan::run(&steps, &mut ctx, &|_| {}).await;
        assert!(outcome.ok);
        assert!(tenants.created.lock().expect("not poisoned").is_empty());
    }

    // ---- the configuration --------------------------------------------------

    #[tokio::test]
    async fn the_configuration_says_which_kind_and_which_mode() {
        let tenants = Arc::new(FakeTenants::default());
        let steps = plan_for(&request(Kind::Existing), &gears(tenants.clone()));
        let mut ctx = Context::new();
        super::super::plan::run(&steps, &mut ctx, &|_| {}).await;
        let configs = tenants.configs.lock().expect("not poisoned");
        assert_eq!(configs[0]["kind"], "existing");
        // An existing codebase is being modernised; anything else is new.
        assert_eq!(configs[0]["mode"], "modernize");
        assert_eq!(configs[0]["status"], "draft");
        assert_eq!(configs[0]["brief"], "A product that bills people.");
    }

    #[tokio::test]
    async fn a_greenfield_kind_is_not_a_modernisation() {
        let tenants = Arc::new(FakeTenants::default());
        let steps = plan_for(&request(Kind::NewGears), &gears(tenants.clone()));
        let mut ctx = Context::new();
        super::super::plan::run(&steps, &mut ctx, &|_| {}).await;
        assert_eq!(
            tenants.configs.lock().expect("not poisoned")[0]["mode"],
            "greenfield"
        );
    }

    #[tokio::test]
    async fn the_clone_url_reaches_the_configuration_on_a_resume() {
        // The configuration is written BEFORE the repository, so a first run
        // cannot carry the url — and a resume must.
        let tenants = Arc::new(FakeTenants::default());
        let steps = plan_for(&request(Kind::Existing), &gears(tenants.clone()));
        let mut ctx = Context::new();
        ctx.insert("clone_url".to_owned(), "https://example/x".to_owned());
        super::super::plan::run(&steps, &mut ctx, &|_| {}).await;
        assert_eq!(
            tenants.configs.lock().expect("not poisoned")[0]["source_git_url"],
            "https://example/x"
        );
    }

    #[tokio::test]
    async fn a_step_that_needs_a_gear_this_deployment_lacks_fails_only_itself() {
        // No connector driver: the repository step says so, and the tenant and
        // configuration before it still happened.
        let tenants = Arc::new(FakeTenants::default());
        let steps = plan_for(&request(Kind::Product), &gears(tenants.clone()));
        let mut ctx = Context::new();
        let outcome = super::super::plan::run(&steps, &mut ctx, &|_| {}).await;
        assert!(!outcome.ok);
        let failed = outcome.failure().expect("the repository step");
        assert_eq!(failed.key, "repo");
        assert!(
            failed
                .error
                .as_deref()
                .unwrap()
                .contains("connector driver"),
            "{failed:?}"
        );
        assert_eq!(tenants.configs.lock().expect("not poisoned").len(), 1);
    }
    #[test]
    fn the_step_count_is_the_plan_and_not_a_second_opinion() {
        // The same payload the route enqueues, so the checklist a caller draws
        // before the first phase matches the one the run then reports.
        for (kind, expected) in [("new_gears", 4), ("product", 4), ("existing", 2)] {
            let payload = serde_json::json!({
                "workspace_id": Uuid::from_u128(1),
                "name": "Billing",
                "kind": kind,
                "brief": "A product that bills people.",
            });
            assert_eq!(step_count(&payload), Some(expected), "{kind}");
        }
    }

    #[test]
    fn a_payload_that_is_not_a_project_says_nothing_rather_than_guessing() {
        assert_eq!(step_count(&serde_json::json!({})), None);
        assert_eq!(step_count(&serde_json::json!("nonsense")), None);
    }
    #[test]
    fn kits_are_a_step_only_when_some_were_ticked() {
        // A person who ticked none should not watch a step that does nothing.
        let mut req = request(Kind::Existing);
        assert_eq!(
            plan_for(&req, &gears(Arc::default()))
                .iter()
                .map(|s| s.key())
                .collect::<Vec<_>>(),
            vec!["tenant", "config"]
        );
        req.kits = vec!["sdlc".to_owned()];
        assert_eq!(
            plan_for(&req, &gears(Arc::default()))
                .iter()
                .map(|s| s.key())
                .collect::<Vec<_>>(),
            vec!["tenant", "config", "kits"]
        );
    }

    #[test]
    fn the_kit_step_says_how_many_it_is_about() {
        let mut req = request(Kind::Existing);
        req.kits = vec!["a".to_owned()];
        let one = plan_for(&req, &gears(Arc::default()));
        assert_eq!(one.last().unwrap().label(), "Kit");
        req.kits.push("b".to_owned());
        let two = plan_for(&req, &gears(Arc::default()));
        assert_eq!(two.last().unwrap().label(), "2 kits");
    }
}
