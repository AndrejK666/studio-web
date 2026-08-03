import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  api,
  ApiError,
  UNAUTHENTICATED_EVENT,
  PROJECT_RG_TYPE,
  shortTypeName,
  TENANT_TYPES,
  USER_MEMBER_HANDLE,
  type Group,
  type Me,
  type Tenant,
  type User,
  type WorkspaceSettings,
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

/* ── Filters (right panel) ── */

interface Filters {
  query: string;
  org: string; // workspaces: filter by organization id
  selfManagedOnly: boolean; // workspaces
  sort: "name-asc" | "name-desc"; // workspaces
  model: string; // chats: filter by model_id
  mode: "all" | "managed" | "self"; // organizations
  sections: { gears: boolean; upstreams: boolean; entities: boolean }; // system
}

const DEFAULT_FILTERS: Filters = {
  query: "",
  org: "",
  selfManagedOnly: false,
  sort: "name-asc",
  model: "",
  mode: "all",
  sections: { gears: true, upstreams: true, entities: true },
};

function matches(q: string, ...fields: (string | undefined | null)[]): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((f) => (f ?? "").toLowerCase().includes(needle));
}

type PanelView = View | "dashboard";

function activeFilterCount(view: PanelView, f: Filters): number {
  let n = 0;
  if (view !== "system" && view !== "profile" && view !== "dashboard" && f.query.trim()) n++;
  if (view === "workspaces") {
    if (f.org) n++;
    if (f.selfManagedOnly) n++;
    if (f.sort !== "name-asc") n++;
  }
  if (view === "chats" && f.model) n++;
  if (view === "organizations" && f.mode !== "all") n++;
  if (view === "system") n += Object.values(f.sections).filter((v) => !v).length;
  return n;
}

export function App() {
  const [token, setToken] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [expired, setExpired] = useState(false);
  const [restoring, setRestoring] = useState(true);

  /** Renew the access token silently; returns true when the session lives on. */
  const renew = useCallback(async (): Promise<boolean> => {
    const { refreshSsoSession } = await import("./oidc");
    const session = await refreshSsoSession().catch(() => null);
    if (!session) return false;
    try {
      const who = await api.me(session.accessToken);
      setToken(session.accessToken);
      setMe(who);
      // Renew a minute before expiry; the IdP keeps the SSO session alive far
      // longer than one access token, so this is invisible to the user.
      window.setTimeout(() => void renew(), Math.max(30, session.expiresIn - 60) * 1000);
      return true;
    } catch {
      return false;
    }
  }, []);

  // Page load: restore a session from the stored refresh token (survives F5).
  useEffect(() => {
    (async () => {
      const { hasSsoSession } = await import("./oidc");
      if (hasSsoSession()) await renew();
      setRestoring(false);
    })();
  }, [renew]);

  // Any 401: try a silent renewal first (access tokens are short-lived), and
  // only end the session when the IdP declines.
  useEffect(() => {
    const onUnauthenticated = () => {
      void (async () => {
        if (await renew()) return;
        const { clearSsoSession } = await import("./oidc");
        clearSsoSession();
        setToken((t) => {
          if (t) setExpired(true);
          return null;
        });
        setMe(null);
      })();
    };
    window.addEventListener(UNAUTHENTICATED_EVENT, onUnauthenticated);
    return () => window.removeEventListener(UNAUTHENTICATED_EVENT, onUnauthenticated);
  }, [renew]);

  if (restoring && !token) {
    return (
      <main className="narrow">
        <p className="hint">Restoring session…</p>
      </main>
    );
  }

  if (!token || !me) {
    return (
      <Login
        sessionExpired={expired}
        onLogin={(t, who) => {
          setExpired(false);
          setToken(t);
          setMe(who);
        }}
      />
    );
  }
  return (
    <Shell
      token={token}
      me={me}
      onLogout={() => {
        void import("./oidc").then(({ clearSsoSession }) => clearSsoSession());
        setToken(null);
        setMe(null);
      }}
    />
  );
}

/* ── Login ── */

