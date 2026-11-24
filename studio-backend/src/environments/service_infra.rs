//! A project's infra services (ADR-0064): which ones its product runs, and
//! what a deploy to an environment will do with each.

use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::{EnvironmentService, Refusal, Result};
use crate::environments::BINDINGS_METADATA_TYPE;
use crate::environments::images;
use crate::environments::infra::{self, InfraInstall, InfraPlacement, InfraService, PlanItem};
use crate::environments::model::{BindingList, Environment, EnvironmentKind};

/// What a deploy of a project to one environment does with its infra
/// services.
#[derive(Debug, Clone)]
pub struct InfraPlan {
    pub environment_id: Uuid,
    pub environment_name: String,
    pub placement: infra::Placement,
    /// The namespace they run in with the product.
    pub namespace: String,
    pub items: Vec<PlanItem>,
    /// The configuration secrets of the environment that set a gear's
    /// config field the description also sets, and what a deploy does about
    /// each (a warning, or the refusal of an install).
    pub configuration: Vec<crate::environments::gear_overrides::Clash>,
}

/// Is `reference` (an image, or an `oci://` chart) under the project's path
/// `prefix` in `env`'s registry? An environment without a registry takes
/// images as named.
fn under_project(
    env: &Environment,
    prefix: &str,
    reference: &str,
) -> std::result::Result<(), String> {
    if env.registry.is_empty() || images::is_under(reference, prefix) {
        Ok(())
    } else {
        Err(format!(
            "'{reference}' is not under the project's path {prefix}: a deploy runs only images \
             and charts in the organization's registry; import it first (POST /images/imports)"
        ))
    }
}

impl EnvironmentService {
    /// The project's infra services.
    pub async fn project_infra(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
    ) -> Result<Vec<InfraService>> {
        self.organization_of_project(ctx, project).await?;
        Ok(self
            .store
            .read::<BindingList>(ctx, project, BINDINGS_METADATA_TYPE)
            .await?
            .0
            .infra)
    }

    /// Set the project's infra services, as a member who may write its
    /// settings.
    pub async fn put_project_infra(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        services: Vec<InfraService>,
    ) -> Result<Vec<InfraService>> {
        self.organization_of_project(ctx, project).await?;
        let services = infra::checked_services(services).map_err(Refusal::Invalid)?;
        self.store
            .update::<BindingList, Vec<InfraService>, Refusal>(
                ctx,
                project,
                BINDINGS_METADATA_TYPE,
                |row| {
                    row.infra = services.clone();
                    Ok(services.clone())
                },
            )
            .await?
            .map(|(_, s)| s)
    }

    /// What a deploy of `project` to `environment` does with its infra
    /// services now: how each comes, from which image or chart, what it
    /// gives the product, and what would refuse the deploy.
    pub async fn infra_plan(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        environment: Uuid,
    ) -> Result<InfraPlan> {
        let org = self.organization_of_project(ctx, project).await?;
        let env = self
            .project_environment(ctx, org, project, environment)
            .await?;
        let list = self
            .store
            .read::<BindingList>(ctx, project, BINDINGS_METADATA_TYPE)
            .await?
            .0;
        let inputs = PlanInputs::of(&list);
        let description = if inputs.needs_description(&[&env]) {
            self.description_text(ctx, project).await
        } else {
            None
        };
        let slug = if env.kind == EnvironmentKind::Kubernetes {
            Some(self.slug(ctx, org, project).await?)
        } else {
            None
        };
        self.plan_in(
            org,
            project,
            &env,
            &inputs,
            description.as_deref(),
            slug.as_deref(),
        )
        .await
    }

