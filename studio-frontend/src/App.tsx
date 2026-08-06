import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { env as runtimeEnv } from "./env";
import {
  api,
  ApiError,
  UNAUTHENTICATED_EVENT,
  PROJECT_RG_TYPE,
  shortTypeName,
  TENANT_TYPES,
  USER_MEMBER_HANDLE,
  type Connection,
  type ConnectorProvider,
  type Group,
  type Me,
  type RemoteRepo,
  type RepoEntry,
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
  /// Parent tenant. A connection can be attached to it instead of the
  /// workspace, which is what makes one PAT serve every workspace of an
  /// organization.
  orgId: string;
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
        setToken(null);
        setMe(null);
        // Ends the Keycloak session too (RP-initiated logout) — otherwise
        // the SSO cookie silently signs the same user back in and there is
        // no way to switch accounts. Static-token logins clear locally.
        void import("./oidc").then(({ endSsoSession }) => endSsoSession());
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

  const sso = (idpHint?: string) =>
    import("./oidc").then(({ startSsoLogin }) => startSsoLogin(idpHint));

  return (
    <div className="login-page">
      <div className="login-panel">
        <div className="logo login-logo">S</div>
        <h1 className="login-title">
          <span className="hero-gradient">Let’s start building</span>
        </h1>
        <p className="subtitle">Sign in to Constructor Studio</p>

        <button className="primary login-sso" disabled={busy} onClick={() => void sso()}>
          {busy ? "Signing in…" : "Continue with Constructor ID"}
        </button>

        {/* Federated providers — routed through Keycloak (kc_idp_hint).
            They work once the matching Identity Provider is configured in
            the realm; until then Keycloak falls back to its own form. */}
        <div className="login-providers">
          <button title="Google (via Keycloak identity federation)" disabled={busy} onClick={() => void sso("google")}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#4285F4" d="M23.5 12.3c0-.9-.1-1.5-.3-2.2H12v4.1h6.5c-.1 1.1-.8 2.7-2.4 3.8l3.7 2.9c2.3-2.1 3.7-5.1 3.7-8.6z"/><path fill="#34A853" d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.7-2.9c-1 .7-2.4 1.2-4.2 1.2-3.1 0-5.8-2.1-6.7-5l-3.9 3C3.3 21.3 7.3 24 12 24z"/><path fill="#FBBC05" d="M5.3 14.4a7.4 7.4 0 0 1 0-4.7l-3.9-3a12 12 0 0 0 0 10.7l3.9-3z"/><path fill="#EA4335" d="M12 4.7c1.8 0 3 .8 3.7 1.4l3.3-3.2C17.9 1.1 15.2 0 12 0 7.3 0 3.3 2.7 1.4 6.7l3.9 3c.9-2.9 3.6-5 6.7-5z"/></svg>
          </button>
          <button title="GitHub (via Keycloak identity federation)" disabled={busy} onClick={() => void sso("github")}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 .5A11.5 11.5 0 0 0 .5 12a11.5 11.5 0 0 0 7.9 10.9c.6.1.8-.2.8-.5v-2c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.4-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0C19.3 4.7 20.3 5 20.3 5c.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.2c0 .3.2.6.8.5A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5z"/></svg>
          </button>
          <button title="Microsoft (via Keycloak identity federation)" disabled={busy} onClick={() => void sso("microsoft")}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="1" y="1" width="10" height="10" fill="#F25022"/><rect x="13" y="1" width="10" height="10" fill="#7FBA00"/><rect x="1" y="13" width="10" height="10" fill="#00A4EF"/><rect x="13" y="13" width="10" height="10" fill="#FFB900"/></svg>
          </button>
        </div>

        {error && <div className="error">{error}</div>}

        {/* Static-profile escape hatch: dev tokens, tucked away. */}
        <details className="login-dev">
          <summary>Developer sign-in (static token)</summary>
          <form onSubmit={submit} className="inline">
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="studio-admin-token"
            />
            <button disabled={busy || !value}>Sign in</button>
          </form>
          <p className="hint">
            Works with the static profiles only; SSO needs <code>config/oidc.yaml</code> +{" "}
            <code>docker compose up -d keycloak</code> (admin/demo, password <code>studio</code>).
          </p>
        </details>
      </div>
    </div>
  );
}

/* ── App shell ── */

type View =
  | "home"
  | "organizations"
  | "workspaces"
  | "chats"
  | "members"
  | "files"
  | "secrets"
  | "connectors"
  | "system"
  | "profile";

/** Monochrome line icons (lucide-style): consistent stroke, currentColor —
 *  they inherit the nav's text/accent color instead of emoji potpourri. */
function NavIcon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    home: (
      <>
        <path d="m3 11 9-8 9 8" />
        <path d="M5 10v11h14V10" />
      </>
    ),
    org: (
      <>
        <rect x="4" y="3" width="16" height="18" rx="1" />
        <path d="M9 7h1.5M13.5 7H15M9 11h1.5M13.5 11H15M9 15h1.5M13.5 15H15M10 21v-3h4v3" />
      </>
    ),
    grid: (
      <>
        <rect x="3" y="3" width="7.5" height="7.5" rx="1" />
        <rect x="13.5" y="3" width="7.5" height="7.5" rx="1" />
        <rect x="3" y="13.5" width="7.5" height="7.5" rx="1" />
        <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1" />
      </>
    ),
    users: (
      <>
        <circle cx="9" cy="8" r="3.5" />
        <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
        <path d="M16 4.8a3.5 3.5 0 0 1 0 6.4M21 20c0-2.6-1.7-4.9-4-5.7" />
      </>
    ),
    key: (
      <>
        <circle cx="8" cy="15" r="4" />
        <path d="m11 12 9-9M17 4l3 3M14 7l2.5 2.5" />
      </>
    ),
    chat: <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-3.4-.8L3 21l1.9-5.6A8.4 8.4 0 1 1 21 11.5z" />,
    file: (
      <>
        <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" />
        <path d="M14 3v5h5" />
      </>
    ),
    plug: (
      <>
        <path d="M8 3 4 7l4 4M4 7h16" />
        <path d="m16 13 4 4-4 4M20 17H4" />
      </>
    ),
    cog: (
      <>
        <circle cx="12" cy="12" r="3.2" />
        <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1" />
      </>
    ),
  };
  return (
    <svg
      viewBox="0 0 24 24"
      width="17"
      height="17"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? <circle cx="12" cy="12" r="8" />}
    </svg>
  );
}

// Sectioned nav (console-style), grouped by the domain model's layers:
// the CONTROL PLANE (tenant admin hierarchy, working contexts, citizens,
// credentials), the WORK surfaces, and MONITORING. Projects are NOT a
// top-level surface — in the model a Project is a managed object living in
// a workspace's context, managed from the Workspace Dashboard. Profile
// moved to the bottom account menu.
// The MAIN portal is pure work (console pattern): administration —
// organizations, members, secrets — lives in the separate Admin area,
// reached from the account menu / product switcher.
const NAV_SECTIONS: { title: string | null; items: { id: View; icon: string; label: string }[] }[] = [
  { title: null, items: [{ id: "home", icon: "home", label: "Home" }] },
  {
    title: "Work",
    items: [
      { id: "workspaces", icon: "org", label: "Organizations" },
      { id: "chats", icon: "chat", label: "Chats" },
      { id: "files", icon: "file", label: "Files" },
      { id: "connectors", icon: "plug", label: "Connectors" },
    ],
  },
  {
    title: "Monitor",
    items: [{ id: "system", icon: "cog", label: "System" }],
  },
];

type AdminView = "organizations" | "members" | "workspaces" | "secrets";

const ADMIN_NAV: { id: AdminView; icon: string; label: string }[] = [
  { id: "organizations", icon: "org", label: "Organization" },
  { id: "members", icon: "users", label: "Members" },
  { id: "workspaces", icon: "grid", label: "Workspaces" },
  { id: "secrets", icon: "key", label: "Secrets" },
];

