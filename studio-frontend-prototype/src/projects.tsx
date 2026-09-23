/* ── Workspaces portfolio ─────────────────────────────────────────────────────
 *
 * Level 1 of Org → Workspace → Project. This screen lists the WORKSPACES of the
 * organization in context — each an AM tenant of type `workspace`. Opening one
 * drills into its projects (see WorkspaceProjects in App.tsx); a project is its
 * own AM tenant and owns the code context (sources, IDE, artifacts, people).
 *
 * On the wire:
 *   workspace = AM tenant of type `workspace` (api.tenantChildren of the org)
 * The organization tenant above still exists and still owns the connector
 * catalogue — it is simply not a place you navigate to.
 */

import { Fragment, useCallback, useEffect, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import { api, TENANT_TYPES, type User } from "./api";
import { errText, matches } from "./format";
import { portfolioRollups, rollupText, type WorkspaceRollup } from "./rollups";
import { Tile, TileGrid, ViewToggle, useViewMode } from "./view-mode";

/** Initials + a stable hue from a name — the mockups' colored member discs. */
function initials(name: string): string {
  const parts = name.trim().split(/[\s._@-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
function hueOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}
/** Overlapping member avatars (real users from tenantUsers), +N overflow. */
function Avatars({ users }: { users?: User[] }) {
  if (!users) return <span className="sub">…</span>;
  if (users.length === 0) return <span className="sub">—</span>;
  return (
    <span className="avatars">
      {users.slice(0, 3).map((u) => {
        const label = u.display_name || u.username;
        return (
          <span
            key={u.id}
            className="avatar"
            style={{ "--hue": hueOf(label) } as CSSProperties}
            title={label}
          >
            {initials(label)}
          </span>
        );
      })}
      {users.length > 3 && <span className="avatars-more">+{users.length - 3}</span>}
    </span>
  );
}

/** A small folder glyph for the workspace name cell. */
function FolderIcon() {
  return (
    <svg className="folder" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M1.6 4.4A1.4 1.4 0 0 1 3 3h2.8l1.4 1.4H13A1.4 1.4 0 0 1 14.4 5.8v5.0A1.4 1.4 0 0 1 13 12.2H3A1.4 1.4 0 0 1 1.6 10.8z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The AM tenant behind a workspace — structurally what App.tsx holds. */
export interface RootProject {
  id: string;
  name: string;
  /** Implicit organization owning it. Hidden in the UI, kept in the model. */
  orgId: string;
  orgName: string;
  self_managed: boolean;
}

export function ProjectsPortfolio({
  token,
  roots,
  query,
  selfManagedOnly,
  sort,
  homeOrgId,
  org,
  onOpen,
  onOpenStudio,
  onOpenProject,
  onChanged,
}: {
  token: string;
  roots: RootProject[];
  /** The organization these workspaces belong to — chosen in the sidebar
   *  switcher; shown here only as breadcrumb/footer context. */
  org: { id: string; name: string } | null;
  /** Search box from the right-hand filter panel. */
  query: string;
  /** Filter panel: only workspaces whose tenant raised the isolation barrier. */
  selfManagedOnly: boolean;
  sort: "name-asc" | "name-desc";
  /** Where a new workspace is created — the hidden organization. */
  homeOrgId: string | null;
  onOpen: (root: RootProject) => void;
  onOpenStudio: (root: RootProject) => void;
  /** Open a nested project (from the expandable tree under a workspace). */
  onOpenProject?: (wsId: string, p: { id: string; name: string }) => void;
  onChanged: () => void;
}) {
  const [people, setPeople] = useState<Record<string, User[]>>({});
  /** What each workspace contains. Absent until counted — see rollups.ts on
   *  why an uncounted workspace must not render as 0. */
  const [rollups, setRollups] = useState<Record<string, WorkspaceRollup>>({});
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Expandable tree of nested projects per workspace (lazy-loaded on expand).
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [children, setChildren] = useState<Record<string, { id: string; name: string }[]>>({});
  const [loadingKids, setLoadingKids] = useState<Set<string>>(new Set());

  const loadChildren = useCallback(
    async (wsId: string) => {
      setLoadingKids((s) => new Set(s).add(wsId));
      try {
        const page = await api.tenantChildren(token, wsId);
        const kids = (page.items ?? [])
          .filter((t) => t.tenant_type === TENANT_TYPES.project)
          .map((t) => ({ id: t.id, name: t.name }));
        setChildren((c) => ({ ...c, [wsId]: kids }));
      } catch {
        setChildren((c) => ({ ...c, [wsId]: [] }));
      } finally {
        setLoadingKids((s) => {
          const n = new Set(s);
          n.delete(wsId);
          return n;
        });
      }
    },
    [token],
  );

  const toggle = (wsId: string) => {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(wsId)) {
        n.delete(wsId);
      } else {
        n.add(wsId);
        if (children[wsId] === undefined) void loadChildren(wsId);
      }
      return n;
    });
  };

  const ids = roots.map((r) => r.id).join(",");

  const load = useCallback(async () => {
    if (!ids) {
      setPeople({});
      setRollups({});
      return;
    }
    const list = ids.split(",");
    // Per workspace, and tolerant: a self-managed tenant answers 404 from
    // outside its subtree, which is tenant isolation working — not a reason to
    // blank the page.
    const entries = await Promise.all(
      list.map(async (id) => {
        const users = await api.tenantUsers(token, id).then(
          (p) => p.items ?? [],
          () => [] as User[],
        );
        return [id, users] as const;
      }),
    );
    setPeople(Object.fromEntries(entries));
    // The project counts, and the children they counted — ONE request for the
    // whole table now, not one per workspace. Kept as a second pass rather than
    // folded into the one above so the table paints with names and people
    // first: a count arriving a moment later is a cell changing from "—" to a
    // number, which is much better than a blank page while it is fetched.
    const { workspaces, projects } = await portfolioRollups(token);
    setRollups(
      Object.fromEntries(list.map((id) => [id, { projects: workspaces.get(id)?.projects ?? null }])),
    );
    // The same answer carries the parentage, so the tree expands without
    // asking again.
    setChildren((c) => {
      const next = { ...c };
      for (const id of list) {
        const kids = [...projects.entries()]
          .filter(([, p]) => p.parentId === id)
          .map(([pid, p]) => ({ id: pid, name: p.name }));
        if (kids.length) next[id] = kids;
      }
      return next;
    });
  }, [token, ids]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!homeOrgId || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.createTenant(token, {
        name: name.trim(),
        parent_id: homeOrgId,
        tenant_type: TENANT_TYPES.workspace,
      });
      setName("");
      setCreating(false);
      onChanged();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(root: RootProject) {
    if (!window.confirm(`Delete workspace “${root.name}”? This cannot be undone.`)) return;
    setError(null);
    try {
      await api.deleteTenant(token, root.id);
      onChanged();
    } catch (err) {
      setError(errText(err));
    }
  }

  const [view, setView] = useViewMode("workspaces.view");

  const visible = roots
    .filter((r) => matches(query, r.name))
    .filter((r) => !selfManagedOnly || r.self_managed)
    .sort((a, b) => (sort === "name-desc" ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name)));

  return (
    <>
      <div className="topbar">
        <div>
          {/* The organization is chosen in the sidebar switcher now; the
              portfolio just names where you are. */}
          {org && <div className="eyebrow">{org.name}</div>}
          <h1 style={{ marginTop: 8 }}>Workspaces</h1>
          <p className="subtitle" style={{ margin: 0 }}>
            A workspace groups related projects. Open one to see its projects — each project owns its
            connectors, artifacts and people, and its own IDE sessions.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <ViewToggle mode={view} onChange={setView} />
          <button className="primary" disabled={!homeOrgId} onClick={() => setCreating((v) => !v)}>
            New workspace
          </button>
        </div>
      </div>

      {creating && (
        <div className="card">
          <form className="inline" onSubmit={create}>
            <input
              autoFocus
              style={{ flex: 1 }}
              placeholder="Workspace name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button className="primary" disabled={busy || !name.trim()}>
              {busy ? "Creating…" : "Create"}
            </button>
            <button type="button" className="ghost" onClick={() => setCreating(false)}>
              cancel
            </button>
          </form>
          <p className="hint">
            Created inside your organization — which stays out of the UI on purpose: it owns the
            shared connector catalogue and nothing you need to navigate.
          </p>
        </div>
      )}

      {error && <div className="error">{error}</div>}

      <div className="card">
        {roots.length === 0 ? (
          <p className="empty">No workspaces yet — “New workspace” starts the first one.</p>
        ) : visible.length === 0 ? (
          <p className="empty">No workspaces match the current filters.</p>
        ) : view === "tiles" ? (
          /* The tree does not come with: a card that can unfold into other
             cards is a table with extra steps. Tiles answer "which workspace",
             and opening one is how you see its projects. */
          <TileGrid>
            {visible.map((root) => (
              <Tile
                key={root.id}
                icon={<FolderIcon />}
                title={root.name}
                subtitle={root.self_managed ? "self-managed" : "workspace"}
                onClick={() => onOpen(root)}
                /* The same two facts the table columns carry. People come
                   from the avatar list rather than the rollup, which does not
                   have them — and `?? null` keeps "not read yet" showing as a
                   dash instead of as nobody. */
                stats={[
                  { label: "projects", value: rollupText(rollups[root.id]?.projects ?? null) },
                  { label: "people", value: rollupText(people[root.id]?.length ?? null) },
                ]}
                footer={
                  <>
                    <Avatars users={people[root.id]} />
                    <button
                      className="ghost"
                      style={{ marginLeft: "auto" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenStudio(root);
                      }}
                    >
                      Open in IDE
                    </button>
                  </>
                }
              />
            ))}
          </TileGrid>
        ) : (
          <table className="ptable">
            <thead>
              <tr>
                <th>Workspace</th>
                <th className="pnum">Projects</th>
                <th>People</th>
                <th aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {visible.map((root) => {
                const isOpen = expanded.has(root.id);
                const kids = children[root.id];
                const kidsLoading = loadingKids.has(root.id);
                return (
                  <Fragment key={root.id}>
                    <tr className="prow root">
                      <td>
                        <div className="pcell">
                          <button
                            type="button"
                            className="tree-toggle"
                            aria-label={isOpen ? "Collapse projects" : "Expand projects"}
                            aria-expanded={isOpen}
                            onClick={() => toggle(root.id)}
                          >
                            {isOpen ? "▾" : "▸"}
                          </button>
                          <span className="pico" aria-hidden>
                            <FolderIcon />
                          </span>
                          <div>
                            <button type="button" className="pname" onClick={() => onOpen(root)}>
                              {root.name}
                            </button>
                            <div className="sub">{root.self_managed ? "self-managed" : "workspace"}</div>
                          </div>
                        </div>
                      </td>
                      <td className="pnum">{rollupText(rollups[root.id]?.projects ?? null)}</td>
                      <td>
                        <Avatars users={people[root.id]} />
                      </td>
                      <td className="pactions">
                        <button onClick={() => onOpen(root)}>Open</button>
                        <button className="primary" onClick={() => onOpenStudio(root)}>
                          Open in IDE
                        </button>
                        <button className="ghost" title="Delete workspace" onClick={() => void remove(root)}>
                          ✕
                        </button>
                      </td>
                    </tr>
                    {isOpen &&
                      (kids === undefined && kidsLoading ? (
                        <tr className="prow nested">
                          <td colSpan={4}>
                            <div className="pcell indent sub">Loading projects…</div>
                          </td>
                        </tr>
                      ) : (kids ?? []).length === 0 ? (
                        <tr className="prow nested">
                          <td colSpan={4}>
                            <div className="pcell indent sub">No projects yet</div>
                          </td>
                        </tr>
                      ) : (
                        (kids ?? []).map((p) => (
                          <tr key={p.id} className="prow nested">
                            <td>
                              <div className="pcell indent">
                                <span className="pico" aria-hidden>
                                  ▦
                                </span>
                                <button type="button" className="pname" onClick={() => onOpenProject?.(root.id, p)}>
                                  {p.name}
                                </button>
                              </div>
                            </td>
                            {/* Projects and People are workspace facts. A
                                project's own counts belong on the projects
                                table inside the workspace, which has room for
                                all three of them. */}
                            <td />
                            <td />
                            <td className="pactions">
                              <button onClick={() => onOpenProject?.(root.id, p)}>Open</button>
                            </td>
                          </tr>
                        ))
                      ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
        {visible.length > 0 && (
          <div className="ptable-foot">
            <span>
              {visible.length} workspace{visible.length === 1 ? "" : "s"}
            </span>
            {org && <span className="sub">in {org.name}</span>}
          </div>
        )}
      </div>
    </>
  );
}
