# admin-mfe — Administration

The prototype's Admin level, carried over (ADR-0069). The shell's own screens
(ADR-0068 §1: people, rights, settings), so no `kit`: one entry, one extension
per section on level `admin`, switched by the `section` property
(`src/AdminRoot.tsx`). The organization is the one the path bar has picked.

| Section | From the prototype (00828880) | Gears |
|---|---|---|
| Organizations | `OrganizationsTable` (`org-admin.tsx`), `OrganizationsView` (`App.tsx`) | account-management, studio-user, studio-organizations (logo) |
| People | `OrgMembersView` (`org-admin.tsx`), `MemberDirectoryForm` (`people-profile.tsx`) | studio-user, studio-identity |
| Access | `AccessView` (`App.tsx`), `access.ts` | account-management (metadata), studio-organizations (catalogue), studio-user, resource-group |
| Secrets | `SecretsView` (`App.tsx`) | credstore, account-management, studio-connector |
| Objects | `ObjectTypes` (`object-types.tsx`) | studio-components-catalog, types-registry |
| All identities | `IdentityDirectory` (`identity-directory.tsx`) | studio-identity, account-management |
| Project tenants | `WorkspacesView` (`App.tsx`) | account-management |

All identities and Project tenants are a platform administrator's: the menu
offers them to everyone and the section shows the backend's refusal to anybody
else.

- `src/model/access.ts` — the prototype's `access.ts`, unchanged, with its tests.
- `src/model/members.ts`, `secrets.ts`, `objects.ts` — the pure helpers the
  prototype kept inside its screens, lifted out and tested.
- `src/api/AdminApiService.ts` — every route the sections call.

Not here yet (see `docs/parity.md`): Integrations, Domain model, Views.