function Shell({ token, me, onLogout }: { token: string; me: Me; onLogout: () => void }) {
  const [view, setView] = useState<View>("home");
  /** Position in the organization → workspace drill-down. */
  const [crumb, setCrumb] = useState<Crumb>({});
  const [accountMenu, setAccountMenu] = useState(false);
  const [productMenu, setProductMenu] = useState(false);
  // Admin area (console pattern): a separate mode with its own sidebar for
  // organizations / members / workspaces administration.
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminView, setAdminView] = useState<AdminView>("organizations");
  // Which organization the admin area is scoped to ("__new__" = create hero).
  const [adminOrgId, setAdminOrgId] = useState<string | null>(null);
  const [adminOrgMenu, setAdminOrgMenu] = useState(false);
  const openAdmin = (v: AdminView = "organizations", orgId?: string) => {
    setAdminOpen(true);
    setAdminView(v);
    if (orgId) setAdminOrgId(orgId);
    setActiveSpace(null);
    setDash(null);
    setStudio(null);
    setAccountMenu(false);
    setProductMenu(false);
  };
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("studio.sidebar") === "collapsed";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("studio.sidebar", sidebarCollapsed ? "collapsed" : "open");
    } catch {
      /* non-fatal */
    }
  }, [sidebarCollapsed]);
  const [home, setHome] = useState<Tenant | null>(null);
  const [orgs, setOrgs] = useState<Tenant[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [studio, setStudio] = useState<Workspace | null>(null);
  const [dash, setDash] = useState<Workspace | null>(null);
  // Spaces: embedded IDE sessions living INSIDE the portal window. Every
  // space keeps its iframe mounted (hidden, not unmounted), so switching
  // between the portal and sessions never reloads Theia.
  const [spaces, setSpaces] = useState<
    { wsId: string; wsName: string; url: string; sessionId: string }[]
  >([]);
  // Initialized FROM the URL: the sync effect below runs on mount and would
  // otherwise rewrite /space/{id} to / before the restore logic reads it.
  const [activeSpace, setActiveSpace] = useState<string | null>(
    () => window.location.pathname.match(/^\/space\/([0-9a-f-]{36})$/)?.[1] ?? null,
  );

  const openSpace = useCallback(
    (ws: Workspace, session: { id: string; url: string }, activate = true) => {
      setSpaces((prev) =>
        prev.some((s) => s.wsId === ws.id)
          ? prev.map((s) =>
              s.wsId === ws.id ? { ...s, url: session.url, sessionId: session.id } : s,
            )
          : [...prev, { wsId: ws.id, wsName: ws.name, url: session.url, sessionId: session.id }],
      );
      if (activate) setActiveSpace(ws.id);
      setStudio(null);
    },
    [],
  );

  const closeSpace = useCallback((wsId: string) => {
    setSpaces((prev) => prev.filter((s) => s.wsId !== wsId));
    setActiveSpace((a) => (a === wsId ? null : a));
  }, []);

  /* ── Space routing & restore ──
     The URL mirrors the active space (/space/{wsId} ↔ /), the list of open
     spaces persists in sessionStorage, and after a reload every space with
     a LIVE session is remounted silently — the one from the URL activated.
     A dead session in the URL falls back to the launcher (auto-launch). */
  const restoredRef = useRef(false);
  // The URL as it was BEFORE any state→URL sync could touch it.
  const initialSpaceRef = useRef<string | null>(
    window.location.pathname.match(/^\/space\/([0-9a-f-]{36})$/)?.[1] ?? null,
  );

  useEffect(() => {
    // URL ← state (replace, not push: spaces are switched often).
    const path = activeSpace ? `/space/${activeSpace}` : "/";
    if (window.location.pathname !== path) window.history.pushState(null, "", path);
  }, [activeSpace]);

  useEffect(() => {
    try {
      sessionStorage.setItem(
        "studio.spaces",
        JSON.stringify(spaces.map((s) => ({ wsId: s.wsId, wsName: s.wsName }))),
      );
    } catch {
      /* non-fatal */
    }
  }, [spaces]);

  useEffect(() => {
    // Back/forward buttons switch space ↔ portal.
    const onPop = () => {
      const m = window.location.pathname.match(/^\/space\/([0-9a-f-]{36})$/);
      setActiveSpace(m ? m[1] : null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const pendingLaunchRef = useRef<string | null>(null);

  useEffect(() => {
    // One-shot restore, WITHOUT waiting for the workspace list: names come
    // from sessionStorage, liveness from one sessions call — the IDE frame
    // starts loading seconds earlier than the AM catalog finishes.
    if (restoredRef.current) return;
    restoredRef.current = true;
    void (async () => {
      let saved: { wsId: string; wsName: string }[] = [];
      try {
        const raw = JSON.parse(sessionStorage.getItem("studio.spaces") ?? "[]") as unknown[];
        saved = raw
          .map((e) =>
            typeof e === "string"
              ? { wsId: e, wsName: "Workspace" } // legacy format
              : (e as { wsId: string; wsName: string }),
          )
          .filter((e) => e?.wsId);
      } catch {
        /* corrupt state — start clean */
      }
      const urlWs = initialSpaceRef.current;
      if (urlWs && !saved.some((s) => s.wsId === urlWs)) {
        saved.push({ wsId: urlWs, wsName: "Workspace" });
      }
      if (saved.length === 0) return;
      const live = await api.studioSessions(token).then(
        (p) => p.items.filter((s) => s.state !== "stopped"),
        () => [],
      );
      for (const entry of saved) {
        const session = live.find((s) => s.workspace_id === entry.wsId);
        if (session) {
          openSpace(
            { id: entry.wsId, name: entry.wsName } as Workspace,
            session,
            entry.wsId === urlWs,
          );
        } else if (entry.wsId === urlWs) {
          pendingLaunchRef.current = entry.wsId; // needs the workspace object
        }
      }
    })();
  }, [token, openSpace]);

  useEffect(() => {
    // Dead-session fallback: the launcher needs the real Workspace object,
    // so this half waits for the catalog.
    if (!pendingLaunchRef.current || workspaces.length === 0) return;
    const ws = workspaces.find((w) => w.id === pendingLaunchRef.current);
    pendingLaunchRef.current = null;
    if (ws) setStudio(ws);
  }, [workspaces]);

  /* ── Portal ↔ IDE bridge (postMessage) ──
     Outbound: theme on iframe load + on portal theme change. Inbound:
     studio.status {dirty} — origin-checked against known space URLs. */
  const [spaceDirty, setSpaceDirty] = useState<Record<string, number>>({});
  const spaceOrigin = (url: string): string => {
    try {
      return new URL(url).origin;
    } catch {
      return "";
    }
  };

  /* studio.init retry: the iframe's first load events are the session gate's
     redirect/splash pages — Theia's bridge isn't listening yet, so a single
     onLoad handshake is lost and the IDE never gets the theme/token. Repeat
     until the bridge answers with studio.status (its ack to studio.init). */
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const initTimersRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const stopInitRetry = (wsId: string) => {
    const t = initTimersRef.current[wsId];
    if (t !== undefined) {
      clearInterval(t);
      delete initTimersRef.current[wsId];
    }
  };

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const sp = spaces.find((s) => spaceOrigin(s.url) === e.origin);
      if (!sp) return; // only embedded sessions are trusted senders
      const d = e.data as { type?: string; dirty?: number };
      if (typeof d?.type === "string" && d.type.startsWith("studio.")) {
        stopInitRetry(sp.wsId); // the bridge is alive — handshake done
      }
      if (d?.type === "studio.status" && typeof d.dirty === "number") {
        const dirty = d.dirty; // narrow before the closure
        setSpaceDirty((prev) =>
          prev[sp.wsId] === dirty ? prev : { ...prev, [sp.wsId]: dirty },
        );
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [spaces]);

  useEffect(() => {
    // Broadcast portal theme changes to every mounted space.
    const send = () => {
      const theme = document.documentElement.dataset.theme ?? "light";
      document.querySelectorAll<HTMLIFrameElement>("iframe.space-frame").forEach((f) => {
        const origin = f.dataset.origin;
        if (origin) f.contentWindow?.postMessage({ type: "studio.theme", theme }, origin);
      });
    };
    const mo = new MutationObserver(send);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    // Silent renew: hand the fresh token to every mounted space.
    document.querySelectorAll<HTMLIFrameElement>("iframe.space-frame").forEach((f) => {
      const origin = f.dataset.origin;
      if (origin) f.contentWindow?.postMessage({ type: "studio.token", apiToken: token }, origin);
    });
  }, [token]);
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

  // The saved theme applies on login, not on the first visit to Profile —
  // ProfileView only edits it.
  useEffect(() => {
    api
      .userSettings(token)
      .then((p) => {
        if (p.theme) document.documentElement.dataset.theme = p.theme;
      })
      .catch(() => {
        /* theme is cosmetic — never block the shell on it */
      });
  }, [token]);

  // Who is signed in — from the token claims (display only; the backend
  // validates). Static dev tokens are opaque → fall back to the subject id.
  const claims = decodeJwtClaims(token);
  const claimStr = (k: string): string | null => {
    const v = claims?.[k];
    return typeof v === "string" && v.trim() ? v : null;
  };
  const userName =
    claimStr("name") ?? claimStr("preferred_username") ?? `${me.subject_id.slice(0, 8)}…`;
  const userEmail = claimStr("email");
  const userInitials = userName
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  // Resolved AFTER home/orgs state exists (declaration order matters).
  const adminOrg =
    orgs.find((o) => o.id === adminOrgId) ??
    (home?.tenant_type === TENANT_TYPES.organization ? (home as Tenant) : orgs[0]) ??
    null;

  const panelView: PanelView = dash ? "dashboard" : view;

  const refresh = useCallback(async () => {
    setError(null);
    try {
      // The home tenant comes from the validated token. If it no longer
      // exists (deleted), say so plainly instead of raising a raw 404.
      const homeTenant = await api.tenant(token, me.subject_tenant_id).catch((e) => {
        if (e instanceof ApiError && e.status === 404) {
          throw new Error(
            `Your home tenant (${me.subject_tenant_id}) no longer exists — it was probably deleted. ` +
              `Re-create it or sign in as a user whose home tenant is alive.`,
          );
        }
        throw e;
      });
      const page = await api
        .tenantChildren(token, me.subject_tenant_id)
        .catch((e) => (e instanceof ApiError && e.status === 404 ? { items: [] } : Promise.reject(e)));
      setHome(homeTenant);
      const children = page.items ?? [];
      const orgList = children.filter((t) => t.tenant_type === TENANT_TYPES.organization);
      const directWs = children
        .filter((t) => t.tenant_type === TENANT_TYPES.workspace)
        .map((t) => ({ ...t, orgName: homeTenant.name, orgId: homeTenant.id }));
      // Workspaces live under organizations — fetch each org's children.
      // A self-managed org raises the visibility barrier: from outside its
      // subtree the backend answers 404. That's tenant isolation working,
      // not an error — skip such orgs instead of failing the whole view.
      const nested = await Promise.all(
        orgList.map(async (org): Promise<Workspace[]> => {
          // A self-managed org raises the barrier by design — don't even ask
          // (the 404 would be correct, but it clutters the browser console).
          if (org.self_managed) return [];
          try {
            const kids = await api.tenantChildren(token, org.id);
            return (kids.items ?? [])
              .filter((t) => t.tenant_type === TENANT_TYPES.workspace)
              .map((t) => ({ ...t, orgName: org.name, orgId: org.id }));
          } catch {
            return []; // barrier or no access — org stays visible, contents don't
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
      <aside className={`sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
        {/* Product switcher (console pattern): the portal is one door of the
            product family — API docs and the IdP admin are the real others. */}
        <div className="wordmark product-switch">
          <button className="product-button" onClick={() => setProductMenu((v) => !v)}>
            <div className="logo">S</div>
            <strong>Studio</strong>
            <span className="chev">▾</span>
          </button>
          <button
            className="sidebar-toggle"
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => {
              setSidebarCollapsed((v) => !v);
              setProductMenu(false);
              setAccountMenu(false);
            }}
          >
            {sidebarCollapsed ? "⟩" : "⟨"}
          </button>
          {productMenu && (
            <div className="product-menu">
              <button onClick={() => setProductMenu(false)}>
                <span className="ico">▦</span> Studio <span className="check">✓</span>
              </button>
              <button
                onClick={() => {
                  window.open("/cf/docs", "_blank", "noopener");
                  setProductMenu(false);
                }}
              >
                <span className="ico">⧉</span> Docs &amp; API
              </button>
              <button title="Organizations, members, workspaces administration" onClick={() => openAdmin()}>
                <span className="ico">🛡</span> Admin
              </button>
            </div>
          )}
        </div>
        <nav>
          {adminOpen ? (
            <>
              <div className="nav-section">
                <button title="Back to Studio" onClick={() => setAdminOpen(false)}>
                  <span className="ico">←</span> Back to Studio
                </button>
              </div>
              {/* Org selector: every admin view below is scoped to it. */}
              <div className="nav-section org-select-wrap">
                <button className="org-select" onClick={() => setAdminOrgMenu((v) => !v)}>
                  <span className="account-avatar small">
                    {(adminOrgId === "__new__" ? "+" : (adminOrg?.name ?? "?")).slice(0, 1).toUpperCase()}
                  </span>
                  <span className="org-select-name">
                    {adminOrgId === "__new__" ? "New organization" : adminOrg?.name ?? "Select organization"}
                  </span>
                  <span className="chev">▾</span>
                </button>
                {adminOrgMenu && (
                  <div className="org-menu">
                    {orgs.map((o) => (
                      <button
                        key={o.id}
                        onClick={() => {
                          setAdminOrgId(o.id);
                          setAdminOrgMenu(false);
                        }}
                      >
                        <span className="account-avatar small">{o.name.slice(0, 1).toUpperCase()}</span>
                        {o.name} {o.self_managed ? "🔒" : ""}
                      </button>
                    ))}
                    <button
                      onClick={() => {
                        setAdminOrgId("__new__");
                        setAdminView("organizations");
                        setAdminOrgMenu(false);
                      }}
                    >
                      ＋ New organization
                    </button>
                  </div>
                )}
              </div>
              <div className="nav-section">
                <div className="nav-section-title admin-title">Administration</div>
                {ADMIN_NAV.map((n) => (
                  <button
                    key={n.id}
                    className={adminView === n.id ? "active" : ""}
                    title={n.label}
                    onClick={() => setAdminView(n.id)}
                  >
                    <span className="ico"><NavIcon name={n.icon} /></span> {n.label}
                  </button>
                ))}
              </div>
              <div className="nav-section">
                <div className="nav-section-title admin-title">IdP</div>
                <button
                  title="Keycloak administration console"
                  onClick={() => window.open("https://localhost:8443/admin/", "_blank", "noopener")}
                >
                  <span className="ico">🛡</span> IdP console ↗
                </button>
              </div>
            </>
          ) : (
            NAV_SECTIONS.map((sec) => (
              <div key={sec.title ?? "_top"} className="nav-section">
                {sec.title && <div className="nav-section-title">{sec.title}</div>}
                {sec.items.map((n) => (
                  <button
                    key={n.id}
                    className={view === n.id && !activeSpace ? "active" : ""}
                    title={n.label}
                    onClick={() => {
                      setView(n.id);
                      setActiveSpace(null); // portal navigation leaves the space
                    }}
                  >
                    <span className="ico"><NavIcon name={n.icon} /></span> {n.label}
                  </button>
                ))}
              </div>
            ))
          )}
          {spaces.length > 0 && (
            <div className="nav-spaces">
              <div className="nav-spaces-title">Spaces</div>
              {spaces.map((s) => (
                <div key={s.wsId} className="space-row">
                  <button
                    className={activeSpace === s.wsId ? "active" : ""}
                    onClick={() => {
                      setActiveSpace(s.wsId);
                      setAdminOpen(false); // a space is a Studio surface
                    }}
                    title={`Switch to ${s.wsName}${
                      spaceDirty[s.wsId] ? ` — ${spaceDirty[s.wsId]} unsaved file(s)` : ""
                    }`}
                  >
                    <span className="ico">⚙</span> {s.wsName}
                    {(spaceDirty[s.wsId] ?? 0) > 0 && <span className="dirty-dot">●</span>}
                  </button>
                  <button
                    className="ghost space-x"
                    title="Close space (the session keeps running)"
                    onClick={() => closeSpace(s.wsId)}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </nav>
        <div className="spacer" />
        <div className="whoami">
          {accountMenu && (
            <div className="account-menu">
              <div className="account-menu-head">
                <span className="account-user">{userName}</span>
                {userEmail && <span>{userEmail}</span>}
                <span>{home ? `Home: ${home.name}` : ""}</span>
                {/* The home tenant IS the access scope — say so explicitly. */}
                {home && (
                  <span
                    className="scope-line"
                    title="Your home tenant anchors what you can see: its whole subtree, pruned at self-managed barriers."
                  >
                    {home.tenant_type === TENANT_TYPES.organization
                      ? `Scope: ${home.name} subtree`
                      : `Scope: entire platform${
                          orgs.filter((o) => o.self_managed).length
                            ? ` · ${orgs.filter((o) => o.self_managed).length} self-managed hidden`
                            : ""
                        }`}
                  </span>
                )}
              </div>
              {orgs.length > 0 && (
                <div className="account-orgs">
                  <div className="account-orgs-title">Your organizations</div>
                  {orgs.map((o) => (
                    <button
                      key={o.id}
                      className={crumb.orgId === o.id && !crumb.wsId ? "on" : ""}
                      onClick={() => {
                        setAdminOpen(false);
                        setCrumb({ orgId: o.id });
                        setView("workspaces");
                        setActiveSpace(null);
                        setAccountMenu(false);
                      }}
                    >
                      <span className="account-avatar small">{o.name.slice(0, 1).toUpperCase()}</span>
                      {o.name}
                      {o.self_managed && <span className="badge selfmanaged">🔒</span>}
                    </button>
                  ))}
                </div>
              )}
              {workspaces.length > 0 && (
                <div className="account-orgs">
                  <div className="account-orgs-title">Workspaces</div>
                  {workspaces.map((w) => (
                    <button
                      key={w.id}
                      className={crumb.wsId === w.id ? "on" : ""}
                      onClick={() => {
                        // Switching context, not navigating to a page about a
                        // workspace: the app below becomes that workspace.
                        setAdminOpen(false);
                        setCrumb({ orgId: w.orgId, wsId: w.id });
                        setView("workspaces");
                        setActiveSpace(null);
                        setAccountMenu(false);
                      }}
                    >
                      <span className="account-avatar small">{w.name.slice(0, 1).toUpperCase()}</span>
                      {w.name}
                      <span className="sub"> · {w.orgName}</span>
                    </button>
                  ))}
                </div>
              )}
              <button
                onClick={() => {
                  setAdminOpen(false);
                  setView("profile");
                  setActiveSpace(null);
                  setAccountMenu(false);
                }}
              >
                Profile
              </button>
              <button onClick={() => openAdmin()}>Admin settings</button>
              <button onClick={onLogout}>Sign out</button>
            </div>
          )}
          <button
            className="account-button"
            onClick={() => setAccountMenu((v) => !v)}
            title="Account"
          >
            <span className="account-avatar">{userInitials}</span>
            <span className="account-lines">
              <span className="account-name">{userName}</span>
              {/* The context lives here, next to the identity — the two
                  questions "who am I" and "where am I" get one answer spot. */}
              <span className="scope-line">
                {workspaces.find((w) => w.id === crumb.wsId)?.name ??
                  orgs.find((o) => o.id === crumb.orgId)?.name ??
                  userEmail ??
                  home?.name ??
                  ""}
              </span>
            </span>
          </button>
        </div>
      </aside>

      {/* Spaces host: all session iframes stay mounted; only the active one
          is visible, so switching never reloads the IDE. */}
      {/* While the portal is active the host stays rendered but parked as a
          transparent background layer — display:none would throttle every
          embedded session's WebSocket (see .space-frames note). */}
      <div
        className="spaces-host"
        style={
          activeSpace
            ? { display: "flex" }
            : {
                display: "flex",
                position: "fixed",
                inset: 0,
                zIndex: -1,
                opacity: 0,
                pointerEvents: "none",
              }
        }
      >
        {activeSpace &&
          (() => {
            const sp = spaces.find((s) => s.wsId === activeSpace);
            return sp ? (
              <div className="space-bar">
                <span>⚙ {sp.wsName}</span>
                <a href={sp.url} target="_blank" rel="noopener noreferrer">
                  open in tab ↗
                </a>
              </div>
            ) : null;
          })()}
        {activeSpace && !spaces.some((s) => s.wsId === activeSpace) && (
          <p className="hint" style={{ padding: 16 }}>
            Reconnecting the space…
          </p>
        )}
        {/* Inactive frames stay RENDERED (opacity 0, stacked) — display:none
            makes Chrome throttle hidden cross-origin iframes, Theia misses
            its WebSocket keepalive and the session reconnect-loops. */}
        <div className="space-frames">
          {spaces.map((s) => (
            <iframe
              key={s.wsId}
              className="space-frame"
              src={s.url}
              title={`Studio — ${s.wsName}`}
              allow="clipboard-read; clipboard-write"
              data-origin={spaceOrigin(s.url)}
              onLoad={(e) => {
                // Handshake: theme + the caller's API token (the IDE calls the
                // gears same-origin through the session gate's /studio-api/*).
                // Retried every 2s until the bridge acks (studio.status): the
                // first load events are the gate's redirect/splash, where
                // nobody is listening yet. Splash reloads re-fire onLoad —
                // reset the timer each time.
                const frame = e.currentTarget;
                const origin = spaceOrigin(s.url);
                const post = () => {
                  const theme = document.documentElement.dataset.theme ?? "light";
                  frame.contentWindow?.postMessage(
                    { type: "studio.init", theme, apiToken: tokenRef.current },
                    origin,
                  );
                };
                post();
                stopInitRetry(s.wsId);
                let tries = 0;
                initTimersRef.current[s.wsId] = setInterval(() => {
                  if (++tries > 150) {
                    stopInitRetry(s.wsId); // ~5 min — session is not coming up
                    return;
                  }
                  post();
                }, 2000);
              }}
              style={
                activeSpace === s.wsId
                  ? { opacity: 1, zIndex: 1, pointerEvents: "auto" }
                  : { opacity: 0, zIndex: 0, pointerEvents: "none" }
              }
            />
          ))}
        </div>
      </div>

      <div className="content" style={activeSpace ? { display: "none" } : undefined}>
        {error && <div className="error">{error}</div>}
        {adminOpen ? (
          <>
            {adminView === "organizations" && (
              <OrganizationsView
                token={token}
                homeId={me.subject_tenant_id}
                home={home}
                orgs={orgs}
                workspaces={workspaces}
                selectedOrgId={adminOrgId}
                onChanged={refresh}
                onCreated={(id) => setAdminOrgId(id || null)}
                onNew={() => setAdminOrgId("__new__")}
              />
            )}
            {adminView === "members" && (
              <MembersView
                token={token}
                home={home}
                orgs={orgs}
                workspaces={workspaces}
                filters={filters}
                fixedTenantId={adminOrg?.id ?? null}
              />
            )}
            {adminView === "workspaces" && (
              <WorkspacesView
                token={token}
                orgs={adminOrg ? [adminOrg] : orgs}
                workspaces={adminOrg ? workspaces.filter((w) => w.orgName === adminOrg.name) : workspaces}
                filters={filters}
                onChanged={refresh}
                onOpenStudio={(ws) => {
                  setAdminOpen(false);
                  setStudio(ws);
                }}
                onOpen={(ws) => {
                  // Admin lists workspaces across the platform; opening one
                  // hands over to the normal drill-down rather than growing a
                  // second workspace page inside the admin zone.
                  setAdminOpen(false);
                  setCrumb({ orgId: ws.orgId, wsId: ws.id });
                  setView("workspaces");
                }}
              />
            )}
            {adminView === "secrets" && <SecretsView token={token} workspaces={workspaces} filters={filters} />}
          </>
        ) : dash ? (
          <WorkspaceDashboard
            token={token}
            ws={dash}
            onBack={() => setDash(null)}
            onOpenStudio={setStudio}
          />
        ) : (
          <>
        {view === "workspaces" && (
          <BrowseView
            token={token}
            home={home}
            orgs={orgs}
            workspaces={workspaces}
            filters={filters}
            crumb={crumb}
            setCrumb={setCrumb}
            onChanged={refresh}
            onOpenStudio={setStudio}
          />
        )}
        {view === "home" && (
          <HomeView
            token={token}
            home={home}
            orgs={orgs}
            workspaces={workspaces}
            spaces={spaces}
            onOpenSpace={(wsId) => setActiveSpace(wsId)}
            onOpenStudio={setStudio}
            onOpenDashboard={setDash}
            onNavigate={setView}
          />
        )}
        {view === "secrets" && <SecretsView token={token} workspaces={workspaces} filters={filters} />}
        {view === "connectors" && <ConnectorsView token={token} workspaces={workspaces} filters={filters} />}
        {/* organizations/members render only inside the Admin area now. */}
        {view === "chats" && <ChatsView token={token} filters={filters} />}
        {view === "files" && <FilesView token={token} filters={filters} />}
        {view === "system" && <SystemView token={token} filters={filters} />}
        {view === "profile" && <ProfileView me={me} home={home} token={token} />}
          </>
        )}
        {studio && (
          <StudioLauncher
            token={token}
            ws={studio}
            onClose={() => setStudio(null)}
            onOpen={(s) => openSpace(studio, s)}
          />
        )}
      </div>

      {!activeSpace && (
        <FilterPanel
          view={panelView}
          token={token}
          filters={filters}
          onChange={setFilters}
          open={panelOpen}
          onToggle={() => setPanelOpen((v) => !v)}
          orgs={orgs}
        />
      )}
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

/* ── Browse: organization → workspace drill-down ───────────────────────────
 *
 * The portal's spine. Every level shows what it contains and what it owns, and
 * the crumb says where you are — instead of a flat set of screens where
 * "Connectors" and "Secrets" floated free of the thing they belong to.
 * Projects become the level below a workspace.
 */

interface Crumb {
  orgId?: string;
  wsId?: string;
}

function Breadcrumbs({
  items,
}: {
  items: { label: string; onClick?: () => void }[];
}) {
  return (
    <nav className="crumbs">
      {items.map((it, i) => (
        <span key={`${it.label}-${i}`}>
          {i > 0 && <span className="crumb-sep">/</span>}
          {it.onClick ? (
            <button type="button" className="linklike" onClick={it.onClick}>
              {it.label}
            </button>
          ) : (
            <span className="crumb-here">{it.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

function BrowseView({
  token,
  home,
  orgs,
  workspaces,
  filters,
  crumb,
  setCrumb,
  onChanged,
  onOpenStudio,
}: {
  token: string;
  home: Tenant | null;
  orgs: Tenant[];
  workspaces: Workspace[];
  filters: Filters;
  crumb: Crumb;
  setCrumb: (c: Crumb) => void;
  onChanged: () => void;
  onOpenStudio: (ws: Workspace) => void;
}) {
  const org = orgs.find((o) => o.id === crumb.orgId);
  const ws = workspaces.find((w) => w.id === crumb.wsId);

  const trail: { label: string; onClick?: () => void }[] = [
    { label: "Organizations", onClick: org ? () => setCrumb({}) : undefined },
  ];
  if (org) {
    trail.push({
      label: org.name,
      onClick: ws ? () => setCrumb({ orgId: org.id }) : undefined,
    });
  }
  if (ws) trail.push({ label: ws.name });

  return (
    <>
      <Breadcrumbs items={trail} />
      {!org ? (
        <OrganizationsLevel
          token={token}
          home={home}
          orgs={orgs}
          workspaces={workspaces}
          filters={filters}
          onChanged={onChanged}
          onOpen={(o) => setCrumb({ orgId: o.id })}
        />
      ) : !ws ? (
        <OrganizationLevel
          token={token}
          org={org}
          workspaces={workspaces.filter((w) => w.orgId === org.id)}
          filters={filters}
          onChanged={onChanged}
          onOpenStudio={onOpenStudio}
          onOpenWorkspace={(w) => setCrumb({ orgId: org.id, wsId: w.id })}
          onDeleted={() => {
            setCrumb({});
            onChanged();
          }}
        />
      ) : (
        <WorkspaceLevel
          token={token}
          ws={ws}
          onOpenStudio={onOpenStudio}
          onBack={() => setCrumb({ orgId: org.id })}
        />
      )}
    </>
  );
}

/** Level 0 — the organizations you can see, and creating one. */
function OrganizationsLevel({
  token,
  home,
  orgs,
  workspaces,
  filters,
  onChanged,
  onOpen,
}: {
  token: string;
  home: Tenant | null;
  orgs: Tenant[];
  workspaces: Workspace[];
  filters: Filters;
  onChanged: () => void;
  onOpen: (o: Tenant) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visible = orgs.filter((o) => matches(filters.query, o.name));

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!home) return;
    setBusy(true);
    setError(null);
    try {
      await api.createTenant(token, {
        name,
        parent_id: home.id,
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
        An organization owns workspaces, the people in them, and the connectors they share. Open one
        to work inside it.
      </p>
      <div className="card">
        {visible.length === 0 ? (
          <p className="empty">No organizations yet — create the first one below.</p>
        ) : (
          <ul className="rows">
            {visible.map((o) => {
              const count = workspaces.filter((w) => w.orgId === o.id).length;
              return (
                <li key={o.id}>
                  <div
                    className="grow"
                    style={{ cursor: "pointer" }}
                    onClick={() => onOpen(o)}
                    title="Open this organization"
                  >
                    <div className="name">{o.name}</div>
                    <div className="sub">
                      {count} workspace{count === 1 ? "" : "s"}
                    </div>
                  </div>
                  {o.self_managed && <span className="badge selfmanaged">self-managed</span>}
                  <button onClick={() => onOpen(o)}>Open</button>
                </li>
              );
            })}
          </ul>
        )}
        <form className="inline" onSubmit={create}>
          <input
            placeholder="New organization name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button className="primary" disabled={busy || !name || !home}>
            Create
          </button>
        </form>
        {error && <div className="error">{error}</div>}
      </div>
    </>
  );
}

/** Level 1 — one organization: its workspaces, and what it owns for all of them. */
function OrganizationLevel({
  token,
  org,
  workspaces,
  filters,
  onChanged,
  onOpenStudio,
  onOpenWorkspace,
  onDeleted,
}: {
  token: string;
  org: Tenant;
  workspaces: Workspace[];
  filters: Filters;
  onChanged: () => void;
  onOpenStudio: (ws: Workspace) => void;
  onOpenWorkspace: (ws: Workspace) => void;
  onDeleted: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    if (workspaces.length > 0) {
      window.alert(
        `“${org.name}” still has ${workspaces.length} workspace(s). Delete them first — an ` +
          `organization is not a folder you can drop with its contents inside.`,
      );
      return;
    }
    if (!window.confirm(`Delete organization “${org.name}”? This cannot be undone.`)) return;
    try {
      await api.deleteTenant(token, org.id);
      onDeleted();
    } catch (err) {
      setError(errText(err));
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{org.name}</h1>
          <p className="subtitle" style={{ margin: 0 }}>
            organization · <code>{org.id.slice(0, 8)}…</code>
          </p>
        </div>
      </div>
      {error && <div className="error">{error}</div>}

      <WorkspacesView
        token={token}
        orgs={[org]}
        workspaces={workspaces}
        filters={filters}
        heading={false}
        onChanged={onChanged}
        onOpenStudio={onOpenStudio}
        onOpen={onOpenWorkspace}
      />

      <div className="card">
        <h2>Danger zone</h2>
        <p className="hint">
          Deleting an organization is only possible once it is empty — the backend enforces it too,
          this button just says so before you find out from a 409.
        </p>
        <button className="ghost" onClick={() => void remove()}>
          Delete organization
        </button>
      </div>
    </>
  );
}

/** Level 2 — one workspace. Its own header, then everything it owns. */
function WorkspaceLevel({
  token,
  ws,
  onOpenStudio,
  onBack,
}: {
  token: string;
  ws: Workspace;
  onOpenStudio: (ws: Workspace) => void;
  onBack: () => void;
}) {
  return (
    <>
      <div className="topbar">
        <div>
          <h1>{ws.name}</h1>
          <p className="subtitle" style={{ margin: 0 }}>
            workspace of {ws.orgName} · <code>{ws.id.slice(0, 8)}…</code>
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="primary" onClick={() => onOpenStudio(ws)}>
            Open Studio
          </button>
        </div>
      </div>
      {/* embedded: the header above already carries the name and Open Studio. */}
      <WorkspaceDashboard token={token} ws={ws} embedded onBack={onBack} onOpenStudio={onOpenStudio} />
    </>
  );
}

function WorkspacesView({
  token,
  orgs,
  workspaces,
  filters,
  onChanged,
  onOpenStudio,
  onOpen,
  heading = true,
}: {
  token: string;
  orgs: Tenant[];
  workspaces: Workspace[];
  filters: Filters;
  onChanged: () => void;
  onOpenStudio: (ws: Workspace) => void;
  /** Drill into a workspace. */
  onOpen: (ws: Workspace) => void;
  /** Off when rendered as a level inside an organization, which has its own. */
  heading?: boolean;
}) {
  const [name, setName] = useState("");
  const [orgId, setOrgId] = useState(orgs.length === 1 ? orgs[0].id : "");
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
      {heading && (
        <>
          <h1>Workspaces</h1>
          <p className="subtitle">
            Open a workspace to see and edit everything it owns — sources, automation, projects,
            members — or go straight into its Studio.
          </p>
        </>
      )}
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
                  onClick={() => onOpen(w)}
                  title="Open this workspace"
                >
                  <div className="name">{w.name}</div>
                  <div className="sub">{w.orgName}</div>
                </div>
                <span className="badge workspace">workspace</span>
                {w.self_managed && <span className="badge selfmanaged">self-managed</span>}
                <button onClick={() => onOpen(w)}>Open</button>
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


// Repository credentials are workspace-scoped (tenant sharing), so the
// api_key secret type is the right one — personal_token is private-only by
// definition and credstore rejects tenant sharing for it.
const PAT_SECRET_TYPE = "gts.cf.core.credstore.secret.v1~cf.core.credstore.api_key.v1~";

/** Pick repositories from a connection and hand them back as source entries.
 *
 *  Deliberately does not persist: the dashboard keeps unsaved edits in its own
 *  state behind one "Save sources" button, and a component writing metadata
 *  behind its back would make that button lie. (The Connectors page has its own
 *  browser that DOES persist, because there is no pending form there.) */
function SourceFromConnector({
  token,
  ws,
  mode,
  onPick,
}: {
  token: string;
  ws: Workspace;
  /** "root" picks exactly one repository; "sources" picks any number. */
  mode: "root" | "sources";
  onPick: (entries: RepoEntry[]) => void;
}) {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [chosen, setChosen] = useState<string>("");
  const [repos, setRepos] = useState<RemoteRepo[] | null>(null);
  const [search, setSearch] = useState("");
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const [c, p] = await Promise.all([
          api.connections(token, ws.id),
          api.connectorProviders(token),
        ]);
        // Only source hosts can be browsed; a model-provider connection has no
        // repositories, so offering it here would be a dead end.
        const sources = c.items.filter(
          (x) =>
            p.items.find((pp) => pp.provider === x.provider)?.category === "source_code",
        );
        setConnections(sources);
        setChosen((prev) => prev || sources[0]?.id || "");
      } catch (e) {
        setError(errText(e));
        setConnections([]);
      }
    })();
  }, [open, token, ws.id]);

  const load = useCallback(
    async (id: string, q: string) => {
      if (!id) return;
      setError(null);
      try {
        const r = await api.connectionRepositories(token, id, ws.id, q);
        setRepos(r.items);
      } catch (e) {
        setError(errText(e));
        setRepos([]);
      }
    },
    [token, ws.id],
  );

  useEffect(() => {
    if (open && chosen) void load(chosen, "");
  }, [open, chosen, load]);

  const connection = connections?.find((c) => c.id === chosen);

  const toEntries = (): RepoEntry[] => {
    if (!connection) return [];
    const picked = (repos ?? []).filter((r) => checked[r.id]);
    return picked.map((r) => ({
      // Directory name must be [a-z0-9_-]+; the caller de-duplicates against
      // what the workspace already has.
      name:
        r.name
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, "-")
          .replace(/^-+|-+$/g, "") || `repo-${r.id}`,
      source: connection.provider === "github" ? "github" : "gitlab",
      url: r.clone_url,
      branch: r.default_branch,
      // The reference, never the token: studio-session reads credstore itself.
      token_ref: connection.secret_ref,
    }));
  };

  if (!open) {
    return (
      <div className="row">
        <button type="button" onClick={() => setOpen(true)}>
          {mode === "root" ? "Pick root from connector" : "+ Add from connector"}
        </button>
      </div>
    );
  }

  const picks = (repos ?? []).filter((r) => checked[r.id]);

  return (
    <div className="nested">
      {error && <p className="error">{error}</p>}
      {connections === null ? (
        <p className="empty">Loading connections…</p>
      ) : connections.length === 0 ? (
        <p className="empty">
          No source connector for this workspace yet — add one on the Connectors page, then come
          back.
        </p>
      ) : (
        <>
          <div className="row">
            <select
              value={chosen}
              onChange={(e) => {
                setChosen(e.target.value);
                setChecked({});
              }}
            >
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} · {c.provider}
                  {c.owner_tenant_id !== ws.id ? ` (from ${ws.orgName})` : ""}
                </option>
              ))}
            </select>
            <input
              className="grow"
              placeholder="Search repositories…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void load(chosen, search);
                }
              }}
            />
            <button type="button" onClick={() => void load(chosen, search)}>
              Search
            </button>
          </div>

          {repos === null ? (
            <p className="empty">Loading repositories…</p>
          ) : repos.length === 0 ? (
            <p className="empty">Nothing reachable with this credential.</p>
          ) : (
            <ul className="rows">
              {repos.map((r) => (
                <li key={r.id}>
                  <input
                    type={mode === "root" ? "radio" : "checkbox"}
                    name={mode === "root" ? `root-${ws.id}` : undefined}
                    checked={Boolean(checked[r.id])}
                    onChange={(e) =>
                      setChecked(
                        mode === "root"
                          ? { [r.id]: e.target.checked }
                          : (c) => ({ ...c, [r.id]: e.target.checked }),
                      )
                    }
                  />
                  <div className="grow">
                    <div className="name">{r.full_path}</div>
                    <div className="sub">
                      {r.default_branch ?? "default branch"}
                      {r.description ? ` · ${r.description}` : ""}
                    </div>
                  </div>
                  {r.visibility && <span className="badge">{r.visibility}</span>}
                </li>
              ))}
            </ul>
          )}

          <div className="row">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setChecked({});
              }}
            >
              Cancel
            </button>
            <span className="grow" />
            <button
              type="button"
              className="primary"
              disabled={picks.length === 0}
              onClick={() => {
                onPick(toEntries());
                setOpen(false);
                setChecked({});
              }}
            >
              {mode === "root" ? "Use as root" : `Add ${picks.length || ""}`}
            </button>
          </div>
          <p className="hint">
            Nothing is written yet — the picks land in the form above and go out with “Save
            sources”.
          </p>
        </>
      )}
    </div>
  );
}

/** A folder that already exists on the backend host, bind-mounted into the
 *  session. No connector can supply this — it is not a remote at all — so it
 *  stays a plain field. */
function LocalFolderSource({ onAdd }: { onAdd: (entry: RepoEntry) => void }) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const clean = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return (
    <div className="row">
      <input
        style={{ width: 160 }}
        placeholder="name (dir)"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className="grow"
        placeholder="local folder on the backend host: /mnt/c/Repos/my-repo"
        value={path}
        onChange={(e) => setPath(e.target.value)}
      />
      <button
        type="button"
        disabled={!clean || !path.trim()}
        onClick={() => {
          onAdd({ name: clean, source: "local", path: path.trim() });
          setName("");
          setPath("");
        }}
      >
        + Add local folder
      </button>
    </div>
  );
}

function WorkspaceDashboard({
  token,
  ws,
  onBack,
  onOpenStudio,
  embedded = false,
}: {
  token: string;
  ws: Workspace;
  onBack: () => void;
  onOpenStudio: (ws: Workspace) => void;
  /** Rendered inside the workspace row rather than as its own page: the row
   *  already shows the name and carries "Open Studio", so the topbar would be
   *  a second copy of both. */
  embedded?: boolean;
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

  const repoConnected =
    (settings?.repos?.length ?? 0) > 0 || Boolean(settings?.root_repo_url?.trim());
  // A git-backed source (GitLab/GitHub URL + PAT via credstore) IS a working
  // repository connector — the studio-session gear clones it into the
  // workspace. Only the non-git connectors are still ahead.
  const gitConnector = (settings?.repos ?? []).some((r) => r.source !== "local" && r.url?.trim());
  const steps: { label: string; done: boolean; soon?: boolean }[] = [
    { label: "Workspace created", done: true },
    { label: "Members invited", done: (users?.length ?? 0) > 0 },
    { label: "First project created", done: (projects?.length ?? 0) > 0 },
    { label: "Automation configured", done: settingsExist },
    { label: "Repository connected", done: repoConnected },
    { label: "Connector: Git (GitLab / GitHub)", done: gitConnector },
    { label: "Connectors (Jira / Slack)", done: false, soon: true },
    { label: "Kit installed", done: false, soon: true },
  ];

  return (
    <>
      {!embedded && (
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
      )}
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

      <WorkspaceProjectsCard token={token} ws={ws} onChanged={() => void load()} />

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
          How repositories enter this workspace (the domain model's ingress): each source becomes{" "}
          <code>./&lt;name&gt;</code> in the IDE and a <code>[sources.&lt;name&gt;]</code> entry in{" "}
          <code>.cf-workspace.toml</code>. Repositories come from a connector, so no clone URL or
          token is typed here — the source keeps only a credstore reference, and{" "}
          <code>studio-session</code> resolves it server-side.
        </p>
        {settings && (
          <form onSubmit={saveRepo}>
            <h3 className="group">Workspace root</h3>
            <p className="hint">
              A Studio workspace is itself a repository (manifest, docs, <code>.workspace-sources/</code>).
              Pick it from a connector, or point at a folder that already exists on the backend host.
            </p>
            {settings.root_repo_url?.trim() ? (
              <ul className="rows">
                <li>
                  <div className="grow">
                    <div className="name">{settings.root_repo_url}</div>
                    <div className="sub">
                      {settings.root_branch || "default branch"}
                      {settings.root_token_ref ? " · token via credstore" : " · public"}
                    </div>
                  </div>
                  <span className="badge">root</span>
                  <button
                    type="button"
                    onClick={() =>
                      setSettings({
                        ...settings,
                        root_repo_url: undefined,
                        root_branch: undefined,
                        root_token_ref: undefined,
                      })
                    }
                  >
                    remove
                  </button>
                </li>
              </ul>
            ) : (
              <SourceFromConnector
                token={token}
                ws={ws}
                mode="root"
                onPick={(entries) => {
                  const r = entries[0];
                  if (!r) return;
                  setSettings({
                    ...settings,
                    root_repo_url: r.url,
                    root_branch: r.branch,
                    root_token_ref: r.token_ref,
                    root_path: undefined,
                  });
                }}
              />
            )}
            <input
              placeholder="…or a local folder on the backend host: /mnt/c/Repos/hypothesis-workspace"
              value={settings.root_path ?? ""}
              onChange={(e) => setSettings({ ...settings, root_path: e.target.value })}
            />

            <h3 className="group">Sources</h3>
            {(settings.repos ?? []).length === 0 ? (
              <p className="empty">No sources yet.</p>
            ) : (
              <ul className="rows">
                {(settings.repos ?? []).map((r, i) => (
                  <li key={`${r.name}-${i}`}>
                    <div className="grow">
                      <div className="name">{r.name}</div>
                      <div className="sub">
                        {r.source === "local" ? r.path : r.url}
                        {r.token_ref ? " · token via credstore" : ""}
                      </div>
                    </div>
                    <span className="badge">{r.source}</span>
                    {r.source !== "local" && (
                      <input
                        style={{ width: 110 }}
                        placeholder="branch"
                        value={r.branch ?? ""}
                        onChange={(e) => patchRepo(i, { branch: e.target.value || undefined })}
                      />
                    )}
                    <input
                      style={{ width: 150 }}
                      placeholder={`target (default: ${r.name})`}
                      value={r.target ?? ""}
                      onChange={(e) => patchRepo(i, { target: e.target.value || undefined })}
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setSettings({
                          ...settings,
                          repos: (settings.repos ?? []).filter((_, j) => j !== i),
                        })
                      }
                    >
                      remove
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <SourceFromConnector
              token={token}
              ws={ws}
              mode="sources"
              onPick={(entries) => {
                const existing = settings.repos ?? [];
                const taken = new Set(existing.map((r) => r.name));
                const fresh = entries.filter((e) => {
                  if (taken.has(e.name)) return false;
                  taken.add(e.name);
                  return true;
                });
                setSettings({ ...settings, repos: [...existing, ...fresh] });
              }}
            />

            <LocalFolderSource
              onAdd={(entry) =>
                setSettings({ ...settings, repos: [...(settings.repos ?? []), entry] })
              }
            />

            <div className="row">
              <button className="primary">Save sources</button>
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

  const storageItems: unknown[] | null = Array.isArray(storages)
    ? storages
    : storages && typeof storages === "object" && "items" in storages &&
        Array.isArray((storages as { items: unknown[] }).items)
      ? (storages as { items: unknown[] }).items
      : null;

  return (
    <>
      <h1>Files</h1>
      <p className="subtitle">
        The file-storage gear is the platform's blob store: in the domain model it backs
        Documents, Text Content and chat Attachments. Today it serves mini-chat attachments;
        uploads go through signed URLs from a separate sidecar this dev assembly doesn't run —
        so the view is read-only and usually empty.
      </p>
      {error && <div className="error">{error}</div>}
      <div className="card">
        <h2>Files</h2>
        {!files || files.length === 0 ? (
          <p className="empty">
            Nothing stored yet — files appear here once chats get attachments (or the upload
            sidecar is deployed).
          </p>
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
      {storageItems && storageItems.length > 0 && (
        <div className="card">
          <h2>Storage backends ({storageItems.length})</h2>
          <pre style={{ overflow: "auto", fontSize: 12 }}>{JSON.stringify(storageItems, null, 2)}</pre>
        </div>
      )}
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

  // Permission catalog: every `gts.cf.toolkit.authz.permission.v1~…`
  // instance registered in the types-registry. Extracted by id pattern so
  // the card survives shape changes in the entities payload.
  const permissions = Array.from(
    new Set(
      (JSON.stringify(entities ?? "").match(
        /gts\.cf\.toolkit\.authz\.permission\.v1~[a-zA-Z0-9_.]+\.v\d+/g,
      ) ?? []),
    ),
  ).sort();

  return (
    <>
      <h1>System</h1>
      <p className="subtitle">Live observability over the platform gears of this assembly.</p>

      <div className="card">
        <h2>Privileges ({permissions.length} permissions registered)</h2>
        <p className="error" style={{ marginBottom: 10 }}>
          Enforcement: static allow-all — the PDP is not wired yet (ADR-0004 P3). Access is
          governed by tenant scope + self-managed barriers only; the permissions below are the
          registered vocabulary the future PDP and Role Grants will enforce.
        </p>
        {permissions.length === 0 ? (
          <p className="empty">No permission instances found in the types-registry.</p>
        ) : (
          <ul className="perm-list">
            {permissions.map((p) => (
              <li key={p}>
                <code>{p.replace("gts.cf.toolkit.authz.permission.v1~", "")}</code>
              </li>
            ))}
          </ul>
        )}
      </div>

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

/* ── Projects (workspace-scoped card; RG-backed, ADR-0002) ──
   In the domain model a Project is a managed object of type Project — a
   graph object inside a workspace's context, not a control-plane citizen.
   Hence no top-level Projects view: they live on the Workspace Dashboard. */

function WorkspaceProjectsCard({
  token,
  ws,
  onChanged,
}: {
  token: string;
  ws: Workspace;
  onChanged?: () => void;
}) {
  const wsId = ws.id;
  const [projects, setProjects] = useState<Group[] | null>(null);
  const [name, setName] = useState("");
  const [openProject, setOpenProject] = useState<Group | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
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
      onChanged?.();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 400
          ? `${errText(err)} — если тип проекта ещё не зарегистрирован, выполните studio-backend/demo/setup-projects.sh`
          : errText(err),
      );
    }
  }

  const visible = projects ?? [];

  async function removeProject(p: Group) {
    if (!window.confirm(`Delete project “${p.name}” (memberships included)?`)) return;
    setError(null);
    try {
      await api.deleteGroup(token, p.id, true); // force: cascade memberships
      await load();
      onChanged?.();
    } catch (err) {
      setError(errText(err));
    }
  }

  return (
    <>
      <div className="card">
        <h2>Projects</h2>
        <p className="hint">
          This workspace's effort containers. In the domain model a Project is a managed object
          of type Project in the Knowledge Graph; until the graph ships they are Resource
          Group-backed (ADR-0002).
        </p>

        {projects && (
          <>
            {projects.length === 0 ? (
              <p className="empty" style={{ marginTop: 12 }}>
                No projects in “{ws.name}” yet.
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

      {openProject && (
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

/* ── Home hub ── */

function HomeView({
  token,
  home,
  orgs,
  workspaces,
  spaces,
  onOpenSpace,
  onOpenStudio,
  onOpenDashboard,
  onNavigate,
}: {
  token: string;
  home: Tenant | null;
  orgs: Tenant[];
  workspaces: Workspace[];
  spaces: { wsId: string; wsName: string }[];
  onOpenSpace: (wsId: string) => void;
  onOpenStudio: (ws: Workspace) => void;
  onOpenDashboard: (ws: Workspace) => void;
  onNavigate: (v: View) => void;
}) {
  const [live, setLive] = useState<import("./api").StudioSession[]>([]);
  const [gearCount, setGearCount] = useState<string>("…");

  useEffect(() => {
    void api.studioSessions(token).then(
      (p) => setLive(p.items.filter((s) => s.state !== "stopped")),
      () => setLive([]),
    );
    void api.gears(token).then(
      (g: unknown) => {
        const items =
          Array.isArray(g) ? g
          : g && typeof g === "object" && "items" in g && Array.isArray((g as { items: unknown[] }).items)
            ? (g as { items: unknown[] }).items
            : null;
        setGearCount(items ? String(items.length) : "—");
      },
      () => setGearCount("—"),
    );
  }, [token]);

  const hidden = orgs.filter((o) => o.self_managed).length;
  const continueItems = workspaces
    .map((ws) => ({
      ws,
      space: spaces.find((s) => s.wsId === ws.id),
      session: live.find((s) => s.workspace_id === ws.id),
    }))
    .filter((x) => x.space || x.session);

  return (
    <>
      <div className="home-hero">
        <div>
          <h1>
            <span className="hero-gradient">Constructor Studio</span>
          </h1>
          <p className="subtitle">
            Your workspace for building with AI over real repositories — the control plane of the
            Studio domain model.
          </p>
        </div>
        <div className="hero-links">
          {/* Discord invite comes from env (runtime env.js in clusters,
              VITE_ var in dev) so each deployment points at its own server;
              without it the link hides itself. */}
          {runtimeEnv.discordUrl && (
            <a href={runtimeEnv.discordUrl} target="_blank" rel="noopener noreferrer">
              🎮 Discord
            </a>
          )}
          <a href="https://github.com/constructorfabric/studio-web" target="_blank" rel="noopener noreferrer">
            🐙 GitHub
          </a>
          <a href="/cf/docs" target="_blank" rel="noopener noreferrer">
            ⧉ Docs &amp; API
          </a>
        </div>
      </div>

      <div className="home-grid">
        <div className="card span-all">
          <h2>Continue</h2>
          {continueItems.length === 0 ? (
            <p className="empty">No live sessions. Open a workspace to start one.</p>
          ) : (
            <ul className="rows">
              {continueItems.map(({ ws, space, session }) => (
                <li key={ws.id}>
                  <div className="grow">
                    <div className="name">⚙ {ws.name}</div>
                    <div className="sub">{ws.orgName}{session ? ` · session ${session.state}` : ""}</div>
                  </div>
                  {space ? (
                    <button className="primary" onClick={() => onOpenSpace(ws.id)}>
                      Switch to space
                    </button>
                  ) : (
                    <button className="primary" onClick={() => onOpenStudio(ws)}>
                      Reopen
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card">
          <h2>Build</h2>
          <ul className="home-links">
            <li>
              <button className="linklike" onClick={() => onNavigate("workspaces")}>
                Workspaces — open the Studio IDE →
              </button>
            </li>
            {workspaces[0] && (
              <li>
                <button className="linklike" onClick={() => onOpenDashboard(workspaces[0])}>
                  Workspace dashboard (sources, automation, projects) →
                </button>
              </li>
            )}
            <li>
              <button className="linklike" onClick={() => onNavigate("connectors")}>
                Connect a repository →
              </button>
            </li>
            <li>
              <button className="linklike" onClick={() => onNavigate("chats")}>
                Ask AI (workspace chats) →
              </button>
            </li>
          </ul>
        </div>

        <div className="card">
          <h2>Platform</h2>
          <ul className="rows">
            <li>
              <div className="grow"><div className="sub">Scope</div>
                <div className="name">
                  {home?.tenant_type === TENANT_TYPES.organization
                    ? `${home.name} subtree`
                    : `entire platform${hidden ? ` · ${hidden} self-managed hidden` : ""}`}
                </div>
              </div>
            </li>
            <li>
              <div className="grow"><div className="sub">Organizations / Workspaces</div>
                <div className="name">{orgs.length} / {workspaces.length}</div>
              </div>
            </li>
            <li>
              <div className="grow"><div className="sub">Gears running</div>
                <div className="name">{gearCount}</div>
              </div>
              <button className="ghost" onClick={() => onNavigate("system")}>System →</button>
            </li>
          </ul>
        </div>

        <div className="card">
          <h2>Documentation</h2>
          <ul className="home-links">
            <li><a href="https://github.com/constructorfabric/studio-web#readme" target="_blank" rel="noopener noreferrer">README — running the stack →</a></li>
            <li><a href="https://github.com/constructorfabric/studio-web/tree/main/docs/adr" target="_blank" rel="noopener noreferrer">Architecture decisions (ADR) →</a></li>
            <li><a href="https://github.com/constructorfabric/studio-web/blob/main/docs/domain-alignment.md" target="_blank" rel="noopener noreferrer">Domain model alignment →</a></li>
          </ul>
        </div>
      </div>
    </>
  );
}

/* ── Secrets (credstore surface) ──
   credstore has NO list endpoint (gears feedback #5), so the view builds
   from refs the workspace settings know about, probes each with GET, and
   heals broken ones with the unconditional-PUT rotate. */

interface SecretRow {
  ref: string;
  usedBy: string[];
}

function useKnownSecretRefs(token: string, workspaces: Workspace[]): SecretRow[] | null {
  const [rows, setRows] = useState<SecretRow[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const map = new Map<string, Set<string>>();
      await Promise.all(
        workspaces.map(async (ws) => {
          const s = await api.workspaceSettings(token, ws.id).catch(() => null);
          if (!s) return;
          const add = (ref?: string | null, what = "") => {
            const r = ref?.trim();
            if (!r) return;
            if (!map.has(r)) map.set(r, new Set());
            map.get(r)?.add(`${ws.name}${what}`);
          };
          add(s.root_token_ref, " (workspace root)");
          for (const repo of s.repos ?? []) add(repo.token_ref, ` / ${repo.name}`);
        }),
      );
      if (!cancelled) {
        setRows(
          [...map.entries()]
            .map(([ref, used]) => ({ ref, usedBy: [...used].sort() }))
            .sort((a, b) => a.ref.localeCompare(b.ref)),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, workspaces]);
  return rows;
}

function SecretsView({
  token,
  workspaces,
  filters,
}: {
  token: string;
  workspaces: Workspace[];
  filters: Filters;
}) {
  const rows = useKnownSecretRefs(token, workspaces);
  const [status, setStatus] = useState<Record<string, "ok" | "broken" | "checking">>({});
  const [error, setError] = useState<string | null>(null);

  async function check(ref: string) {
    setStatus((s) => ({ ...s, [ref]: "checking" }));
    const r = await api.checkSecret(token, ref);
    setStatus((s) => ({ ...s, [ref]: r }));
  }

  async function rotate(ref: string) {
    const value = window.prompt(`New value for “${ref}” (e.g. a fresh PAT):`);
    if (!value?.trim()) return;
    setError(null);
    try {
      await api.putSecret(token, ref, value.trim(), PAT_SECRET_TYPE);
      await check(ref);
    } catch (e) {
      setError(errText(e));
    }
  }

  async function remove(ref: string) {
    if (!window.confirm(`Delete secret “${ref}”? Workspace settings keep the reference — launches will clone without credentials until a new value is saved.`)) return;
    setError(null);
    try {
      await api.deleteSecret(token, ref);
      setStatus((s) => ({ ...s, [ref]: "broken" }));
    } catch (e) {
      setError(errText(e));
    }
  }

  const visible = (rows ?? []).filter((r) => matches(filters.query, r.ref, r.usedBy.join(" ")));

  return (
    <>
      <h1>Secrets</h1>
      <p className="subtitle">
        Repository credentials in the credstore gear. Values are write-only; this view lists the
        references known to workspace settings, probes their health, and rotates broken ones
        (the store has no list API — anything saved outside the portal won't appear here).
      </p>
      <div className="card">
        {rows === null ? (
          <p className="empty">Loading references from workspace settings…</p>
        ) : visible.length === 0 ? (
          <p className="empty">No secret references found in any workspace settings.</p>
        ) : (
          <ul className="rows">
            {visible.map((r) => (
              <li key={r.ref}>
                <div className="grow">
                  <div className="name"><code>{r.ref}</code></div>
                  <div className="sub">used by: {r.usedBy.join(", ")}</div>
                </div>
                {status[r.ref] === "ok" && <span className="badge workspace">readable ✓</span>}
                {status[r.ref] === "broken" && (
                  <span className="badge selfmanaged" title="Exists but unreadable (or missing) — rotate to heal">
                    broken ✗
                  </span>
                )}
                <button className="ghost" disabled={status[r.ref] === "checking"} onClick={() => void check(r.ref)}>
                  {status[r.ref] === "checking" ? "…" : "Check"}
                </button>
                <button className="ghost" onClick={() => void rotate(r.ref)}>Rotate</button>
                <button className="ghost" title="Delete the stored value" onClick={() => void remove(r.ref)}>✕</button>
              </li>
            ))}
          </ul>
        )}
        {error && <div className="error">{error}</div>}
      </div>
    </>
  );
}

/* ── Connectors (aggregate of workspace sources) ── */

/** Provider groups in the picker. Keys match ConnectorDriver::category(). */
const CATEGORIES: { key: string; title: string; blurb: string }[] = [
  {
    key: "source_code",
    title: "Source code",
    blurb: "Browse repositories and attach them to this workspace.",
  },
  {
    key: "ai",
    title: "AI providers",
    blurb:
      "Credentials the IDE agents authenticate with — Anthropic for Claude Code, OpenAI for Codex.",
  },
];

/** Where a connection is attached, and how widely its token is readable.
 *  One choice sets both: the tenant holding the catalogue row (its reach) and
 *  the credstore sharing mode of the token (who may read it). */
type Reach = "organization" | "workspace" | "personal";

function ConnectorsView({
  token,
  workspaces,
  filters,
}: {
  token: string;
  workspaces: Workspace[];
  filters: Filters;
}) {
  // Connectors are workspace-scoped: everything on this page is "for this
  // workspace", including connections inherited from its organization.
  const [wsId, setWsId] = useState(workspaces[0]?.id ?? "");
  const ws = workspaces.find((w) => w.id === wsId) ?? workspaces[0];

  const [providers, setProviders] = useState<ConnectorProvider[] | null>(null);
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [disabled, setDisabled] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!ws) return;
    setErr(null);
    try {
      const [p, c] = await Promise.all([
        api.connectorProviders(token),
        api.connections(token, ws.id),
      ]);
      setProviders(p.items);
      setConnections(c.items);
      setDisabled(null);
    } catch (e) {
      // 503 = no driver plugin registered in this build. Say so plainly instead
      // of showing an empty list that reads as "nothing connected".
      if (e instanceof ApiError && e.status === 503) {
        setDisabled(errText(e));
        setProviders([]);
        setConnections([]);
      } else {
        setErr(errText(e));
      }
    }
  }, [token, ws]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!ws) {
    return (
      <>
        <h1>Connectors</h1>
        <p className="empty">Create a workspace first — connectors are attached to one.</p>
      </>
    );
  }

  return (
    <>
      <h1>Connectors</h1>
      <p className="subtitle">
        How repositories and model credentials enter a workspace. Configure a connection once, then
        pick repositories from a list instead of pasting clone URLs. Tokens go to credstore — after
        you submit one the browser never sees it again.
      </p>

      <div className="card">
        <h2>Workspace</h2>
        <p className="hint">
          Connections below are the ones this workspace can use: its own, plus those its
          organization shares with all of its workspaces.
        </p>
        <select value={wsId} onChange={(e) => setWsId(e.target.value)}>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name} · {w.orgName}
            </option>
          ))}
        </select>
      </div>

      {err && <p className="error">{err}</p>}
      {note && <p className="hint">{note}</p>}
      {disabled && (
        <div className="card">
          <h2>Connectors unavailable</h2>
          <p className="empty">{disabled}</p>
        </div>
      )}

      {!disabled && (
        <AddConnector
          token={token}
          workspace={ws}
          providers={providers ?? []}
          onAdded={(t) => {
            setNote(`Connected as ${t.account}${t.display_name ? ` (${t.display_name})` : ""}.`);
            void reload();
          }}
        />
      )}

      {!disabled && (
        <ConnectionList
          token={token}
          workspace={ws}
          providers={providers ?? []}
          connections={(connections ?? []).filter((c) =>
            matches(filters.query, c.label, c.provider, c.base_url),
          )}
          loading={connections === null}
          onChanged={() => void reload()}
          onNote={setNote}
        />
      )}
    </>
  );
}

/** Provider picker, then the credential form. "Test connection" probes without
 *  saving; "Test & save" does both in one server-side step. */
function AddConnector({
  token,
  workspace,
  providers,
  onAdded,
}: {
  token: string;
  workspace: Workspace;
  providers: ConnectorProvider[];
  onAdded: (t: { account: string; display_name?: string }) => void;
}) {
  const [picked, setPicked] = useState<ConnectorProvider | null>(null);
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [pat, setPat] = useState("");
  const [reveal, setReveal] = useState(false);
  // Organization by default: one PAT for gitlab.constr.dev is an organization
  // asset, and re-entering it per workspace is how credentials get stale.
  const [reach, setReach] = useState<Reach>("organization");
  const [busy, setBusy] = useState<"probe" | "save" | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setPicked(null);
    setLabel("");
    setBaseUrl("");
    setPat("");
    setReveal(false);
    setReach("organization");
    setResult(null);
    setError(null);
  };

  if (providers.length === 0) {
    return (
      <div className="card">
        <h2>Add connector</h2>
        <p className="empty">No connector driver plugin is registered in this build.</p>
      </div>
    );
  }

  if (!picked) {
    return (
      <div className="card">
        <h2>Add connector</h2>
        <p className="hint">Connect this workspace to an external tool or service.</p>
        {CATEGORIES.map(({ key, title, blurb }) => {
          const group = providers.filter((p) => p.category === key);
          if (group.length === 0) return null;
          return (
            <div key={key}>
              <h3 className="group">{title}</h3>
              <p className="hint">{blurb}</p>
              <ul className="rows">
                {group.map((p) => (
                  <li key={p.provider}>
                    <div className="grow">
                      <div className="name">{p.display_name}</div>
                      <div className="sub">
                        {title.toLowerCase()} · {p.default_base_url}
                      </div>
                    </div>
                    {/* Proof this is plugin-backed: the driver's GTS instance id. */}
                    <span className="sub" title={p.instance_id}>
                      {p.instance_id.split("~").filter(Boolean).slice(-1)[0]}
                    </span>
                    <button onClick={() => setPicked(p)}>Connect</button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    );
  }

  const submit = async (mode: "probe" | "save") => {
    setBusy(mode);
    setError(null);
    setResult(null);
    try {
      const body = {
        provider: picked.provider,
        base_url: baseUrl.trim() || undefined,
        token: pat,
      };
      if (mode === "probe") {
        const id = await api.probeConnection(token, body);
        setResult(`Valid — ${id.account}${id.display_name ? ` (${id.display_name})` : ""}`);
      } else {
        const t = await api.createConnection(token, {
          ...body,
          label,
          scope: reach,
          // Reach and visibility come from one choice: the organization row is
          // inherited by every workspace under it, a workspace row by that one
          // workspace, and "personal" additionally keeps the token to its owner.
          owner_tenant_id: reach === "organization" ? workspace.orgId : workspace.id,
        });
        onAdded(t);
        reset();
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card">
      <h2>Add connector</h2>
      <ul className="rows">
        <li>
          <div className="grow">
            <div className="name">{picked.display_name}</div>
            <div className="sub">source code</div>
          </div>
        </li>
      </ul>

      <label>Available to</label>
      <select value={reach} onChange={(e) => setReach(e.target.value as Reach)}>
        <option value="organization">{workspace.orgName} — all workspaces of this organization</option>
        <option value="workspace">{workspace.name} — this workspace only</option>
        <option value="personal">Only me — private to my account</option>
      </select>
      <p className="hint">
        {reach === "organization"
          ? "Stored on the organization and inherited by its workspaces; the token is readable across them."
          : reach === "workspace"
            ? "Stored on this workspace; everyone in it can use the token."
            : "Stored on this workspace, but the token stays readable only by you."}
      </p>

      <label>Label</label>
      <input
        placeholder={`e.g. My ${picked.display_name} account`}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />

      <label>Instance URL</label>
      <input
        placeholder={
          picked.category === "ai"
            ? `Leave empty for ${picked.default_base_url} — or any compatible endpoint`
            : `Leave empty for ${picked.default_base_url} — or your self-hosted installation`
        }
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
      />

      <label>{picked.credential_label}</label>
      <div className="row">
        <input
          className="grow"
          type={reveal ? "text" : "password"}
          placeholder={picked.credential_hint}
          value={pat}
          onChange={(e) => setPat(e.target.value)}
        />
        <button onClick={() => setReveal((v) => !v)}>{reveal ? "Hide" : "Show"}</button>
      </div>
      <p className="hint">
        Stored in credstore under a per-connection reference. Never logged, never returned by the
        API.
      </p>

      {result && <p className="hint">{result}</p>}
      {error && <p className="error">{error}</p>}

      <div className="row">
        <button onClick={reset}>← Back</button>
        <span className="grow" />
        <button disabled={!pat.trim() || busy !== null} onClick={() => void submit("probe")}>
          {busy === "probe" ? "Testing…" : "Test connection"}
        </button>
        <button
          className="primary"
          disabled={!pat.trim() || !label.trim() || busy !== null}
          onClick={() => void submit("save")}
        >
          {busy === "save" ? "Saving…" : "Test & save"}
        </button>
      </div>
    </div>
  );
}

/** Connections usable by one workspace: type chips, category sections, one card
 *  per connection. Health is checked on demand — the card says "not checked"
 *  until you press Test, rather than showing a green badge we never earned. */
function ConnectionList({
  token,
  workspace,
  providers,
  connections,
  loading,
  onChanged,
  onNote,
}: {
  token: string;
  workspace: Workspace;
  providers: ConnectorProvider[];
  connections: Connection[];
  loading: boolean;
  onChanged: () => void;
  onNote: (s: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [health, setHealth] = useState<Record<string, "ok" | "bad" | "testing">>({});

  const counts = connections.reduce<Record<string, number>>((acc, c) => {
    acc[c.provider] = (acc[c.provider] ?? 0) + 1;
    return acc;
  }, {});
  const shown = typeFilter ? connections.filter((c) => c.provider === typeFilter) : connections;
  const nameOf = (p: string) => providers.find((x) => x.provider === p)?.display_name ?? p;
  const categoryOf = (p: string) => providers.find((x) => x.provider === p)?.category;

  const test = (c: Connection) => {
    setHealth((h) => ({ ...h, [c.id]: "testing" }));
    void api
      .testConnection(token, c.id, workspace.id)
      .then((t) => {
        setHealth((h) => ({ ...h, [c.id]: "ok" }));
        onNote(`${c.label}: valid — ${t.account}`);
      })
      .catch((e) => {
        setHealth((h) => ({ ...h, [c.id]: "bad" }));
        onNote(`${c.label}: ${errText(e)}`);
      });
  };

  const remove = (c: Connection, inherited: boolean) => {
    const warn = inherited
      ? `"${c.label}" belongs to ${workspace.orgName} and is shared with its other workspaces. Remove it for everyone?`
      : `Remove connection "${c.label}" and its token?`;
    if (!window.confirm(warn)) return;
    void api
      .deleteConnection(token, c.id, workspace.id)
      .then(onChanged)
      .catch((e) => onNote(errText(e)));
  };

  if (loading) {
    return (
      <div className="card">
        <h2>Connections</h2>
        <p className="empty">Loading…</p>
      </div>
    );
  }
  if (connections.length === 0) {
    return (
      <div className="card">
        <h2>Connections</h2>
        <p className="empty">Nothing connected for this workspace yet.</p>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Connections</h2>

      {/* Type chips: several connections of the same provider are normal —
          two GitLab installations, a personal and an organization token. */}
      <div className="chips">
        {Object.entries(counts).map(([p, n]) => (
          <button
            key={p}
            type="button"
            className={`chip${typeFilter === p ? " on" : ""}`}
            onClick={() => setTypeFilter(typeFilter === p ? null : p)}
          >
            {nameOf(p)} <span className="chip-n">{n}</span>
          </button>
        ))}
        {typeFilter && (
          <button type="button" className="chip" onClick={() => setTypeFilter(null)}>
            Clear
          </button>
        )}
      </div>

      {CATEGORIES.map(({ key, title }) => {
        const group = shown.filter((c) => categoryOf(c.provider) === key);
        if (group.length === 0) return null;
        return (
          <div key={key}>
            <h3 className="group">{title}</h3>
            <div className="conn-grid">
              {group.map((c) => {
                const browsable = categoryOf(c.provider) === "source_code";
                // A row stored on an ancestor is shared with sibling workspaces —
                // worth saying, because removing it affects them too.
                const inherited = c.owner_tenant_id !== workspace.id;
                const h = health[c.id];
                return (
                  <div className="conn" key={c.id}>
                    <div className="conn-head">
                      <span className="conn-ico" aria-hidden="true">
                        {nameOf(c.provider).slice(0, 1)}
                      </span>
                      <div className="grow">
                        <div className="name">
                          {nameOf(c.provider)}
                          {c.account ? ` · ${c.account}` : ""}
                        </div>
                        <div className="sub">
                          {c.label} · {c.base_url}
                        </div>
                      </div>
                      <div className="conn-badges">
                        <span
                          className={`badge ${h === "ok" ? "workspace" : ""}`}
                          title={
                            h
                              ? undefined
                              : "Health is not cached — press Test connection to check it now"
                          }
                        >
                          {h === "ok"
                            ? "healthy"
                            : h === "bad"
                              ? "failing"
                              : h === "testing"
                                ? "testing…"
                                : "not checked"}
                        </span>
                        <span className={`badge ${c.scope === "personal" ? "" : "workspace"}`}>
                          {inherited ? `${c.scope} · from ${workspace.orgName}` : c.scope}
                        </span>
                      </div>
                    </div>
                    <div className="row">
                      <button type="button" onClick={() => test(c)}>
                        Test connection
                      </button>
                      {browsable && (
                        <button type="button" onClick={() => setOpen(open === c.id ? null : c.id)}>
                          {open === c.id ? "Hide repositories" : "Repositories"}
                        </button>
                      )}
                      <span className="grow" />
                      <button type="button" onClick={() => remove(c, inherited)}>
                        Remove
                      </button>
                    </div>
                    {open === c.id && browsable && (
                      <RepoBrowser
                        token={token}
                        connection={c}
                        workspace={workspace}
                        onNote={onNote}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RepoBrowser({
  token,
  connection,
  workspace,
  onNote,
}: {
  token: string;
  connection: Connection;
  workspace: Workspace;
  onNote: (s: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [repos, setRepos] = useState<RemoteRepo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (q: string) => {
      setError(null);
      try {
        const r = await api.connectionRepositories(token, connection.id, workspace.id, q);
        setRepos(r.items);
      } catch (e) {
        setError(errText(e));
        setRepos([]);
      }
    },
    [token, connection.id, workspace.id],
  );

  useEffect(() => {
    void load("");
  }, [load]);

  const picks = (repos ?? []).filter((r) => checked[r.id]);

  const attach = async () => {
    if (picks.length === 0) return;
    setBusy(true);
    try {
      const current = (await api.workspaceSettings(token, workspace.id)) ?? {};
      const existing = current.repos ?? [];
      const taken = new Set(existing.map((r) => r.name));
      const added: RepoEntry[] = [];
      for (const r of picks) {
        // Directory name must be [a-z0-9_-]+. De-duplicate against what the
        // workspace already has rather than shadowing an existing source.
        const base =
          r.name
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, "-")
            .replace(/^-+|-+$/g, "") || `repo-${r.id}`;
        let candidate = base;
        let n = 2;
        while (taken.has(candidate)) candidate = `${base}-${n++}`;
        taken.add(candidate);
        added.push({
          name: candidate,
          source: connection.provider === "github" ? "github" : "gitlab",
          url: r.clone_url,
          branch: r.default_branch,
          // studio-session resolves this from credstore itself, so the token
          // stays server-side end to end.
          token_ref: connection.secret_ref,
        });
      }
      await api.putWorkspaceSettings(token, workspace.id, {
        ...current,
        repos: [...existing, ...added],
      });
      onNote(
        `Attached ${added.length} repositor${added.length === 1 ? "y" : "ies"} to ${workspace.name} — ` +
          `cloned on the next session launch.`,
      );
      setChecked({});
    } catch (e) {
      onNote(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="nested">
      <div className="row">
        <input
          className="grow"
          placeholder="Search repositories…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void load(search);
          }}
        />
        <button onClick={() => void load(search)}>Search</button>
      </div>

      {error && <p className="error">{error}</p>}
      {repos === null ? (
        <p className="empty">Loading repositories…</p>
      ) : repos.length === 0 ? (
        <p className="empty">Nothing reachable with this credential.</p>
      ) : (
        <ul className="rows">
          {repos.map((r) => (
            <li key={r.id}>
              <input
                type="checkbox"
                checked={Boolean(checked[r.id])}
                onChange={(e) => setChecked((c) => ({ ...c, [r.id]: e.target.checked }))}
              />
              <div className="grow">
                <div className="name">{r.full_path}</div>
                <div className="sub">
                  {r.default_branch ?? "default branch"}
                  {r.description ? ` · ${r.description}` : ""}
                </div>
              </div>
              {r.visibility && <span className="badge">{r.visibility}</span>}
            </li>
          ))}
        </ul>
      )}

      <div className="row">
        <span className="grow" />
        <button className="primary" disabled={picks.length === 0 || busy} onClick={() => void attach()}>
          {busy ? "Attaching…" : `Add ${picks.length || ""} to ${workspace.name}`}
        </button>
      </div>
    </div>
  );
}

function OrganizationsView({
  token,
  homeId,
  home,
  orgs,
  workspaces,
  selectedOrgId,
  onChanged,
  onCreated,
  onNew,
}: {
  token: string;
  homeId: string;
  home: Tenant | null;
  orgs: Tenant[];
  workspaces: Workspace[];
  /** Org selected in the admin header; "__new__" opens the create hero. */
  selectedOrgId: string | null;
  onChanged: () => void;
  onCreated: (id: string) => void;
  /** Opens the create hero (sets the selector to "__new__" upstream). */
  onNew: () => void;
}) {
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
    // The barrier is easy to raise and deliberately hard to lower — make
    // sure nobody locks themselves out by accident again.
    if (
      !org.self_managed &&
      !window.confirm(
        `Make “${org.name}” self-managed?\n\n` +
          "This raises a VISIBILITY BARRIER: you (and every platform admin) lose " +
          "access to the organization and everything inside it — its workspaces " +
          "disappear from your lists. Only an admin whose home is inside the " +
          "organization can request the conversion back to managed; you would " +
          "then approve it here.",
      )
    )
      return;
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
      const created = await api.createTenant(token, {
        name,
        parent_id: homeId,
        tenant_type: TENANT_TYPES.organization,
      });
      setName("");
      onChanged();
      onCreated((created as Tenant)?.id ?? "");
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  // Full-page create hero: for the very first organization AND for the
  // "+ New organization" entry from the admin org selector.
  if (
    selectedOrgId === "__new__" ||
    (orgs.length === 0 && home && home.tenant_type !== TENANT_TYPES.organization)
  ) {
    return (
      <div className="hero-create">
        <h1>
          <span className="hero-gradient">Create your organization</span>
        </h1>
        <p className="subtitle" style={{ maxWidth: 460, textAlign: "center" }}>
          An organization is a tenant in the admin hierarchy — your workspaces, members and
          repositories will live inside it.
        </p>
        <div className="card hero-create-card">
          <label className="field">
            Organization name
            <input
              placeholder="My organization"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </label>
          <p className="hint">
            Created managed (platform admins keep access); it can request self-managed mode
            later via dual consent.
          </p>
          {error && <div className="error">{error}</div>}
        </div>
        <button
          className="primary hero-create-btn"
          disabled={busy || !name.trim()}
          onClick={(e) => void create(e as unknown as FormEvent)}
        >
          Create organization
        </button>
        {orgs.length > 0 && (
          <button className="ghost" onClick={() => onCreated("")}>
            ← Back to {orgs[0]?.name ?? "organizations"}
          </button>
        )}
      </div>
    );
  }

  // Resolve the org the admin header selected (an org-homed user's own org
  // wins when nothing is selected — that's all they can administer).
  const selected =
    orgs.find((o) => o.id === selectedOrgId) ??
    (home?.tenant_type === TENANT_TYPES.organization ? home : orgs[0]) ??
    null;
  const orgWorkspaces = selected ? workspaces.filter((w) => w.orgName === selected.name) : [];

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Organization</h1>
          <p className="subtitle" style={{ margin: 0 }}>
            One tenant per organization (the admin hierarchy governs management, never data);
            workspaces and members live inside it. Switch organizations in the sidebar header.
          </p>
        </div>
        <button className="primary" onClick={onNew}>
          ＋ New organization
        </button>
      </div>

      {selected && (
        <div className="card">
          <h2>{selected.name}</h2>
          <ul className="rows">
            <li>
              <div className="grow">
                <div className="sub">Organization ID</div>
                <div className="name"><code>{selected.id}</code></div>
              </div>
              <button
                className="ghost"
                title="Copy ID"
                onClick={() => void navigator.clipboard?.writeText(selected.id)}
              >
                ⧉
              </button>
            </li>
            <li>
              <div className="grow">
                <div className="sub">Type / mode</div>
                <div className="name">
                  <span className="badge">{shortTypeName(selected.tenant_type)}</span>{" "}
                  <span className={`badge ${selected.self_managed ? "selfmanaged" : "workspace"}`}>
                    {selected.self_managed ? "self-managed 🔒" : "managed"}
                  </span>
                </div>
              </div>
              {selected.self_managed && selected.id !== home?.id ? (
                <span
                  className="hint"
                  style={{ margin: 0 }}
                  title="Self-managed = visibility barrier. An admin homed inside this organization requests the conversion; you approve it here."
                >
                  → managed: requested from inside
                </span>
              ) : (
                <button
                  className="ghost"
                  title="Dual-consent mode conversion: creates a pending request the other side approves"
                  onClick={() => void requestMode(selected)}
                >
                  {selected.self_managed ? "→ managed" : "→ self-managed"}
                </button>
              )}
            </li>
            <li>
              <div className="grow">
                <div className="sub">Workspaces / visible members</div>
                <div className="name">{orgWorkspaces.length} workspace(s)</div>
              </div>
            </li>
          </ul>
        </div>
      )}

      {/* Access map: the tenant hierarchy IS the privilege system — your
          home tenant anchors your scope (its subtree), self-managed raises
          a visibility barrier. One picture instead of a 404 hunt. */}
      {home && (
        <div className="card">
          <h2>Access map</h2>
          <p className="hint">
            Your scope is your home tenant's subtree. 🔒 self-managed = a visibility barrier:
            that subtree is governed by its own admins and hidden from you.
          </p>
          <ul className="access-tree">
            <li>
              <span className="access-node">
                🏛 <b>{home.name}</b>
                <span className="badge you">you are here</span>
              </span>
              <ul>
                {home.tenant_type === TENANT_TYPES.organization
                  ? workspaces.map((w) => (
                      <li key={w.id}>
                        <span className="access-node">▦ {w.name}</span>
                      </li>
                    ))
                  : orgs.map((o) => (
                      <li key={o.id} className={o.self_managed ? "access-dim" : ""}>
                        <span className="access-node">
                          🏢 {o.name}
                          {o.self_managed && (
                            <span
                              className="badge selfmanaged"
                              title="Visibility barrier: governed by its own admins; only a dual-consent conversion (requested from inside) lifts it"
                            >
                              🔒 subtree hidden from you
                            </span>
                          )}
                        </span>
                        {!o.self_managed && (
                          <ul>
                            {workspaces
                              .filter((w) => w.orgName === o.name)
                              .map((w) => (
                                <li key={w.id}>
                                  <span className="access-node">▦ {w.name}</span>
                                </li>
                              ))}
                          </ul>
                        )}
                      </li>
                    ))}
              </ul>
            </li>
          </ul>
          <p className="hint">
            Enforcement today: scope + barriers only — fine-grained permissions are registered
            in the types-registry (see System) but the PDP is not wired yet (allow-all).
          </p>
        </div>
      )}

      {selected && selected.id !== home?.id && (
        <div className="card danger-zone">
          <h2>Danger zone</h2>
          <ul className="rows">
            <li>
              <div className="grow">
                <div className="name">Delete organization</div>
                <div className="sub">
                  Permanently deletes the tenant. Its workspaces must be deleted first (the
                  platform refuses to cascade); Keycloak users keep existing.
                </div>
              </div>
              <button className="danger" onClick={() => void removeOrg(selected)}>
                Delete organization
              </button>
            </li>
          </ul>
        </div>
      )}
      {error && <div className="error">{error}</div>}

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
  fixedTenantId,
}: {
  token: string;
  home: Tenant | null;
  orgs: Tenant[];
  workspaces: Workspace[];
  filters: Filters;
  /** Admin-area scoping: lock the view to this tenant, hide the picker. */
  fixedTenantId?: string | null;
}) {
  const all = [...(home ? [home] : []), ...orgs, ...workspaces];
  const [tenantId, setTenantId] = useState<string>(fixedTenantId ?? "");
  useEffect(() => {
    if (fixedTenantId && fixedTenantId !== tenantId) setTenantId(fixedTenantId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixedTenantId]);
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
        {!fixedTenantId && (
          <select value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
            <option value="">Select a tenant…</option>
            {all.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({shortTypeName(t.tenant_type)})
              </option>
            ))}
          </select>
        )}

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
            {/* The invite target sets the user's HOME TENANT = their whole
                access scope. Inviting into the platform root grants
                platform-wide visibility — almost never what you want. */}
            {(() => {
              const target = all.find((t) => t.id === tenantId);
              if (!target) return null;
              const isRoot = target.tenant_type !== TENANT_TYPES.organization
                && target.tenant_type !== TENANT_TYPES.workspace;
              return (
                <p className={isRoot ? "error" : "hint"} style={{ marginTop: 12 }}>
                  Inviting into: <b>{target.name}</b> — this becomes the user's home tenant and
                  access scope ({isRoot
                    ? "⚠ the PLATFORM ROOT: the user will see every managed organization. Pick an organization or workspace unless you really mean a platform admin."
                    : "they will see this tenant's subtree only"}).
                </p>
              );
            })()}
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

/// Best-effort JWT payload decode for DISPLAY only — authorization decisions
/// live in the backend (oidc-authn-plugin validates signatures; we just show
/// the person who they are signed in as). Static dev tokens are opaque, so
/// this returns null and the card degrades gracefully.
function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(b64)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

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

  const claims = decodeJwtClaims(token);
  const claim = (k: string) => {
    const v = claims?.[k];
    return typeof v === "string" && v.trim() ? v : null;
  };
  const displayName = claim("name") ?? claim("preferred_username");
  const sessionUntil =
    typeof claims?.exp === "number" ? new Date(claims.exp * 1000).toLocaleTimeString() : null;

  return (
    <>
      <h1>Profile</h1>
      <p className="subtitle">Identity as the backend sees it (from the validated token).</p>

      <div className="card">
        <h2>Signed in as</h2>
        <ul className="rows">
          <li>
            <div className="grow">
              <div className="sub">Name</div>
              <div className="name">{displayName ?? "— (opaque dev token)"}</div>
            </div>
          </li>
          {claim("preferred_username") && (
            <li>
              <div className="grow">
                <div className="sub">Username</div>
                <div className="name">{claim("preferred_username")}</div>
              </div>
            </li>
          )}
          {claim("email") && (
            <li>
              <div className="grow">
                <div className="sub">Email</div>
                <div className="name">{claim("email")}</div>
              </div>
            </li>
          )}
          <li>
            <div className="grow">
              <div className="sub">Identity provider</div>
              <div className="name">{claim("iss") ?? "static token (dev profile)"}</div>
            </div>
          </li>
          {sessionUntil && (
            <li>
              <div className="grow">
                <div className="sub">Session token valid until</div>
                <div className="name">{sessionUntil} (renewed silently)</div>
              </div>
            </li>
          )}
        </ul>
      </div>

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
  onOpen,
}: {
  token: string;
  ws: Workspace;
  onClose: () => void;
  /** Opens the session as an embedded space (same window, no new tab). */
  onOpen: (session: { id: string; url: string }) => void;
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
  const autoLaunched = useRef(false);

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

  // No polling needed for opening: the space embeds the session URL right
  // away and the container-side splash keeps the frame alive until Theia
  // takes the port over.

  // "Open Studio" means open the Studio — launch as soon as the sources are
  // known instead of asking for a second click. Creation is idempotent per
  // workspace: an already-running session is simply returned (and opened).
  useEffect(() => {
    if (repos === null || session || autoLaunched.current) return;
    autoLaunched.current = true;
    void launch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos, session]);

  async function launch() {
    setBusy(true);
    setError(null);
    try {
      // Re-read settings at launch time: the card may have been open since
      // before the last "Save repositories", and a stale snapshot silently
      // launches without the new sources/targets/token refs.
      let freshRepos = repos ?? [];
      let freshRoot = root;
      try {
        const s = await api.workspaceSettings(token, ws.id);
        freshRepos = s?.repos ?? [];
        freshRoot = {
          path: s?.root_path?.trim() || undefined,
          repoUrl: s?.root_repo_url?.trim() || undefined,
          branch: s?.root_branch?.trim() || undefined,
          tokenRef: s?.root_token_ref?.trim() || undefined,
        };
        setRepos(freshRepos);
        setRoot(freshRoot);
      } catch {
        // Settings unreachable — fall back to the snapshot we have.
      }
      const usable = freshRepos.filter((r) =>
        r.source === "local" ? Boolean(r.path?.trim()) : Boolean(r.url?.trim()),
      );
      const s = await api.createStudioSession(token, ws.id, usable, freshRoot);
      setSession(s);
      // Straight into the embedded space — starting sessions show the
      // in-container splash until the IDE is up.
      onOpen({ id: s.id, url: s.url });
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
          {/* Launch fires automatically when the card opens; the button is
              the retry path (e.g. after fixing sources or a failed start). */}
          <button className="primary" onClick={launch} disabled={busy || repos === null}>
            {busy || repos === null ? "Launching…" : error ? "Retry launch" : "Launch again"}
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
            <button
              className="primary"
              onClick={() => onOpen({ id: session.id, url: session.url })}
            >
              Open space
            </button>
            <button className="ghost" onClick={stop}>
              Stop session
            </button>
          </li>
        </ul>
      )}

      {error && <div className="error">{error}</div>}
      <p className="hint">
        Requires Docker on the backend host. The IDE image is pulled from the
        registry automatically — the first launch after a backend start may ask
        you to retry while the download finishes.
      </p>
    </div>
  );
}
