import { useEffect, useMemo, useState } from "react";

import { api, PLATFORM_ROOT_TENANT_ID, TENANT_TYPES, type PlatformIdentity, type Tenant } from "./api";
import { errText, initials, matches } from "./format";

export function IdentityDirectory({ token, query }: { token: string; query: string }) {
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

  const filtered = useMemo(
    () =>
      (identities ?? []).filter((identity) =>
        matches(
          query,
          identity.display_name,
          identity.username,
          identity.email,
          identity.home_tenant_name,
          identity.status,
        ),
      ),
    [identities, query],
  );

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

      {error && <div className="error">{error}</div>}

      <div className="card">
        {identities === null ? (
          <p className="hint">Loading identities…</p>
        ) : filtered.length === 0 ? (
          <p className="empty">
            {identities.length === 0 ? "No identities found." : "No identities match the filter."}
          </p>
        ) : (
          <table className="ptable people">
            <thead>
              <tr>
                <th>Identity</th>
                <th>Provider</th>
                <th>Access</th>
                <th>Organization assignment</th>
                <th>First seen</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((identity) => {
                const name = identity.display_name || identity.username;
                const firstSeen = identity.first_seen_at_epoch_ms
                  ? new Date(identity.first_seen_at_epoch_ms).toLocaleString()
                  : "—";
                return (
                  <tr key={identity.id} className="prow">
                    <td>
                      <div className="pcell">
                        <span className="account-avatar small">{initials(name)}</span>
                        <div>
                          <div className="pname plain">{name}</div>
                          <div className="sub">{identity.email || identity.username}</div>
                        </div>
                      </div>
                    </td>
                    <td className="sub">{identity.identity_provider || "local"}</td>
                    <td>
                      <span className={`badge ${identity.status === "unassigned" ? "warning" : "workspace"}`}>
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
                    </td>
                    <td>
                      <div className="inline" style={{ flexWrap: "nowrap" }}>
                        <select
                          aria-label={`Organization for ${name}`}
                          value={targets[identity.id] || identity.home_tenant_id || organizations[0]?.id || ""}
                          onChange={(event) =>
                            setTargets((current) => ({ ...current, [identity.id]: event.target.value }))
                          }
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
                            setRoles((current) => ({
                              ...current,
                              [identity.id]: event.target.value as "owner" | "member",
                            }))
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
                    </td>
                    <td className="sub">{firstSeen}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="hint" style={{ marginTop: 14 }}>
          This is an identity directory, not an OAuth failure log. A rejected login that never
          created a Keycloak identity belongs in the security audit instead.
        </p>
      </div>
    </>
  );
}