    /// [`Self::infra_plan`] for every environment the project may deploy to
    /// (the organization's that admit it, then its own), in the order the
    /// targets list them. What every plan shares -- the organization, the
    /// project's records, its latest description, its slug -- is read once,
    /// and the environments are planned side by side: the page that drew one
    /// plan per environment made N calls that each read all of it again.
    /// An environment whose plan is refused (a namespace that cannot be
    /// placed) is left out, as a page that ignored the one refused call did.
    pub async fn infra_plans(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
    ) -> Result<Vec<InfraPlan>> {
        let (org, name) = tokio::join!(
            self.organization_of_project(ctx, project),
            self.project_name(ctx, project)
        );
        let org = org?;
        let (visible, list) = tokio::join!(
            self.visible(ctx, org, project),
            self.store
                .read::<BindingList>(ctx, project, BINDINGS_METADATA_TYPE)
        );
        let (admitted, own) = visible?;
        let list = list?.0;
        let envs: Vec<Environment> = admitted.into_iter().chain(own).collect();
        let inputs = PlanInputs::of(&list);
        let refs: Vec<&Environment> = envs.iter().collect();
        let (description, slug) = tokio::join!(
            async {
                if inputs.needs_description(&refs) {
                    self.description_text(ctx, project).await
                } else {
                    None
                }
            },
            async {
                if envs.iter().any(|e| e.kind == EnvironmentKind::Kubernetes) {
                    match &name {
                        Ok(name) => Some(self.slug_named(org, project, name).await),
                        Err(_) => None,
                    }
                } else {
                    None
                }
            }
        );
        // A project whose name cannot be read has no slug, so no Kubernetes
        // plan: the refusal is the one a single plan would have said.
        let slug = match (slug, name) {
            (Some(s), _) => Some(s?),
            (None, Err(e)) if envs.iter().any(|x| x.kind == EnvironmentKind::Kubernetes) => {
                return Err(e);
            }
            (None, _) => None,
        };
        let plans = futures_util::future::join_all(envs.iter().map(|env| {
            self.plan_in(
                org,
                project,
                env,
                &inputs,
                description.as_deref(),
                slug.as_deref(),
            )
        }))
        .await;
        let mut out = Vec::with_capacity(plans.len());
        for (env, plan) in envs.iter().zip(plans) {
            match plan {
                Ok(p) => out.push(p),
                Err(e) => {
                    tracing::debug!(%project, environment = %env.id, error = ?e, "studio-environments: an environment's infra plan is left out");
                }
            }
        }
        Ok(out)
    }

    /// One environment's plan from what [`Self::infra_plan`] and
    /// [`Self::infra_plans`] read.
    async fn plan_in(
        &self,
        org: Uuid,
        project: Uuid,
        env: &Environment,
        inputs: &PlanInputs<'_>,
        description: Option<&str>,
        slug: Option<&str>,
    ) -> Result<InfraPlan> {
        let placement = env.boundaries.infra.clone().unwrap_or_default();
        let keys = inputs.variable_keys(env, &placement);
        let configuration = Self::clashes_with(description, &keys);
        if env.kind != EnvironmentKind::Kubernetes {
            return Ok(InfraPlan {
                environment_id: env.id,
                environment_name: env.name.clone(),
                placement: placement.placement,
                namespace: String::new(),
                items: Vec::new(),
                configuration,
            });
        }
        let slug =
            slug.ok_or_else(|| Refusal::Internal("the project's slug is not read".into()))?;
        let place = self.place_with_slug(org, project, env, slug).await?;
        let items = infra::plan(Some(&placement), &inputs.services, |r| {
            under_project(env, &place.prefix, r)
        });
        Ok(InfraPlan {
            environment_id: env.id,
            environment_name: env.name.clone(),
            placement: placement.placement,
            namespace: place.namespace,
            items,
            configuration,
        })
    }

