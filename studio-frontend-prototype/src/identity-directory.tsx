import { useEffect, useState } from "react";

import { api, PLATFORM_ROOT_TENANT_ID, TENANT_TYPES, type PlatformIdentity, type Tenant } from "./api";
import { DataTable, When } from "./data-table";
import { errText, initials } from "./format";

/** `query` is the side panel's search; the list has its own and does not read it. */
export function IdentityDirectory({ token }: { token: string; query?: string }) {
  const [identities, setIdentities] = useState<PlatformIdentity[] | null>(null);
  const [organizations, setOrganizations] = useState<Tenant[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [roles, setRoles] = useState<Record<string, "owner" | "member">>({});

  const load = async () => {
    const [{ items }, tenantPage] = await Promise.all([
      api.platformIdentities(token),
      api.tenantChildrenAll(token, PLATFORM_ROOT_TENANT_ID),
    ]);
    setIdentities(items);
    setOrganizations(
      (tenantPage.items ?? []).filter((tenant) => tenant.tenant_type === TENANT_TYPES.organization),
    );
  };

  useEffect(() => {
    let cancelled = false;
    setError(null);
    load().then(
      () => {
        if (cancelled) return;
      },
      (reason) => {
        if (!cancelled) {
          setError(errText(reason));
          setIdentities([]);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function assign(identity: PlatformIdentity) {
    const tenantId = targets[identity.id] || identity.home_tenant_id || organizations[0]?.id;
    if (!tenantId) return;
    setBusyId(identity.id);
    setError(null);
    try {
      await api.assignPlatformIdentity(token, identity.id, {
        tenant_id: tenantId,
        role: roles[identity.id] || identity.organization_role || "member",
      });
      await load();
    } catch (reason) {
      setError(errText(reason));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Identity directory</h1>
          <p className="subtitle" style={{ margin: 0 }}>
            Everyone whose identity exists in Studio Keycloak, including people waiting for
            organization access.
          </p>
        </div>
      </div>

      {/* A failed read is the table's to show, with Retry; this is for a failed action on rows that are there. */}
      {error && (identities?.length ?? 0) > 0 && <div className="error">{error}</div>}

      <div className="card">
        <DataTable<PlatformIdentity>
          list="identities"
          rows={identities}
          error={identities !== null && identities.length === 0 ? error : null}
          onRetry={() => void load()}
          rowKey={(i) => i.id}
          rowLabel={(i) => i.display_name || i.username}
          search={{ placeholder: "Search identities" }}
          searchText={(i) => [i.display_name, i.username, i.email, i.home_tenant_name, i.status]}
          filters={[
            {
              id: "access",
              allLabel: "Everyone",
              kind: "chips",
              options: [
                { value: "unassigned", label: "Waiting for access" },
                { value: "assigned", label: "Assigned" },
                { value: "platform_admin", label: "Platform admin" },
              ],
              match: (i, v) => i.status === v,
            },
          ]}
          empty={{ title: "No identities found." }}
          columns={[
            {
              id: "name",
              header: "Identity",
              compare: (x, y) => (x.display_name || x.username).localeCompare(y.display_name || y.username),
              cell: (identity) => {
                const name = identity.display_name || identity.username;
                return (
                  <div className="pcell">
                    <span className="account-avatar small">{initials(name)}</span>
                    <div>
                      <div className="pname plain">{name}</div>
                      <div className="sub">{identity.email || identity.username}</div>
                    </div>
                  </div>
                );
              },
            },
            { id: "provider", header: "Provider", cell: (i) => <span className="sub">{i.identity_provider || "local"}</span> },
            {
              id: "access",
              header: "Access",
              cell: (identity) => (
                <>
                  <span className={`badge ${identity.status === "unassigned" ? "warn" : "workspace"}`}>
                    {identity.status === "platform_admin"
                      ? "Platform admin"
                      : identity.status === "assigned"
                        ? identity.home_tenant_name || "Assigned"
                        : "Waiting for access"}
                  </span>
                  {identity.organization_role && (
                    <div className="sub" style={{ marginTop: 4 }}>
                      {identity.organization_role === "owner" ? "Owner" : "Member"}
                    </div>
                  )}
                </>
              ),
            },
            {
              id: "assignment",
              header: "Organization assignment",
              cell: (identity) => {
                const name = identity.display_name || identity.username;
                return (
                  <div className="inline" style={{ flexWrap: "nowrap" }}>
                    <select
                      aria-label={`Organization for ${name}`}
                      value={targets[identity.id] || identity.home_tenant_id || organizations[0]?.id || ""}
                      onChange={(event) => setTargets((current) => ({ ...current, [identity.id]: event.target.value }))}
                    >
                      {organizations.length === 0 && <option value="">No organizations</option>}
                      {organizations.map((organization) => (
                        <option key={organization.id} value={organization.id}>
                          {organization.name}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label={`Role for ${name}`}
                      value={roles[identity.id] || identity.organization_role || "member"}
                      onChange={(event) =>
                        setRoles((current) => ({ ...current, [identity.id]: event.target.value as "owner" | "member" }))
                      }
                    >
                      <option value="member">Member</option>
                      <option value="owner">Owner</option>
                    </select>
                    <button
                      className="primary"
                      disabled={busyId !== null || organizations.length === 0}
                      onClick={() => void assign(identity)}
                    >
                      {busyId === identity.id ? "Saving…" : identity.home_tenant_id ? "Update" : "Assign"}
                    </button>
                  </div>
                );
              },
            },
            {
              id: "seen",
              header: "First seen",
              compare: (x, y) => (x.first_seen_at_epoch_ms ?? 0) - (y.first_seen_at_epoch_ms ?? 0),
              cell: (i) => <When iso={i.first_seen_at_epoch_ms ? new Date(i.first_seen_at_epoch_ms).toISOString() : null} />,
            },
          ]}
        />
        <p className="hint" style={{ marginTop: 14 }}>
          This is an identity directory, not an OAuth failure log. A rejected login that never
          created a Keycloak identity belongs in the security audit instead.
        </p>
      </div>
    </>
  );
}
