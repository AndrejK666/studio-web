# studio-environments

Where an organization's products run.

The decision — why environments are the organization's, why a deploy runs on
the server, what a record of it holds — is
[ADR-0043](../../../docs/adr/0043-an-organization-deploys-products-to-its-environments.md);
how a product's images and chart reach it through the organization's registry
is [ADR-0048](../../../docs/adr/0048-a-product-ships-as-images-and-a-chart-in-the-organizations-registry.md).
This README is what you need to work in the directory.

## REST

All under `/studio-environments/v1`. An organization is named with
`?organization_id=`, a project with `?project_id=`.

| Method + path | Who | Does |
|---|---|---|
| `GET /environments` | member | the organization's environments, and `may_manage` |
| `POST /environments` | admin | add one |
| `PUT`/`DELETE /environments/{environment_id}` | admin | change or remove one |
| `POST /environments/{environment_id}/test` | admin | ask the cluster for its version with the environment's connection |
| `GET /targets?project_id=` | member | the environments the project may deploy to, its namespace in each, its bindings |
| `PUT /bindings?project_id=` | member | bind the product's kubernetes profiles to environments |
| `POST /deployments?project_id=` | member | ask for a deploy: the chart (`.tgz`, base64) or a published one (`chart_ref` `oci://<registry prefix>/…` and `chart_version`, ADR-0048 §3), the images, the commit, and the build it came from (`build`, the IDE's build id, ADR-0045 §4); 202 `queued` or `awaiting_approval` |
| `GET /deployments` | member | the history, newest first; filter by `project_id`, `environment_id` |
| `POST /deployments/{deployment_id}/decisions` | admin | `approve` or `decline` (with a reason) a deploy to a protected environment |
| `GET /deployments/{deployment_id}/status` | member | the release's workloads and ingress hosts, read from the cluster now |

"Admin" is an organization owner, a platform administrator, or on the roles
model whoever holds `environment.manage` (`access_config::PRIVILEGES`), asked
of studio-user through `OrgAuthority`.

## In the assembly

- Gear `studio-environments`, capabilities `[rest]`, deps
  `account_management`. No database and no config section.
- Task type `environments.deploy` (studio-tasks), registered at `init`.
- The cluster is a connection of the `kubernetes` kind
  (`connectors/kubernetes.rs`, plugin gear `kubernetes-connector-plugin`). Its
  credential is a service-account token or a kubeconfig with inline data only;
  `ClusterAccess::parse` refuses `exec`, `auth-provider`, file paths and
  `insecure-skip-tls-verify`, and a kubeconfig for another server than the
  connection's address. An environment refuses a personal connection: the run
  acts as the service, which cannot read one.
- An environment may name a `registry` connection (`connectors/registry.rs`,
  plugin gear `registry-connector-plugin`; ADR-0048), on the host its registry
  prefix names, organization-held like the cluster. Every deploy then writes
  its login into the namespace as the `studio-registry`
  `kubernetes.io/dockerconfigjson` secret and adds it to the `default` service
  account's `imagePullSecrets`, so the cluster pulls private images whatever
  the chart says. A published chart (`chart_ref`) is accepted only under the
  environment's registry prefix and pulled with the same login, through a
  `--registry-config` in the run's scratch directory. The cluster connection
  needs to manage secrets and service accounts in the namespace; `admin` there
  does.
- `helm` must be on the server's PATH (or `STUDIO_HELM`); both backend images
  install a pinned one.

## Where things are kept

Account-management metadata, declared in every `config/*.yaml`:

| Type | On | Written by |
|---|---|---|
| `cf.studio.environment.list.v1~` | the organization | this gear only, as the service |
| `cf.studio.environment.deployments.v1~` | the organization | this gear only, as the service |
| `cf.studio.environment.bindings.v1~` | the project | the project's members |

The first two are in `studio_authz_plugin::GEAR_HELD_METADATA`: the PDP refuses
anybody's write of them except a service token, so the administrator check
here cannot be stepped around through account-management's own metadata
route. Writes are version-checked (`expected_version`) and retried.

The history keeps `model::HISTORY` (200) deployments plus the latest of every
project and environment and everything waiting for a decision. A record's
state follows its run while it is `queued` or `running`, and is written back
once the run ends.

## Where things are

- `model.rs` — environments, bindings, records and their rules (namespace
  pattern, registry, the history's trimming, image values). No I/O.
- `store.rs` — the metadata rows and the service identity.
- `service.rs` — who may, in which order.
- `deploy.rs` — the run: namespace, the pull secret, `helm upgrade --install
  --wait` with a kubeconfig (and a registry login for a published chart) in a
  scratch directory removed afterwards; the rollout read.
- `rest.rs` — the routes.

## Not yet

Databases and required configuration from the environment (ADR-0043 phase 4,
ADR-0048 §7) wait for the engine's chart to ask for them
(constructorfabric/gearbox#8, #9). Pushing images and the chart is the
desktop's (or CI's) job: the member's `docker push` still uses their own
registry login until ADR-0048 phases 2–3 (a CI workflow, a server-issued push
credential for the desktop).