function Login({
  onLogin,
  sessionExpired = false,
}: {
  onLogin: (token: string, me: Me) => void;
  sessionExpired?: boolean;
}) {
  const [value, setValue] = useState("studio-admin-token");
  const [error, setError] = useState<string | null>(
    sessionExpired ? "Session expired — please sign in again." : null,
  );
  const [busy, setBusy] = useState(false);

  // Returning from the IdP? Finish the PKCE exchange and sign in.
  useEffect(() => {
    import("./oidc").then(({ completeSsoLogin }) =>
      completeSsoLogin()
        .then(async (session) => {
          if (!session) return;
          setBusy(true);
          const who = await api.me(session.accessToken);
          onLogin(session.accessToken, who);
        })
        .catch((e) => {
          setBusy(false);
          setError(errText(e));
        }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          <button
            type="button"
            style={{ width: "100%", marginTop: 8 }}
            disabled={busy}
            onClick={() => import("./oidc").then(({ startSsoLogin }) => startSsoLogin())}
          >
            Sign in with SSO (Keycloak)
          </button>
          {error && <div className="error">{error}</div>}
        </form>
      </div>
      <p className="hint" style={{ marginTop: "1rem" }}>
        Dev tokens (<code>studio-admin-token</code>, <code>studio-user-token</code>) work with the
        static profiles; SSO needs the backend on <code>config/oidc.yaml</code> and{" "}
        <code>docker compose up -d keycloak</code> (users <code>admin</code>/<code>demo</code>,
        password <code>studio</code>; accept the self-signed cert on first visit).
      </p>
    </main>
  );
}

/* ── App shell ── */

type View =
  | "workspaces"
  | "projects"
  | "chats"
  | "organizations"
  | "members"
  | "files"
  | "system"
  | "profile";

const NAV: { id: View; icon: string; label: string }[] = [
  { id: "workspaces", icon: "▦", label: "Workspaces" },
  { id: "projects", icon: "◳", label: "Projects" },
  { id: "chats", icon: "💬", label: "Chats" },
  { id: "organizations", icon: "🏢", label: "Organizations" },
  { id: "members", icon: "👥", label: "Members" },
  { id: "files", icon: "📄", label: "Files" },
  { id: "system", icon: "⚙", label: "System" },
  { id: "profile", icon: "●", label: "Profile" },
];

function Shell({ token, me, onLogout }: { token: string; me: Me; onLogout: () => void }) {
  const [view, setView] = useState<View>("workspaces");
  const [home, setHome] = useState<Tenant | null>(null);
  const [orgs, setOrgs] = useState<Tenant[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [studio, setStudio] = useState<Workspace | null>(null);
  const [dash, setDash] = useState<Workspace | null>(null);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [panelOpen, setPanelOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem("studio.filterPanel") !== "collapsed";
    } catch {
      return true;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("studio.filterPanel", panelOpen ? "open" : "collapsed");
    } catch {
      /* private mode etc. — non-fatal */
    }
  }, [panelOpen]);

  const panelView: PanelView = dash ? "dashboard" : view;

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [homeTenant, page] = await Promise.all([
        api.tenant(token, me.subject_tenant_id),
        api.tenantChildren(token, me.subject_tenant_id).catch((e) => {
          // A 404 here means the home tenant is gone (deleted) — show an
          // empty portal with a clear note rather than a raw API error.
          if (e instanceof ApiError && e.status === 404) return { items: [] };
          throw e;
        }),
      ]);
      setHome(homeTenant);
      const children = page.items ?? [];
      const orgList = children.filter((t) => t.tenant_type === TENANT_TYPES.organization);
      const directWs = children
        .filter((t) => t.tenant_type === TENANT_TYPES.workspace)
        .map((t) => ({ ...t, orgName: homeTenant.name }));
      // Workspaces live under organizations — fetch each org's children.
      // A self-managed org raises the visibility barrier: from outside its
      // subtree the backend answers 404. That's tenant isolation working,
      // not an error — skip such orgs instead of failing the whole view.
      const nested = await Promise.all(
        orgList.map(async (org): Promise<Workspace[]> => {
          try {
            const kids = await api.tenantChildren(token, org.id);
            return (kids.items ?? [])
              .filter((t) => t.tenant_type === TENANT_TYPES.workspace)
              .map((t) => ({ ...t, orgName: org.name }));
          } catch {
            return []; // barrier (404) or no access — org stays visible, contents don't
          }
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
        {dash ? (
          <WorkspaceDashboard
            token={token}
            ws={dash}
            onBack={() => setDash(null)}
            onOpenStudio={setStudio}
          />
        ) : (
          <>
        {view === "workspaces" && (
          <WorkspacesView
            token={token}
            orgs={orgs}
            workspaces={workspaces}
            filters={filters}
            onChanged={refresh}
            onOpenStudio={setStudio}
            onOpenDashboard={setDash}
          />
        )}
        {view === "projects" && <ProjectsView token={token} workspaces={workspaces} filters={filters} />}
        {view === "organizations" && (
          <OrganizationsView token={token} homeId={me.subject_tenant_id} orgs={orgs} filters={filters} onChanged={refresh} />
        )}
        {view === "members" && (
          <MembersView token={token} home={home} orgs={orgs} workspaces={workspaces} filters={filters} />
        )}
        {view === "chats" && <ChatsView token={token} filters={filters} />}
        {view === "files" && <FilesView token={token} filters={filters} />}
        {view === "system" && <SystemView token={token} filters={filters} />}
        {view === "profile" && <ProfileView me={me} home={home} token={token} />}
          </>
        )}
        {studio && <StudioLauncher token={token} ws={studio} onClose={() => setStudio(null)} />}
      </div>

      <FilterPanel
        view={panelView}
        token={token}
        filters={filters}
        onChange={setFilters}
        open={panelOpen}
        onToggle={() => setPanelOpen((v) => !v)}
        orgs={orgs}
      />
    </div>
  );
}

/* ── Right panel: context-aware filters ── */

function FilterPanel({
  view,
  token,
  filters,
  onChange,
  open,
  onToggle,
  orgs,
}: {
  view: PanelView;
  token: string;
  filters: Filters;
  onChange: (f: Filters) => void;
  open: boolean;
  onToggle: () => void;
  orgs: Tenant[];
}) {
  const [models, setModels] = useState<import("./api").Model[]>([]);

  useEffect(() => {
    if (view === "chats" && models.length === 0) {
      api
        .models(token)
        .then((p) => setModels(p.items ?? []))
        .catch(() => {
          /* model list is a nicety — search still works */
        });
    }
  }, [view, token, models.length]);

  const count = activeFilterCount(view, filters);
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });
  const noFilters = view === "profile" || view === "dashboard";
  const hasSearch = !noFilters && view !== "system";

  if (!open) {
    return (
      <aside className="rightbar collapsed">
        <button className="funnel" title="Show filters" onClick={onToggle}>
          <span aria-hidden>🎛</span>
          {count > 0 && <span className="count">{count}</span>}
        </button>
      </aside>
    );
  }

  return (
    <aside className="rightbar">
      <div className="rightbar-head">
        <h2>
          Filters {count > 0 && <span className="count-pill">{count}</span>}
        </h2>
        <div style={{ display: "flex", gap: 4 }}>
          {count > 0 && (
            <button className="ghost" onClick={() => onChange({ ...DEFAULT_FILTERS })}>
              reset
            </button>
          )}
          <button className="ghost" title="Hide filters" onClick={onToggle}>
            ⇥
          </button>
        </div>
      </div>

      {noFilters ? (
        <p className="hint">No filters for this view.</p>
      ) : (
        <>
          {hasSearch && (
            <div className="filter-group">
              <span className="lbl">Search</span>
              <input
                placeholder="Type to filter…"
                value={filters.query}
                onChange={(e) => set({ query: e.target.value })}
              />
            </div>
          )}

          {view === "workspaces" && (
            <>
              <div className="filter-group">
                <span className="lbl">Organization</span>
                <select value={filters.org} onChange={(e) => set({ org: e.target.value })}>
                  <option value="">All organizations</option>
                  {orgs.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="filter-group">
                <span className="lbl">Mode</span>
                <div className="chipset">
                  <button
                    type="button"
                    className={`chip ${filters.selfManagedOnly ? "on" : ""}`}
                    onClick={() => set({ selfManagedOnly: !filters.selfManagedOnly })}
                  >
                    self-managed only
                  </button>
                </div>
              </div>
              <div className="filter-group">
                <span className="lbl">Sort</span>
                <select
                  value={filters.sort}
                  onChange={(e) => set({ sort: e.target.value as Filters["sort"] })}
                >
                  <option value="name-asc">Name A → Z</option>
                  <option value="name-desc">Name Z → A</option>
                </select>
              </div>
            </>
          )}

          {view === "chats" && (
            <div className="filter-group">
              <span className="lbl">Model</span>
              <select value={filters.model} onChange={(e) => set({ model: e.target.value })}>
                <option value="">All models</option>
                {models.map((m) => (
                  <option key={m.model_id} value={m.model_id}>
                    {m.display_name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {view === "organizations" && (
            <div className="filter-group">
              <span className="lbl">Mode</span>
              <div className="chipset">
                {(["all", "managed", "self"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`chip ${filters.mode === m ? "on" : ""}`}
                    onClick={() => set({ mode: m })}
                  >
                    {m === "self" ? "self-managed" : m}
                  </button>
                ))}
              </div>
            </div>
          )}

          {view === "system" && (
            <div className="filter-group">
              <span className="lbl">Sections</span>
              <div className="chipset">
                {(Object.keys(filters.sections) as (keyof Filters["sections"])[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={`chip ${filters.sections[k] ? "on" : ""}`}
                    onClick={() =>
                      set({ sections: { ...filters.sections, [k]: !filters.sections[k] } })
                    }
                  >
                    {k}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </aside>
  );
}

/* ── Workspaces ── */

function WorkspacesView({
  token,
  orgs,
  workspaces,
  filters,
  onChanged,
  onOpenStudio,
  onOpenDashboard,
}: {
  token: string;
  orgs: Tenant[];
  workspaces: Workspace[];
  filters: Filters;
  onChanged: () => void;
  onOpenStudio: (ws: Workspace) => void;
  onOpenDashboard: (ws: Workspace) => void;
}) {
  const [name, setName] = useState("");
  const [orgId, setOrgId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const orgFilterName = orgs.find((o) => o.id === filters.org)?.name;
  const visible = workspaces
    .filter((w) => matches(filters.query, w.name, w.orgName))
    .filter((w) => !orgFilterName || w.orgName === orgFilterName)
    .filter((w) => !filters.selfManagedOnly || w.self_managed)
    .sort((a, b) =>
      filters.sort === "name-desc" ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name),
    );

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

  async function remove(w: Workspace) {
    if (!window.confirm(`Delete workspace “${w.name}”? This cannot be undone.`)) return;
    setError(null);
    try {
      await api.deleteTenant(token, w.id);
      onChanged();
    } catch (err) {
      setError(errText(err));
    }
  }

  return (
    <>
      <h1>Workspaces</h1>
      <p className="subtitle">Pick a workspace to open its Studio, or create a new one.</p>
      <div className="card">
        {workspaces.length === 0 ? (
          <p className="empty">No workspaces yet — create the first one below.</p>
        ) : visible.length === 0 ? (
          <p className="empty">No workspaces match the current filters.</p>
        ) : (
          <ul className="rows">
            {visible.map((w) => (
              <li key={w.id}>
                <div
                  className="grow"
                  style={{ cursor: "pointer" }}
                  onClick={() => onOpenDashboard(w)}
                  title="Open workspace dashboard"
                >
                  <div className="name">{w.name}</div>
                  <div className="sub">{w.orgName}</div>
                </div>
                <span className="badge workspace">workspace</span>
                {w.self_managed && <span className="badge selfmanaged">self-managed</span>}
                <button onClick={() => onOpenDashboard(w)}>Dashboard</button>
                <button className="primary" onClick={() => onOpenStudio(w)}>
                  Open Studio
                </button>
                <button className="ghost" title="Delete workspace" onClick={() => void remove(w)}>
                  ✕
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

/* ── Workspace Dashboard (vision journey J2: onboard a project) ── */

const WORKER_CATEGORIES = ["documenting", "coding", "review", "analysis"];

const REPO_SOURCES: { id: import("./api").RepoSource; label: string }[] = [
  { id: "local", label: "Local folder" },
  { id: "git", label: "Git URL" },
  { id: "github", label: "GitHub" },
  { id: "gitlab", label: "GitLab" },
];

const ADAPTER_HOSTS: Record<string, string> = { github: "github.com", gitlab: "gitlab.com" };
const PAT_SECRET_TYPE =
  "gts.cf.core.credstore.secret.v1~cf.core.credstore.personal_token.v1~";

function slugFromUrl(url: string | undefined, host: string): string {
  if (!url) return "";
  const m = url.match(new RegExp(`^https://${host.replace(".", "\\.")}/(.+?)(\\.git)?$`));
  return m ? m[1] : "";
}

function WorkspaceDashboard({
  token,
  ws,
  onBack,
  onOpenStudio,
}: {
  token: string;
  ws: Workspace;
  onBack: () => void;
  onOpenStudio: (ws: Workspace) => void;
}) {
  const [users, setUsers] = useState<User[] | null>(null);
  const [projects, setProjects] = useState<Group[] | null>(null);
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [settingsExist, setSettingsExist] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pats, setPats] = useState<Record<string, string>>({}); // write-only: become credstore secrets
  const [repoSaved, setRepoSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [u, g, s] = await Promise.all([
        api.tenantUsers(token, ws.id),
        api.groups(token),
        api.workspaceSettings(token, ws.id),
      ]);
      setUsers(u.items ?? []);
      setProjects(
        (g.items ?? []).filter(
          (p) => p.type === PROJECT_RG_TYPE && p.metadata?.workspace_id === ws.id,
        ),
      );
      setSettings(s ?? { automation_level: "recommendations", approved_worker_categories: [] });
      setSettingsExist(s !== null);
    } catch (e) {
      setError(errText(e));
    }
  }, [token, ws.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveSettings(e: FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setError(null);
    setSaved(false);
    try {
      await api.putWorkspaceSettings(token, ws.id, settings);
      setSettingsExist(true);
      setSaved(true);
    } catch (err) {
      setError(errText(err));
    }
  }

  async function saveRepo(e: FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setError(null);
    setRepoSaved(false);
    try {
      // Newly entered PATs become credstore secrets; settings keep only refs.
      const repos = await Promise.all(
        (settings.repos ?? []).map(async (r) => {
          const pat = pats[r.name]?.trim();
          if (pat && r.source !== "local") {
            const ref = `studio-repo-${ws.id}-${r.name}`;
            await api.putSecret(token, ref, pat, PAT_SECRET_TYPE);
            return { ...r, token_ref: ref };
          }
          return r;
        }),
      );
      // Drop incomplete rows (an added-but-unfilled source would fail launch).
      const complete = repos.filter((r) =>
        r.source === "local" ? Boolean(r.path?.trim()) : Boolean(r.url?.trim()),
      );
      let next = { ...settings, repos: complete };
      // Root repository PAT → credstore secret, settings keep the reference.
      const rootPat = pats["__root__"]?.trim();
      if (rootPat && next.root_repo_url?.trim()) {
        const ref = `studio-root-${ws.id}`;
        await api.putSecret(token, ref, rootPat, PAT_SECRET_TYPE);
        next = { ...next, root_token_ref: ref };
      }
      await api.putWorkspaceSettings(token, ws.id, next);
      setSettings(next);
      setPats({});
      setSettingsExist(true);
      setRepoSaved(true);
    } catch (err) {
      setError(errText(err));
    }
  }

  function patchRepo(i: number, patch: Partial<import("./api").RepoEntry>) {
    if (!settings) return;
    const repos = [...(settings.repos ?? [])];
    repos[i] = { ...repos[i], ...patch };
    setSettings({ ...settings, repos });
  }

  const repoConnected = (settings?.repos?.length ?? 0) > 0;
  const steps: { label: string; done: boolean; soon?: boolean }[] = [
    { label: "Workspace created", done: true },
    { label: "Members invited", done: (users?.length ?? 0) > 0 },
    { label: "First project created", done: (projects?.length ?? 0) > 0 },
    { label: "Automation configured", done: settingsExist },
    { label: "Repository connected", done: repoConnected },
    { label: "Connectors (GitHub / Jira)", done: false, soon: true },
    { label: "Kit installed", done: false, soon: true },
  ];

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{ws.name}</h1>
          <p className="subtitle" style={{ margin: 0 }}>
            {ws.orgName} · <code>{ws.id.slice(0, 8)}…</code>
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onBack}>← Back</button>
          <button className="primary" onClick={() => onOpenStudio(ws)}>
            Open Studio
          </button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}

      <div className="card">
        <h2>Onboarding (journey J2)</h2>
        <ul className="rows">
          {steps.map((s) => (
            <li key={s.label}>
              <span style={{ width: 22 }}>{s.done ? "✅" : s.soon ? "🔒" : "⬜"}</span>
              <div className="grow">
                <div className={s.done ? "name" : "sub"}>{s.label}</div>
              </div>
              {s.soon && <span className="badge">coming soon</span>}
            </li>
          ))}
        </ul>
        <p className="hint">
          {users?.length ?? "…"} member(s) · {projects?.length ?? "…"} project(s)
        </p>
      </div>

      <div className="card">
        <h2>Automation — trust ramp</h2>
        <p className="hint">
          The domain model's trust ramp, per workspace: <b>manual</b> = read-only insight,{" "}
          <b>recommendations</b> = prepared actions awaiting approval, <b>autonomous</b> = approved
          automation for the categories below. Stored as tenant metadata (GTS-validated).
        </p>
        {settings && (
          <form onSubmit={saveSettings}>
            <label className="field" style={{ maxWidth: 320 }}>
              Automation level
              <select
                style={{ display: "block", width: "100%", marginTop: 6 }}
                value={settings.automation_level ?? "recommendations"}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    automation_level: e.target.value as WorkspaceSettings["automation_level"],
                  })
                }
              >
                <option value="manual">manual — humans do everything</option>
                <option value="recommendations">recommendations — workers suggest, humans approve</option>
                <option value="autonomous">autonomous — approved workers act on their own</option>
              </select>
            </label>
            <div className="field">
              Approved worker categories
              <div style={{ display: "flex", gap: 14, marginTop: 6, flexWrap: "wrap" }}>
                {WORKER_CATEGORIES.map((c) => (
                  <label key={c} style={{ fontWeight: 400 }}>
                    <input
                      type="checkbox"
                      checked={settings.approved_worker_categories?.includes(c) ?? false}
                      onChange={(e) => {
                        const cur = new Set(settings.approved_worker_categories ?? []);
                        if (e.target.checked) cur.add(c);
                        else cur.delete(c);
                        setSettings({ ...settings, approved_worker_categories: [...cur] });
                      }}
                    />{" "}
                    {c}
                  </label>
                ))}
              </div>
            </div>
            <button className="primary">Save settings</button>
            {saved && <span className="hint" style={{ marginLeft: 10 }}>saved ✓</span>}
          </form>
        )}
      </div>

      <div className="card">
        <h2>Workspace sources</h2>
        <p className="hint">
          How the organization's repositories enter this workspace (the domain model's ingress):
          each source becomes <code>./&lt;name&gt;</code> in the IDE and a{" "}
          <code>[sources.&lt;name&gt;]</code> entry in <code>.cf-workspace.toml</code>. Multiple
          sources per workspace; tokens go to credstore, only references are stored here.
        </p>
        {settings && (
          <form onSubmit={saveRepo}>
            <div
              className="field"
              style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px" }}
            >
              Workspace root — a Studio workspace is itself a repository (manifest, docs,
              <code> .workspace-sources/</code>). Clone it, or point at a local folder.
              <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                <input
                  placeholder="https://gitlab.constr.dev/hypotheses/hypothesis-workspace.git"
                  style={{ flex: 1, minWidth: 300, fontWeight: 400 }}
                  value={settings.root_repo_url ?? ""}
                  onChange={(e) => setSettings({ ...settings, root_repo_url: e.target.value })}
                />
                <input
                  type="password"
                  placeholder={
                    settings.root_token_ref
                      ? `secret '${settings.root_token_ref}' — enter to rotate`
                      : "PAT (private repo)"
                  }
                  style={{ width: 200, fontWeight: 400 }}
                  value={pats["__root__"] ?? ""}
                  onChange={(e) => setPats({ ...pats, __root__: e.target.value })}
                />
                <input
                  placeholder="branch"
                  style={{ width: 110, fontWeight: 400 }}
                  value={settings.root_branch ?? ""}
                  onChange={(e) => setSettings({ ...settings, root_branch: e.target.value })}
                />
              </div>
              <input
                placeholder="…or a local folder on the backend host: /mnt/c/Repos/hypothesis-workspace"
                style={{ width: "100%", marginTop: 8, fontWeight: 400 }}
                value={settings.root_path ?? ""}
                onChange={(e) => setSettings({ ...settings, root_path: e.target.value })}
              />
            </div>

            {(settings.repos ?? []).map((r, i) => (
              <div
                key={i}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: "10px 12px",
                  marginBottom: 10,
                }}
              >
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <input
                    placeholder="name (dir)"
                    style={{ width: 140 }}
                    value={r.name}
                    onChange={(e) =>
                      patchRepo(i, { name: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "-") })
                    }
                  />
                  <div className="chipset">
                    {REPO_SOURCES.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        className={`chip ${r.source === s.id ? "on" : ""}`}
                        onClick={() => patchRepo(i, { source: s.id })}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() =>
                      setSettings({
                        ...settings,
                        repos: (settings.repos ?? []).filter((_, j) => j !== i),
                      })
                    }
                  >
                    remove
                  </button>
                </div>

                <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                  {r.source === "local" && (
                    <>
                      <input
                        placeholder="/mnt/c/Repos/HYP/csh_hypotheses_back"
                        style={{ flex: 1, minWidth: 240 }}
                        value={r.path ?? ""}
                        onChange={(e) => patchRepo(i, { path: e.target.value })}
                      />
                      <input
                        placeholder="mount at (default: name)"
                        title="Target inside the workspace, e.g. .workspace-sources/hypotheses/csh_hypotheses_back"
                        style={{ width: 260 }}
                        value={r.target ?? ""}
                        onChange={(e) => patchRepo(i, { target: e.target.value })}
                      />
                    </>
                  )}
                  {r.source === "git" && (
                    <input
                      placeholder="https://gitlab.constr.dev/group/repo.git (self-hosted: use this)"
                      style={{ flex: 1, minWidth: 280 }}
                      value={r.url ?? ""}
                      onChange={(e) => patchRepo(i, { url: e.target.value })}
                    />
                  )}
                  {(r.source === "github" || r.source === "gitlab") && (
                    <input
                      placeholder={`org/repo (${ADAPTER_HOSTS[r.source]})`}
                      style={{ flex: 1, minWidth: 200 }}
                      value={slugFromUrl(r.url, ADAPTER_HOSTS[r.source])}
                      onChange={(e) =>
                        patchRepo(i, {
                          url: e.target.value.trim()
                            ? `https://${ADAPTER_HOSTS[r.source]}/${e.target.value.trim()}.git`
                            : "",
                        })
                      }
                    />
                  )}
                  {r.source !== "local" && (
                    <>
                      <input
                        type="password"
                        placeholder={
                          r.token_ref ? `secret '${r.token_ref}' — enter to rotate` : "PAT (private repos)"
                        }
                        style={{ width: 200 }}
                        value={pats[r.name] ?? ""}
                        onChange={(e) => setPats({ ...pats, [r.name]: e.target.value })}
                      />
                      <input
                        placeholder="branch"
                        style={{ width: 110 }}
                        value={r.branch ?? ""}
                        onChange={(e) => patchRepo(i, { branch: e.target.value })}
                      />
                    </>
                  )}
                </div>
              </div>
            ))}

            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() =>
                  setSettings({
                    ...settings,
                    repos: [
                      ...(settings.repos ?? []),
                      { name: `repo-${(settings.repos?.length ?? 0) + 1}`, source: "git" },
                    ],
                  })
                }
              >
                + Add source
              </button>
              <button className="primary">Save repositories</button>
              {repoSaved && <span className="hint">saved ✓</span>}
            </div>
          </form>
        )}
      </div>

      <AskAI token={token} ws={ws} />

      <div className="card">
        <h2>Coming soon (surfaces reserved per the domain model)</h2>
        <ul className="rows">
          <li>
            <div className="grow">
              <div className="name">Knowledge Graph</div>
              <div className="sub">the workspace's managed objects and relations (§3.2) — requires the graph gear</div>
            </div>
            <span className="badge">preview</span>
          </li>
          <li>
            <div className="grow">
              <div className="name">Findings & recommendations</div>
              <div className="sub">gaps, drift, contradictions → prepared actions (trust ramp §6.1)</div>
            </div>
            <span className="badge">preview</span>
          </li>
          <li>
            <div className="grow">
              <div className="name">Workflow runs</div>
              <div className="sub">library-published pipelines and their executions (§3.3)</div>
            </div>
            <span className="badge">preview</span>
          </li>
          <li>
            <div className="grow">
              <div className="name">Kits & ontology</div>
              <div className="sub">object types, templates, workflows the workspace activates (§7)</div>
            </div>
            <span className="badge">preview</span>
          </li>
        </ul>
      </div>
    </>
  );
}

/* ── Chats (mini-chat: threads, history, models) ── */

function ChatsView({ token, filters }: { token: string; filters: Filters }) {
  const [chats, setChats] = useState<import("./api").Chat[]>([]);
  const [models, setModels] = useState<import("./api").Model[]>([]);
  const [open, setOpen] = useState<import("./api").Chat | null>(null);
  const [history, setHistory] = useState<import("./api").ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [c, m] = await Promise.all([api.chats(token), api.models(token)]);
      setChats(c.items ?? []);
      setModels(m.items ?? []);
    } catch (e) {
      setError(errText(e));
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openChat(c: import("./api").Chat) {
    setOpen(c);
    setHistory([]);
    setLive(null);
    try {
      const page = await api.chatMessages(token, c.id);
      setHistory(page.items ?? []);
    } catch (e) {
      setError(errText(e));
    }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!open || !input.trim()) return;
    const content = input.trim();
    setInput("");
    setBusy(true);
    setHistory((h) => [
      ...h,
      { id: crypto.randomUUID(), role: "user", content, created_at: new Date().toISOString() },
    ]);
    setLive("…");
    try {
      await api.streamMessage(token, open.id, content, setLive);
      const page = await api.chatMessages(token, open.id);
      setHistory(page.items ?? []);
      setLive(null);
      await load();
    } catch (err) {
      setLive(null);
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(c: import("./api").Chat) {
    try {
      await api.deleteChat(token, c.id);
      if (open?.id === c.id) setOpen(null);
      await load();
    } catch (e) {
      setError(errText(e));
    }
  }

  const visibleChats = chats
    .filter((c) => matches(filters.query, c.title, c.model, c.id))
    .filter((c) => !filters.model || c.model === filters.model);

  return (
    <>
      <h1>Chats</h1>
      <p className="subtitle">
        mini-chat gear · models: {models.map((m) => m.display_name).join(", ") || "…"}
      </p>
      {error && <div className="error">{error}</div>}

      <div className="card">
        {chats.length === 0 ? (
          <p className="empty">No chats yet — start one from a workspace dashboard (Ask AI).</p>
        ) : visibleChats.length === 0 ? (
          <p className="empty">No chats match the current filters.</p>
        ) : (
          <ul className="rows">
            {visibleChats.map((c) => (
              <li key={c.id}>
                <div className="grow" style={{ cursor: "pointer" }} onClick={() => openChat(c)}>
                  <div className="name">{c.title ?? c.id.slice(0, 8)}</div>
                  <div className="sub">
                    {c.model} · {c.message_count} messages
                  </div>
                </div>
                <button onClick={() => openChat(c)}>open</button>
                <button className="ghost" onClick={() => remove(c)}>
                  delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {open && (
        <div className="card">
          <div className="card-head">
            <h2>{open.title ?? open.id.slice(0, 8)}</h2>
            <button className="ghost" onClick={() => setOpen(null)}>
              close
            </button>
          </div>
          <div style={{ maxHeight: 380, overflowY: "auto" }}>
            {history.map((m) => (
              <p key={m.id} style={{ margin: "6px 0", whiteSpace: "pre-wrap" }}>
                <strong>{m.role === "user" ? "You" : "AI"}:</strong> {m.content}
              </p>
            ))}
            {live !== null && (
              <p style={{ margin: "6px 0", whiteSpace: "pre-wrap" }}>
                <strong>AI:</strong> {live}
              </p>
            )}
          </div>
          <form className="inline" onSubmit={send}>
            <input value={input} onChange={(e) => setInput(e.target.value)} disabled={busy} />
            <button className="primary" disabled={busy || !input.trim()}>
              {busy ? "Streaming…" : "Send"}
            </button>
          </form>
        </div>
      )}
    </>
  );
}

/* ── Files (file-storage: read-only until an upload sidecar is deployed) ── */

function FilesView({ token, filters }: { token: string; filters: Filters }) {
  const [files, setFiles] = useState<import("./api").StoredFile[] | null>(null);
  const [storages, setStorages] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.files(token), api.storages(token)])
      .then(([f, s]) => {
        setFiles(f.items ?? []);
        setStorages(s);
      })
      .catch((e) => setError(errText(e)));
  }, [token]);

  const visibleFiles = (files ?? []).filter((f) =>
    matches(filters.query, f.name, f.file_name, f.id),
  );

  return (
    <>
      <h1>Files</h1>
      <p className="subtitle">
        file-storage gear. Uploads go through signed URLs served by a separate sidecar, which
        this dev assembly doesn't run yet — the view is read-only for now.
      </p>
      {error && <div className="error">{error}</div>}
      <div className="card">
        <h2>Files</h2>
        {!files || files.length === 0 ? (
          <p className="empty">No files.</p>
        ) : visibleFiles.length === 0 ? (
          <p className="empty">No files match the current filters.</p>
        ) : (
          <ul className="rows">
            {visibleFiles.map((f) => (
              <li key={f.id}>
                <div className="grow">
                  <div className="name">{f.name ?? f.file_name ?? f.id}</div>
                  <div className="sub">{f.id}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="card">
        <h2>Storages</h2>
        <pre style={{ overflow: "auto", fontSize: 12 }}>{JSON.stringify(storages, null, 2)}</pre>
      </div>
    </>
  );
}

/* ── System (observability across platform gears) ── */

function SystemView({ token, filters }: { token: string; filters: Filters }) {
  const [gears, setGears] = useState<unknown>(null);
  const [upstreams, setUpstreams] = useState<unknown>(null);
  const [entities, setEntities] = useState<unknown>(null);

  useEffect(() => {
    (async () => {
      const grab = async (p: Promise<unknown>) => p.catch((e) => ({ error: errText(e) }));
      setGears(await grab(api.gears(token)));
      setUpstreams(await grab(api.oagwUpstreams(token)));
      setEntities(await grab(api.gtsEntities(token)));
    })();
  }, [token]);

  const count = (v: unknown): string => {
    if (Array.isArray(v)) return String(v.length);
    if (v && typeof v === "object" && "items" in v && Array.isArray((v as { items: unknown[] }).items))
      return String((v as { items: unknown[] }).items.length);
    return "—";
  };

  const cards: { key: keyof Filters["sections"]; title: string; sub: string; data: unknown }[] = [
    { key: "gears", title: `Gears (${count(gears)})`, sub: "gear-orchestrator/v1/gears", data: gears },
    { key: "upstreams", title: `OAGW upstreams (${count(upstreams)})`, sub: "oagw/v1/upstreams — the openai LLM egress lives here", data: upstreams },
    { key: "entities", title: `GTS entities (${count(entities)})`, sub: "types-registry/v1/entities — tenant types, schemas, permissions, plugins", data: entities },
  ];
  const visibleCards = cards.filter((c) => filters.sections[c.key]);

  return (
    <>
      <h1>System</h1>
      <p className="subtitle">Live observability over the platform gears of this assembly.</p>
      {visibleCards.length === 0 && (
        <p className="empty">All sections are hidden — enable them in the filter panel.</p>
      )}
      {visibleCards.map((c) => (
        <div className="card" key={c.title}>
          <h2>{c.title}</h2>
          <p className="hint">{c.sub}</p>
          <pre style={{ overflow: "auto", fontSize: 12, maxHeight: 260 }}>
            {JSON.stringify(c.data, null, 2)}
          </pre>
        </div>
      ))}
    </>
  );
}

/* ── Ask AI (mini-chat gear: SSE streaming through oagw -> provider) ── */

interface ChatLine {
  role: "user" | "assistant";
  text: string;
}

function AskAI({ token, ws }: { token: string; ws: Workspace }) {
  const [chatId, setChatId] = useState<string | null>(null);
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(e: FormEvent) {
    e.preventDefault();
    const content = input.trim();
    if (!content) return;
    setBusy(true);
    setError(null);
    setInput("");
    setLines((l) => [...l, { role: "user", text: content }, { role: "assistant", text: "…" }]);
    try {
      let id = chatId;
      if (!id) {
        const chat = await api.createChat(token, `Workspace: ${ws.name}`);
        id = chat.id;
        setChatId(id);
      }
      await api.streamMessage(token, id, content, (full) =>
        setLines((l) => [...l.slice(0, -1), { role: "assistant", text: full }]),
      );
    } catch (err) {
      setLines((l) => l.slice(0, -1));
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Ask AI</h2>
      <p className="hint">
        Live chat via the mini-chat gear (SSE through oagw). Needs a real provider key in
        `static-credstore-plugin` (`openai-key`) — otherwise the stream fails at the provider.
      </p>
      {lines.length > 0 && (
        <div style={{ maxHeight: 320, overflowY: "auto", margin: "0.5rem 0" }}>
          {lines.map((l, i) => (
            <p key={i} style={{ margin: "6px 0", whiteSpace: "pre-wrap" }}>
              <strong>{l.role === "user" ? "You" : "AI"}:</strong> {l.text}
            </p>
          ))}
        </div>
      )}
      <form className="inline" onSubmit={send}>
        <input
          placeholder={`Ask about “${ws.name}”…`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
        />
        <button className="primary" disabled={busy || !input.trim()}>
          {busy ? "Streaming…" : "Send"}
        </button>
      </form>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

/* ── Projects (RG-backed, ADR-0002) ── */

function ProjectsView({
  token,
  workspaces,
  filters,
}: {
  token: string;
  workspaces: Workspace[];
  filters: Filters;
}) {
  const [wsId, setWsId] = useState("");
  const [projects, setProjects] = useState<Group[] | null>(null);
  const [name, setName] = useState("");
  const [openProject, setOpenProject] = useState<Group | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!wsId) return;
    setError(null);
    setOpenProject(null);
    try {
      const page = await api.groups(token);
      setProjects(
        (page.items ?? []).filter(
          (g) => g.type === PROJECT_RG_TYPE && g.metadata?.workspace_id === wsId,
        ),
      );
    } catch (e) {
      setError(errText(e));
    }
  }, [token, wsId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.createGroup(token, {
        type: PROJECT_RG_TYPE,
        name,
        parent_id: null,
        metadata: { workspace_id: wsId },
      });
      setName("");
      await load();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 400
          ? `${errText(err)} — если тип проекта ещё не зарегистрирован, выполните studio-backend/demo/setup-projects.sh`
          : errText(err),
      );
    }
  }

  const ws = workspaces.find((w) => w.id === wsId);
  const visible = (projects ?? []).filter((p) => matches(filters.query, p.name, p.id));

  async function removeProject(p: Group) {
    if (!window.confirm(`Delete project “${p.name}” (memberships included)?`)) return;
    setError(null);
    try {
      await api.deleteGroup(token, p.id, true); // force: cascade memberships
      await load();
    } catch (err) {
      setError(errText(err));
    }
  }

  return (
    <>
      <h1>Projects</h1>
      <p className="subtitle">
        The workspace's effort containers. In the domain model a Project is itself a managed
        object of type Project in the Knowledge Graph; until the graph ships they are
        Resource Group-backed (ADR-0002).
      </p>
      <div className="card">
        <select value={wsId} onChange={(e) => setWsId(e.target.value)}>
          <option value="">Select a workspace…</option>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name} ({w.orgName})
            </option>
          ))}
        </select>

        {wsId && projects && (
          <>
            {projects.length === 0 ? (
              <p className="empty" style={{ marginTop: 12 }}>
                No projects in “{ws?.name}” yet.
              </p>
            ) : visible.length === 0 ? (
              <p className="empty" style={{ marginTop: 12 }}>
                No projects match the current filters.
              </p>
            ) : (
              <ul className="rows" style={{ marginTop: 12 }}>
                {visible.map((p) => (
                  <li key={p.id}>
                    <div className="grow">
                      <div className="name">{p.name}</div>
                      <div className="sub">{p.id}</div>
                    </div>
                    <span className="badge">project</span>
                    <button onClick={() => setOpenProject(p)}>members</button>
                    <button className="ghost" title="Delete project" onClick={() => void removeProject(p)}>
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <form className="inline" onSubmit={create}>
              <input
                placeholder="New project name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <button className="primary" disabled={!name}>
                Create project
              </button>
            </form>
          </>
        )}
        {error && <div className="error">{error}</div>}
      </div>

      {openProject && ws && (
        <ProjectMembers
          key={openProject.id}
          token={token}
          project={openProject}
          workspace={ws}
          onClose={() => setOpenProject(null)}
        />
      )}
    </>
  );
}

function ProjectMembers({
  token,
  project,
  workspace,
  onClose,
}: {
  token: string;
  project: Group;
  workspace: Workspace;
  onClose: () => void;
}) {
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [wsUsers, setWsUsers] = useState<User[]>([]);
  const [pick, setPick] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [ms, users] = await Promise.all([
        api.memberships(token),
        api.tenantUsers(token, workspace.id),
      ]);
      setMemberIds(
        (ms.items ?? [])
          .filter((m) => m.group_id === project.id && m.resource_type === USER_MEMBER_HANDLE)
          .map((m) => m.resource_id),
      );
      setWsUsers(users.items ?? []);
    } catch (e) {
      setError(errText(e));
    }
  }, [token, project.id, workspace.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.addMembership(token, project.id, USER_MEMBER_HANDLE, pick);
      setPick("");
      await load();
    } catch (err) {
      setError(errText(err));
    }
  }

  const byId = new Map(wsUsers.map((u) => [u.id, u]));
  const candidates = wsUsers.filter((u) => !memberIds.includes(u.id));

  return (
    <div className="card">
      <div className="card-head">
        <h2>
          Members of “{project.name}” <span className="sub">({workspace.name})</span>
        </h2>
        <button className="ghost" onClick={onClose}>
          close
        </button>
      </div>
      {memberIds.length === 0 ? (
        <p className="empty">No members yet.</p>
      ) : (
        <ul className="rows">
          {memberIds.map((id) => {
            const u = byId.get(id);
            return (
              <li key={id}>
                <div className="grow">
                  <div className="name">{u?.display_name ?? u?.username ?? id}</div>
                  <div className="sub">{u ? u.username : "user outside this workspace"}</div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <form className="inline" onSubmit={add}>
        <select value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">Add workspace user…</option>
          {candidates.map((u) => (
            <option key={u.id} value={u.id}>
              {u.display_name ?? u.username}
            </option>
          ))}
        </select>
        <button className="primary" disabled={!pick}>
          Add
        </button>
      </form>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

/* ── Organizations ── */

function OrganizationsView({
  token,
  homeId,
  orgs,
  filters,
  onChanged,
}: {
  token: string;
  homeId: string;
  orgs: Tenant[];
  filters: Filters;
  onChanged: () => void;
}) {
  const visibleOrgs = orgs
    .filter((o) => matches(filters.query, o.name, o.id))
    .filter((o) =>
      filters.mode === "all" ? true : filters.mode === "self" ? o.self_managed : !o.self_managed,
    );
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inbound, setInbound] = useState<import("./api").Conversion[]>([]);

  const loadInbound = useCallback(async () => {
    try {
      const page = await api.inboundConversions(token, homeId);
      setInbound((page.items ?? []).filter((c) => c.status === "pending"));
    } catch {
      /* inbound discovery is best-effort */
    }
  }, [token, homeId]);

  useEffect(() => {
    void loadInbound();
  }, [loadInbound]);

  async function requestMode(org: Tenant) {
    setError(null);
    try {
      await api.requestConversion(token, org.id, org.self_managed ? "managed" : "self_managed");
      await loadInbound();
    } catch (e) {
      setError(errText(e));
    }
  }

  async function removeOrg(org: Tenant) {
    if (!window.confirm(`Delete organization “${org.name}”? Delete its workspaces first.`)) return;
    setError(null);
    try {
      await api.deleteTenant(token, org.id);
      onChanged();
    } catch (e) {
      setError(errText(e)); // 409 with children — expected guidance
    }
  }

  async function decide(c: import("./api").Conversion, status: "approved" | "rejected") {
    setError(null);
    try {
      await api.decideConversion(token, homeId, c.request_id ?? c.id ?? "", status);
      await loadInbound();
      onChanged(); // self_managed flag may have flipped
    } catch (e) {
      setError(errText(e));
    }
  }

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
      <p className="subtitle">
        One tenant per organization; this list is the tenant admin hierarchy (control plane —
        it governs management, never data). Workspaces live inside each tenant.
      </p>
      <div className="card">
        {orgs.length === 0 ? (
          <p className="empty">No organizations yet.</p>
        ) : visibleOrgs.length === 0 ? (
          <p className="empty">No organizations match the current filters.</p>
        ) : (
          <ul className="rows">
            {visibleOrgs.map((o) => (
              <li key={o.id}>
                <div className="grow">
                  <div className="name">{o.name}</div>
                  <div className="sub">{o.id}</div>
                </div>
                <span className="badge">{shortTypeName(o.tenant_type)}</span>
                {o.self_managed && <span className="badge selfmanaged">self-managed</span>}
                <button
                  className="ghost"
                  title="Dual-consent mode conversion: creates a pending request the org side must approve"
                  onClick={() => void requestMode(o)}
                >
                  {o.self_managed ? "→ managed" : "→ self-managed"}
                </button>
                <button className="ghost" title="Delete organization" onClick={() => void removeOrg(o)}>
                  ✕
                </button>
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

      {inbound.length > 0 && (
        <div className="card">
          <h2>Pending mode conversions (need your consent)</h2>
          <ul className="rows">
            {inbound.map((c) => (
              <li key={c.request_id ?? c.id}>
                <div className="grow">
                  <div className="name">
                    {c.child_tenant_name ?? c.tenant_id} → {c.target_mode}
                  </div>
                  <div className="sub">expires {c.expires_at ?? "—"}</div>
                </div>
                <button className="primary" onClick={() => decide(c, "approved")}>
                  Approve
                </button>
                <button onClick={() => decide(c, "rejected")}>Reject</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/* ── Members ── */

function MembersView({
  token,
  home,
  orgs,
  workspaces,
  filters,
}: {
  token: string;
  home: Tenant | null;
  orgs: Tenant[];
  workspaces: Workspace[];
  filters: Filters;
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

  const visibleUsers = (users ?? []).filter((u) =>
    matches(filters.query, u.display_name, u.username, u.email),
  );

  return (
    <>
      <h1>Members</h1>
      <p className="subtitle">
        Control-plane citizens: provisioned through the pluggable IdP contract. Roles arrive as
        Role Grants (member × role × scope) with the access-control milestone.
      </p>
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
            ) : visibleUsers.length === 0 ? (
              <p className="empty" style={{ marginTop: 12 }}>No users match the current filters.</p>
            ) : (
              <ul className="rows" style={{ marginTop: 12 }}>
                {visibleUsers.map((u) => (
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

function ProfileView({ me, home, token }: { me: Me; home: Tenant | null; token: string }) {
  const [theme, setTheme] = useState("light");
  const [language, setLanguage] = useState("en");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .userSettings(token)
      .then((p) => {
        if (p.theme) {
          setTheme(p.theme);
          document.documentElement.dataset.theme = p.theme;
        }
        if (p.language) setLanguage(p.language);
      })
      .catch((e) => setError(errText(e)));
  }, [token]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      await api.saveUserSettings(token, { theme, language });
      document.documentElement.dataset.theme = theme;
      setSaved(true);
    } catch (err) {
      setError(errText(err));
    }
  }

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

      <div className="card">
        <h2>Preferences</h2>
        <p className="hint">Stored server-side per user (simple-user-settings gear).</p>
        <form className="inline" onSubmit={save}>
          <select value={theme} onChange={(e) => setTheme(e.target.value)}>
            <option value="light">light</option>
            <option value="dark">dark</option>
          </select>
          <select value={language} onChange={(e) => setLanguage(e.target.value)}>
            <option value="en">en</option>
            <option value="ru">ru</option>
          </select>
          <button className="primary">Save</button>
          {saved && <span className="hint">saved ✓</span>}
        </form>
        {error && <div className="error">{error}</div>}
      </div>
    </>
  );
}

/* ── Studio launcher (studio-session gear → per-workspace Theia container) ── */

function StudioLauncher({
  token,
  ws,
  onClose,
}: {
  token: string;
  ws: Workspace;
  onClose: () => void;
}) {
  const [session, setSession] = useState<import("./api").StudioSession | null>(null);
  const [repos, setRepos] = useState<import("./api").RepoEntry[] | null>(null);
  const [root, setRoot] = useState<{
    path?: string;
    repoUrl?: string;
    branch?: string;
    tokenRef?: string;
  }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sources are bound on the workspace (dashboard → Repositories card);
  // the launcher just uses them.
  useEffect(() => {
    api
      .workspaceSettings(token, ws.id)
      .then((s) => {
        setRepos(s?.repos ?? []);
        setRoot({
          path: s?.root_path?.trim() || undefined,
          repoUrl: s?.root_repo_url?.trim() || undefined,
          branch: s?.root_branch?.trim() || undefined,
          tokenRef: s?.root_token_ref?.trim() || undefined,
        });
      })
      .catch(() => setRepos([]));
  }, [token, ws.id]);

  // Poll a starting session until Theia answers, then open it.
  useEffect(() => {
    if (!session || session.state !== "starting") return;
    const t = setInterval(async () => {
      try {
        const s = await api.studioSession(token, session.id);
        setSession(s);
        if (s.state === "running") window.open(s.url, "_blank", "noopener");
      } catch (e) {
        setError(errText(e));
      }
    }, 2000);
    return () => clearInterval(t);
  }, [session, token]);

  async function launch() {
    setBusy(true);
    setError(null);
    try {
      const usable = (repos ?? []).filter((r) =>
        r.source === "local" ? Boolean(r.path?.trim()) : Boolean(r.url?.trim()),
      );
      const s = await api.createStudioSession(token, ws.id, usable, root);
      setSession(s);
      if (s.state === "running") window.open(s.url, "_blank", "noopener");
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    if (!session) return;
    setError(null);
    try {
      await api.deleteStudioSession(token, session.id);
      setSession(null);
    } catch (e) {
      setError(errText(e));
    }
  }

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
        Launches a dedicated Theia IDE container for this workspace (studio-session gear). The
        session is published on loopback and stopped automatically after its maximum age.
      </p>

      {!session && (
        <>
          {(root.path || root.repoUrl) && (
            <p className="hint">
              Workspace root: <code>{root.path || root.repoUrl}</code>{" "}
              {root.path ? "(local folder)" : "(cloned on first launch)"}
            </p>
          )}
          {repos && repos.length > 0 && (
            <p className="hint">
              Workspace sources ({repos.length}):{" "}
              {repos.map((r) => `${r.name} (${r.source})`).join(", ")} — managed on the dashboard.
            </p>
          )}
          {repos && repos.length === 0 && !root.path && !root.repoUrl && (
            <p className="hint">
              No sources bound yet — the workspace opens with an empty repository. Connect
              repositories on the dashboard (Repositories card).
            </p>
          )}
          <button className="primary" onClick={launch} disabled={busy || repos === null}>
            {busy ? "Launching…" : repos === null ? "Loading…" : "Launch Studio"}
          </button>
        </>
      )}

      {session && (
        <ul className="rows">
          <li>
            <div className="grow">
              <div className="name">
                {session.state === "starting" ? "Starting container…" : `Session ${session.state}`}
              </div>
              <div className="sub">{session.url}</div>
            </div>
            <span className={`badge ${session.state === "running" ? "workspace" : ""}`}>
              {session.state}
            </span>
            {session.state === "running" && (
              <button
                className="primary"
                onClick={() => window.open(session.url, "_blank", "noopener")}
              >
                Open IDE
              </button>
            )}
            <button className="ghost" onClick={stop}>
              Stop session
            </button>
          </li>
        </ul>
      )}

      {error && <div className="error">{error}</div>}
      <p className="hint">
        Requires Docker on the backend host and the image built once:{" "}
        <code>cd fabric-poc/poc/theia && docker build -t cf-studio-theia:latest .</code>
      </p>
    </div>
  );
}
