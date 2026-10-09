/* ── The organization's component registry (ADR-0041) ─────────────────────
 *
 * Every component the organization's projects declare, wherever it is
 * declared: a `gear.toml` or `gear.gdl` directory, a `#[toolkit::gear]`
 * attribute, a FrontX package, a kit manifest. The sync walks every project
 * of the organization that is not excluded, and keeps what it finds, so this
 * page is the answer to "what components do we have" between page loads.
 *
 * Phase 1 reads: the states past "declared in a project" are moved by people
 * in the next phase. What a person decides here today is which projects the
 * walk reads. */

import { useEffect, useMemo, useState } from "react";

import { ApiError, api } from "./api";
import type { RegistryEntry } from "./api";
import { errText } from "./format";
import {
  REGISTRY_STATES,
  STATE_LABEL,
  STATE_TONE,
  filterEntries,
  isDuplicated,
  projectsOf,
  registryProjects,
  stateCounts,
} from "./registry";

export function ComponentRegistry({
  token,
  projects,
  onOpenComponent,
}: {
  token: string;
  /** The organization's projects, for choosing which ones the walk reads. */
  projects: { id: string; name: string }[];
  onOpenComponent?: (name: string) => void;
}) {
  const [entries, setEntries] = useState<RegistryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [state, setState] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [project, setProject] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [excluded, setExcluded] = useState<string[] | null>(null);
  const [sync, setSync] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setError(null);
    try {
      const [list, ex] = await Promise.all([
        api.componentRegistry(token),
        api.registryExcludedProjects(token).catch(() => ({ project_ids: [] as string[] })),
      ]);
      setEntries(list.items);
      setExcluded(ex.project_ids);
    } catch (cause) {
      // A backend from before the registry answers 404: say so plainly.
      if (cause instanceof ApiError && cause.status === 404) setMissing(true);
      else setError(errText(cause));
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  /** Read every project again now, rather than waiting for the schedule. */
  const readNow = async () => {
    setBusy(true);
    setSync("queued…");
    try {
      const { run_id } = await api.syncComponents(token);
      const deadline = Date.now() + 10 * 60 * 1000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const t = await api.componentsCatalogTask(token, run_id);
        if (t.status === "succeeded") {
          setSync("");
          await load();
          break;
        }
        if (t.status === "failed" || t.status === "cancelled") {
          setSync(t.message || `sync ${t.status}`);
          break;
        }
        setSync((t.message || t.status).replace(/…$/, "") + "…");
        if (Date.now() > deadline) {
          setSync("still running on the server");
          break;
        }
      }
    } catch (cause) {
      setSync(errText(cause));
    } finally {
      setBusy(false);
    }
  };

  const toggleProject = async (id: string) => {
    const next = (excluded ?? []).includes(id) ? (excluded ?? []).filter((x) => x !== id) : [...(excluded ?? []), id];
    setExcluded(next);
    try {
      await api.saveRegistryExcludedProjects(token, next);
    } catch (cause) {
      setError(errText(cause));
    }
  };

  const counts = useMemo(() => stateCounts(entries ?? []), [entries]);
  const seen = useMemo(() => registryProjects(entries ?? []), [entries]);
  const shown = useMemo(() => filterEntries(entries ?? [], { state, q, project }), [entries, state, q, project]);
  const duplicated = (entries ?? []).filter(isDuplicated).length;
  const orphaned = (entries ?? []).filter((e) => e.orphaned).length;

  if (missing) {
    return (
      <div className="card">
        <h2>Registry</h2>
        <p className="empty">This backend has no component registry yet (ADR-0041).</p>
      </div>
    );
  }

  return (
    <div className="card" data-component-registry>
      <div className="card-head">
        <div>
          <h2>Registry</h2>
          <p className="subtitle">
            Every component the organization&apos;s projects declare — a <code>gear.toml</code> or{" "}
            <code>gear.gdl</code>, a <code>#[toolkit::gear]</code> attribute, a FrontX package or a kit
            manifest — and where each one is. Read from every project below on a schedule, after a push,
            or now.
          </p>
        </div>
        <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {sync && <span className="hint" style={{ fontSize: 12 }}>{sync}</span>}
          <button className="primary" disabled={busy} onClick={() => void readNow()}>
            {busy ? "Reading…" : "Read the projects now"}
          </button>
        </span>
      </div>
      {error && <div className="error">{error}</div>}

      {entries === null ? (
        <p className="empty">Reading the registry…</p>
      ) : (
        <>
          <p style={{ fontSize: 13, margin: "0 0 8px" }}>
            <b>
              {entries.length} component{entries.length === 1 ? "" : "s"}
            </b>
            {duplicated > 0 && ` · ${duplicated} declared in more than one repository`}
            {orphaned > 0 && ` · ${orphaned} no repository declares any more`}
          </p>
          <div className="chips" role="group" aria-label="State">
            <button type="button" className={`chip ${state === null ? "on" : ""}`} onClick={() => setState(null)}>
              all<span className="chip-n">{entries.length}</span>
            </button>
            {REGISTRY_STATES.filter((s) => counts[s]).map((s) => (
              <button key={s} type="button" className={`chip ${state === s ? "on" : ""}`} onClick={() => setState(s)}>
                {STATE_LABEL[s]}
                <span className="chip-n">{counts[s]}</span>
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, margin: "8px 0", flexWrap: "wrap" }}>
            <input
              placeholder="Search names, descriptions, paths"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              style={{ flex: "1 1 260px" }}
            />
            <select value={project ?? ""} onChange={(e) => setProject(e.target.value || null)} aria-label="Project">
              <option value="">every project</option>
              {seen.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          {shown.length === 0 ? (
            <p className="empty">
              {entries.length === 0
                ? "Nothing yet: no project has been read. Read the projects now, or wait for the schedule."
                : "No component matches."}
            </p>
          ) : (
            <table className="ptable">
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Component</th>
                  <th style={{ textAlign: "left" }}>State</th>
                  <th style={{ textAlign: "left" }}>Projects</th>
                  <th style={{ textAlign: "left" }}>Declared at</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => (
                  <RegistryRow
                    key={e.name}
                    entry={e}
                    open={open === e.name}
                    onToggle={() => setOpen(open === e.name ? null : e.name)}
                    onOpenComponent={onOpenComponent}
                  />
                ))}
              </tbody>
            </table>
          )}

          <details style={{ marginTop: 12, fontSize: 13 }}>
            <summary style={{ cursor: "pointer" }}>
              Projects the registry reads ({projects.length - (excluded ?? []).filter((id) => projects.some((p) => p.id === id)).length} of{" "}
              {projects.length})
            </summary>
            <p className="hint" style={{ fontSize: 12 }}>
              Every project is read unless it is excluded here: a registry with gaps nobody chose is what
              this page is for.
            </p>
            <ul style={{ listStyle: "none", padding: 0, margin: 0, columns: 2 }}>
              {projects.map((p) => (
                <li key={p.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={!(excluded ?? []).includes(p.id)}
                      disabled={excluded === null}
                      onChange={() => void toggleProject(p.id)}
                    />{" "}
                    {p.name}
                  </label>
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </div>
  );
}

function RegistryRow({
  entry: e,
  open,
  onToggle,
  onOpenComponent,
}: {
  entry: RegistryEntry;
  open: boolean;
  onToggle: () => void;
  onOpenComponent?: (name: string) => void;
}) {
  const first = e.occurrences[0];
  return (
    <>
      <tr style={{ cursor: "pointer" }} onClick={onToggle} aria-expanded={open}>
        <td>
          <b>{e.name}</b> <span style={{ opacity: 0.6, fontSize: 12 }}>{e.kind}</span>
          {isDuplicated(e) && (
            <span className="badge warn" style={{ marginLeft: 6 }} title="Declared in more than one repository">
              ×{new Set(e.occurrences.map((o) => o.repo)).size} repos
            </span>
          )}
          {e.orphaned && (
            <span className="badge" style={{ marginLeft: 6 }} title="No repository declares it any more">
              orphaned
            </span>
          )}
          {e.description && <div style={{ fontSize: 12, opacity: 0.75 }}>{e.description}</div>}
        </td>
        <td>
          <span className={`badge ${STATE_TONE[e.state] ?? ""}`}>{STATE_LABEL[e.state] ?? e.state}</span>
        </td>
        <td style={{ fontSize: 13 }}>{projectsOf(e).join(", ") || "—"}</td>
        <td style={{ fontSize: 12 }}>
          {first ? (
            <>
              <code>{first.path}</code> <span style={{ opacity: 0.6 }}>({first.declared_in})</span>
              {e.occurrences.length > 1 && <span style={{ opacity: 0.6 }}> and {e.occurrences.length - 1} more</span>}
            </>
          ) : (
            "—"
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={4} style={{ fontSize: 12, background: "var(--muted, rgba(0,0,0,0.03))" }}>
            {e.capabilities.length > 0 && (
              <div>
                <b>Capabilities:</b> {e.capabilities.join(", ")}
              </div>
            )}
            {e.owner && (
              <div>
                <b>Owner:</b> {e.owner}
              </div>
            )}
            <div style={{ marginTop: 4 }}>
              <b>Found in</b>
            </div>
            <ul style={{ margin: "2px 0 0", paddingLeft: 18 }}>
              {e.occurrences.map((o) => (
                <li key={`${o.repo}:${o.path}`}>
                  {o.project_name ?? o.project_id ?? "—"} · <code>{o.repo}</code>
                  {o.git_ref ? `@${o.git_ref}` : ""} · <code>{o.path}</code> · {o.declared_in}
                  {o.commit ? <span style={{ opacity: 0.6 }}> · {o.commit.slice(0, 7)}</span> : null}
                </li>
              ))}
            </ul>
            {(e.first_seen || e.last_seen) && (
              <div style={{ opacity: 0.7, marginTop: 4 }}>
                {e.first_seen && `first seen ${new Date(e.first_seen).toLocaleDateString()}`}
                {e.last_seen && ` · last read ${new Date(e.last_seen).toLocaleString()}`}
              </div>
            )}
            {onOpenComponent && (
              <button type="button" className="linklike" style={{ marginTop: 6 }} onClick={() => onOpenComponent(e.name)}>
                Open in the catalogue →
              </button>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