    /// The Keycloak realm the project's infra service `name` imports: its
    /// portal's client, its backend's, and a service client for every gear
    /// the latest description has signing in with `client_credentials`,
    /// each confidential one carrying the root tenant (`realm`). Nothing is
    /// written: the caller puts the file and `--import-realm` on the service.
    pub async fn keycloak_realm(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        name: &str,
        portal: Option<&str>,
    ) -> Result<crate::environments::realm::Realm> {
        let services = self.project_infra(ctx, project).await?;
        let s = services.iter().find(|s| s.name() == name).ok_or_else(|| {
            Refusal::NotFound(
                name.to_owned(),
                format!("the project has no infra service '{name}'"),
            )
        })?;
        if !crate::environments::realm::is_keycloak(&s.passport) {
            return Err(Refusal::Invalid(format!(
                "'{name}' is not a Keycloak: a realm is imported by one"
            )));
        }
        let mut notes = Vec::new();
        let configs = match self.hub.get::<dyn crate::product::port::ProjectProducts>() {
            Err(_) => {
                notes.push(
                    "products are not available in this deployment: no gear's own client".into(),
                );
                Default::default()
            }
            Ok(products) => match products.latest_description(ctx, project).await {
                Ok(Some(d)) => crate::product::port::gear_configs(&d.text),
                Ok(None) => {
                    notes.push(
                        "the project has no saved product description: no gear's own client".into(),
                    );
                    Default::default()
                }
                Err(e) => {
                    return Err(Refusal::Unavailable(format!(
                        "the project's product description could not be read: {e:#}"
                    )));
                }
            },
        };
        let mut realm = crate::environments::realm::keycloak_realm(&s.passport, portal, &configs);
        realm.notes.splice(0..0, notes);
        Ok(realm)
    }

    /// Refuse a deploy whose infra services cannot come as planned.
    pub(super) fn check_infra(
        &self,
        env: &Environment,
        prefix: &str,
        installs: &[InfraInstall],
    ) -> Result<()> {
        let services: Vec<InfraService> = installs.iter().map(|i| i.service.clone()).collect();
        let placement: Option<&InfraPlacement> = env.boundaries.infra.as_ref();
        for item in infra::plan(placement, &services, |r| under_project(env, prefix, r)) {
            if let Some((code, why)) = item.refusal {
                return Err(Refusal::Precondition(code, why));
            }
        }
        Ok(())
    }
}

/// What every environment's infra plan reads from the project's records.
struct PlanInputs<'a> {
    list: &'a BindingList,
    /// As a deploy of the newest build whose lock says its services
    /// (ADR-0065 §3), else of the project's records alone (ADR-0064).
    services: Vec<InfraService>,
}

impl<'a> PlanInputs<'a> {
    fn of(list: &'a BindingList) -> Self {
        let services = match list.built_infra.first() {
            Some(built) => infra::built_services(built, &list.infra),
            None => list.infra.clone(),
        };
        Self { list, services }
    }

    /// The variables a deploy would give the release in `env`, as
    /// `project_config` collects them.
    fn variable_keys(&self, env: &Environment, placement: &InfraPlacement) -> Vec<String> {
        let mut keys: Vec<String> = self
            .list
            .secrets
            .iter()
            .filter(|s| s.environment_id == env.id)
            .map(|s| s.key.clone())
            .collect();
        if env.kind == EnvironmentKind::Kubernetes {
            let installs = infra::installs(
                Some(placement),
                &self.services,
                env.previews
                    .as_ref()
                    .and_then(|s| s.ingress_class.as_deref()),
            );
            for v in infra::produced_variables(&installs)
                .into_iter()
                .chain(infra::file_variables(&installs))
            {
                if !keys.contains(&v) {
                    keys.push(v);
                }
            }
        }
        keys
    }

    /// Whether any of `envs` has a variable a gear's configuration could
    /// clash with: only then is the description worth reading.
    fn needs_description(&self, envs: &[&Environment]) -> bool {
        envs.iter().any(|env| {
            let placement = env.boundaries.infra.clone().unwrap_or_default();
            self.variable_keys(env, &placement)
                .iter()
                .any(|k| crate::environments::gear_overrides::field_of(k).is_some())
        })
    }
}
