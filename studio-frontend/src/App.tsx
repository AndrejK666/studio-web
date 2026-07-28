import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  api,
  ApiError,
  shortTypeName,
  TENANT_TYPES,
  type Me,
  type Tenant,
  type User,
} from "./api";

// Portal (личный кабинет): sign in with a bearer token, then an app shell
// with a sidebar — Workspaces / Organizations / Members / Profile.
// Selecting a workspace hands off to the Theia-based Studio (/studio/{id}).

function errText(e: unknown): string {
  if (e instanceof ApiError) {
    const b = e.body as { title?: string; detail?: string } | undefined;
    return `HTTP ${e.status}${b?.title ? ` · ${b.title}` : ""}${b?.detail ? ` — ${b.detail}` : ""}`;
  }
  return String(e);
}

interface Workspace extends Tenant {
  orgName: string;
}

export function App() {
  const [token, setToken] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);

  if (!token || !me) {
    return <Login onLogin={(t, who) => { setToken(t); setMe(who); }} />;
  }
  return <Shell token={token} me={me} onLogout={() => { setToken(null); setMe(null); }} />;
}

/* ── Login ── */

function Login({ onLogin }: { onLogin: (token: string, me: Me) => void }) {
  const [value, setValue] = useState("studio-admin-token");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const who = await api.me(value); // 401 -> failed login
      onLogin(value, who);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? "Invalid token" : errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="narrow">
      <div className="wordmark" style={{ marginBottom: "1.5rem" }}>
        <div className="logo">S</div>
        <h1>Constructor Studio</h1>
      </div>
      <div className="card">
        <form onSubmit={submit}>
          <label className="field">
            Access token
            <input value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
          </label>
          <button className="primary" disabled={busy || !value} style={{ width: "100%" }}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
          {error && <div className="error">{error}</div>}
        </form>
      </div>
      <p className="hint" style={{ marginTop: "1rem" }}>
        Dev tokens: <code>studio-admin-token</code>, <code>studio-user-token</code>. Real sign-in
        arrives with the OIDC plugin.
      </p>
    </main>
  );
}

/* ── App shell ── */

type View = "workspaces" | "organizations" | "members" | "profile";

const NAV: { id: View; icon: string; label: string }[] = [
  { id: "workspaces", icon: "▦", label: "Workspaces" },
  { id: "organizations", icon: "🏢", label: "Organizations" },
  { id: "members", icon: "👥", label: "Members" },
  { id: "profile", icon: "●", label: "Profile" },
];

