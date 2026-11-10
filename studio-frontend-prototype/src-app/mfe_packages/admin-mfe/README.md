# admin-mfe — Administration

The prototype's Admin level, carried over (ADR-0069). The shell's own screens
(ADR-0068 §1: people, rights, settings), so no `kit`: one entry, one extension
per section on level `admin`, switched by the `section` property
(`src/AdminRoot.tsx`). The organization is the one the path bar has picked.

One extension is on the organization level: Organization › Connections
(`/connections`, section `connections`) renders the Integrations section, as
the prototype rendered `ConnectorsView` with the organization for both.

| Section | From the prototype (00828880) | Gears |
|---|---|---|
| Organizations | `OrganizationsTable` (`org-admin.tsx`), `OrganizationsView` (`App.tsx`) | account-management, studio-user, studio-organizations (logo) |
| People | `OrgMembersView` (`org-admin.tsx`), `MemberDirectoryForm` (`people-profile.tsx`) | studio-user, studio-identity |
| Access | `AccessView` (`App.tsx`), `access.ts` | account-management (metadata), studio-organizations (catalogue), studio-user, resource-group |
| Integrations (and Organization › Connections) | `ConnectorsView`, `AddConnector`, `ConnectionList`, `EditConnection`, `RepoBrowser` (`App.tsx`), `connector-logos.tsx`, `kubeconfig-field.tsx` | studio-connector, studio-environments, account-management (project config), studio-components-catalog (sync) |
| Secrets | `SecretsView` (`App.tsx`) | credstore, account-management, studio-connector |
| Studio domain model | `DomainModelAdmin` (`domain-model-admin.tsx`), `domain-origin.ts`, the pure part of `domain-runtime.ts` (studio-frontend-poc/) | studio-domain-model |
| Objects | `ObjectTypes` (`object-types.tsx`) | studio-components-catalog, types-registry |
| All identities | `IdentityDirectory` (`identity-directory.tsx`) | studio-identity, account-management |
| Project tenants | `WorkspacesView` (`App.tsx`) | account-management |

All identities and Project tenants are a platform administrator's: the menu
offers them to everyone and the section shows the backend's refusal to anybody
else.

- `src/model/access.ts` — the prototype's `access.ts`, unchanged, with its tests.
- `src/model/kubeconfig.ts` — the prototype's, unchanged, with its tests.
- `src/model/connections.ts` — the connectors constants of `App.tsx` and the
  pure parts of `project-sources.ts` and `environments.ts`, with tests.
- `src/model/members.ts`, `secrets.ts`, `objects.ts` — the pure helpers the
  prototype kept inside its screens, lifted out and tested.
- `src/model/domain-origin.ts` — the prototype's, with its tests, plus the `kit` origin
  (`meta.origin = "kit"`, `meta.kit`, ADR-0067 §6); `domain-runtime.ts` — the pure part
  of the prototype's (no seed, no global loader); `domain-admin.ts` — the screen's
  grouping, counts and form rules, lifted out and tested.
- `src/api/AdminApiService.ts` — every route the sections call.

Not here yet (see `docs/parity.md`): Views.