function Shell({ token, me, onLogout }: { token: string; me: Me; onLogout: () => void }) {
  const [view, setView] = useState<View>("workspaces");
  const [home, setHome] = useState<Tenant | null>(null);
  const [orgs, setOrgs] = useState<Tenant[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [studio, setStudio] = useState<Workspace | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [homeTenant, page] = await Promise.all([
        api.tenant(token, me.subject_tenant_id),
        api.tenantChildren(token, me.subject_tenant_id),
      ]);
      setHome(homeTenant);
      const children = page.items ?? [];
      const orgList = children.filter((t) => t.tenant_type === TENANT_TYPES.organization);
      const directWs = children
        .filter((t) => t.tenant_type === TENANT_TYPES.workspace)
        .map((t) => ({ ...t, orgName: homeTenant.name }));
      // Workspaces live under organizations — fetch each org's children.
      const nested = await Promise.all(
        orgList.map(async (org) => {
          const kids = await api.tenantChildren(token, org.id);
          return (kids.items ?? [])
            .filter((t) => t.tenant_type === TENANT_TYPES.workspace)
            .map((t) => ({ ...t, orgName: org.name }));
        }),
      );
      setOrgs(orgList);
      setWorkspaces([...directWs, ...nested.flat()]);
    } catch (e) {
      setError(errText(e));
    }
  }, [token, me.subject_tenant_id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="wordmark">
          <div className="logo">S</div>
          <strong>Studio</strong>
        </div>
        <nav>
          {NAV.map((n) => (
            <button
              key={n.id}
              className={view === n.id ? "active" : ""}
              onClick={() => setView(n.id)}
            >
              <span className="ico">{n.icon}</span> {n.label}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <div className="whoami">
          <span>
            <code title={me.subject_id}>{me.subject_id.slice(0, 8)}…</code>
          </span>
          <span>{home ? `Home: ${home.name}` : ""}</span>
          <button onClick={onLogout}>Sign out</button>
        </div>
      </aside>

      <div className="content">
        {error && <div className="error">{error}</div>}
        {view === "workspaces" && (
          <WorkspacesView
            token={token}
            orgs={orgs}
            workspaces={workspaces}
            onChanged={refresh}
            onOpenStudio={setStudio}
          />
        )}
        {view === "organizations" && (
          <OrganizationsView token={token} homeId={me.subject_tenant_id} orgs={orgs} onChanged={refresh} />
        )}
        {view === "members" && <MembersView token={token} home={home} orgs={orgs} workspaces={workspaces} />}
        {view === "profile" && <ProfileView me={me} home={home} />}
        {studio && <StudioLauncher ws={studio} onClose={() => setStudio(null)} />}
      </div>
    </div>
  );
}

/* ── Workspaces ── */

function WorkspacesView({
  token,
  orgs,
  workspaces,
  onChanged,
  onOpenStudio,
}: {
  token: string;
  orgs: Tenant[];
  workspaces: Workspace[];
  onChanged: () => void;
  onOpenStudio: (ws: Workspace) => void;
}) {
  const [name, setName] = useState("");
  const [orgId, setOrgId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createTenant(token, {
        name,
        parent_id: orgId,
        tenant_type: TENANT_TYPES.workspace,
      });
      setName("");
      onChanged();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Workspaces</h1>
      <p className="subtitle">Pick a workspace to open its Studio, or create a new one.</p>
      <div className="card">
        {workspaces.length === 0 ? (
          <p className="empty">No workspaces yet — create the first one below.</p>
        ) : (
          <ul className="rows">
            {workspaces.map((w) => (
              <li key={w.id}>
                <div className="grow">
                  <div className="name">{w.name}</div>
                  <div className="sub">{w.orgName}</div>
                </div>
                <span className="badge workspace">workspace</span>
                {w.self_managed && <span className="badge selfmanaged">self-managed</span>}
                <button className="primary" onClick={() => onOpenStudio(w)}>
                  Open Studio
                </button>
              </li>
            ))}
          </ul>
        )}
        <form className="inline" onSubmit={create}>
          <input placeholder="New workspace name" value={name} onChange={(e) => setName(e.target.value)} />
          <select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
            <option value="">organization…</option>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <button className="primary" disabled={busy || !name || !orgId}>
            Create
          </button>
        </form>
        {error && <div className="error">{error}</div>}
      </div>
    </>
  );
}

/* ── Organizations ── */

function OrganizationsView({
  token,
  homeId,
  orgs,
  onChanged,
}: {
  token: string;
  homeId: string;
  orgs: Tenant[];
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createTenant(token, {
        name,
        parent_id: homeId,
        tenant_type: TENANT_TYPES.organization,
      });
      setName("");
      onChanged();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Organizations</h1>
      <p className="subtitle">Organizations group workspaces; the tenant type barrier is enforced by the backend.</p>
      <div className="card">
        {orgs.length === 0 ? (
          <p className="empty">No organizations yet.</p>
        ) : (
          <ul className="rows">
            {orgs.map((o) => (
              <li key={o.id}>
                <div className="grow">
                  <div className="name">{o.name}</div>
                  <div className="sub">{o.id}</div>
                </div>
                <span className="badge">{shortTypeName(o.tenant_type)}</span>
                {o.self_managed && <span className="badge selfmanaged">self-managed</span>}
              </li>
            ))}
          </ul>
        )}
        <form className="inline" onSubmit={create}>
          <input placeholder="New organization name" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="primary" disabled={busy || !name}>
            Create
          </button>
        </form>
        {error && <div className="error">{error}</div>}
      </div>
    </>
  );
}

/* ── Members ── */

function MembersView({
  token,
  home,
  orgs,
  workspaces,
}: {
  token: string;
  home: Tenant | null;
  orgs: Tenant[];
  workspaces: Workspace[];
}) {
  const all = [...(home ? [home] : []), ...orgs, ...workspaces];
  const [tenantId, setTenantId] = useState<string>("");
  const [users, setUsers] = useState<User[] | null>(null);
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    setError(null);
    setUsers(null);
    try {
      const page = await api.tenantUsers(token, id);
      setUsers(page.items ?? []);
    } catch (e) {
      setError(errText(e));
    }
  }, [token]);

  useEffect(() => {
    if (tenantId) void load(tenantId);
  }, [tenantId, load]);

  async function invite(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.inviteUser(token, tenantId, {
        username,
        email: `${username}@example.com`,
        display_name: username,
      });
      setUsername("");
      await load(tenantId);
    } catch (err) {
      setError(errText(err));
    }
  }

  return (
    <>
      <h1>Members</h1>
      <p className="subtitle">Users are provisioned through the pluggable IdP contract.</p>
      <div className="card">
        <select value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
          <option value="">Select a tenant…</option>
          {all.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({shortTypeName(t.tenant_type)})
            </option>
          ))}
        </select>

        {users && (
          <>
            {users.length === 0 ? (
              <p className="empty" style={{ marginTop: 12 }}>No users in this tenant.</p>
            ) : (
              <ul className="rows" style={{ marginTop: 12 }}>
                {users.map((u) => (
                  <li key={u.id}>
                    <div className="grow">
                      <div className="name">{u.display_name ?? u.username}</div>
                      <div className="sub">
                        {u.username}
                        {u.email ? ` · ${u.email}` : ""}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <form className="inline" onSubmit={invite}>
              <input
                placeholder="username to invite"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
              <button className="primary" disabled={!username}>
                Invite
              </button>
            </form>
          </>
        )}
        {error && <div className="error">{error}</div>}
      </div>
    </>
  );
}

/* ── Profile ── */

function ProfileView({ me, home }: { me: Me; home: Tenant | null }) {
  return (
    <>
      <h1>Profile</h1>
      <p className="subtitle">Identity as the backend sees it (from the validated token).</p>
      <div className="card">
        <ul className="rows">
          <li>
            <div className="grow"><div className="sub">Subject ID</div><div className="name">{me.subject_id}</div></div>
          </li>
          <li>
            <div className="grow"><div className="sub">Subject type</div><div className="name">{me.subject_type ?? "—"}</div></div>
          </li>
          <li>
            <div className="grow">
              <div className="sub">Home tenant</div>
              <div className="name">{home ? `${home.name} (${shortTypeName(home.tenant_type)})` : me.subject_tenant_id}</div>
            </div>
          </li>
        </ul>
        <p className="hint" style={{ marginTop: 12 }}>
          API: <a href="/cf/docs">/cf/docs</a>
        </p>
      </div>
    </>
  );
}

/* ── Studio launcher (Theia hand-off contract) ── */

function StudioLauncher({ ws, onClose }: { ws: Workspace; onClose: () => void }) {
  const url = `/studio/${ws.id}`;
  return (
    <div className="card launcher">
      <div className="card-head">
        <h2>
          Studio — {ws.name} <span className="sub">({ws.orgName})</span>
        </h2>
        <button className="ghost" onClick={onClose}>
          close
        </button>
      </div>
      <p>
        The Theia-based workbench for this workspace will open at <code>{url}</code> with your
        token; the backend scopes everything the Studio sees to this workspace tenant.
      </p>
      <p className="hint">
        Not wired yet: Theia session manager (docker-compose MVP → theia-cloud on k8s) and the
        Studio Theia extension.
      </p>
      <button className="primary" disabled title="Theia session manager not deployed yet">
        Launch (coming soon)
      </button>
    </div>
  );
}
