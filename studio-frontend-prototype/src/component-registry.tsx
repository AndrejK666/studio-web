/* ── The organization's component registry (ADR-0041) ─────────────────────
 *
 * Every component the organization's projects declare, wherever it is
 * declared: a `gear.toml` or `gear.gdl` directory, a `#[toolkit::gear]`
 * attribute, a FrontX package, a kit manifest. The sync walks every project
 * of the organization that is not excluded, and keeps what it finds, so this
 * page is the answer to "what components do we have" between page loads.
 *
 * The states past "declared in a project" are moved by people (phase 2): an
 * organization administrator registers, rejects, deprecates, restores,
 * publishes, merges or edits an entry from its expanded row, and every move
 * is recorded with who, when and why. Everyone else reads. */

import { useEffect, useMemo, useState } from "react";

import { ApiError, api } from "./api";
import type { RegistryDecisionInput, RegistryEntry, RegistryProjectWalk } from "./api";
import { errText } from "./format";
import {
  ACTION_LABEL,
  REGISTRY_STATES,
  STATE_LABEL,
  STATE_TONE,
  allowedActions,
  decisionLine,
  decisionRefusal,
  decisionTargets,
  filterEntries,
  isDuplicated,
  ownerLabel,
  projectsOf,
  registryProjects,
  stateCounts,
  walkLine,
} from "./registry";
import type { RegistryAction } from "./registry";

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
  /** What the last walk saw of each project. */
  const [walks, setWalks] = useState<RegistryProjectWalk[]>([]);
  const [sync, setSync] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setError(null);
    try {
      const [list, ex, walked] = await Promise.all([
        api.componentRegistry(token),
        api.registryExcludedProjects(token).catch(() => ({ project_ids: [] as string[] })),
        api.registryProjects(token).catch(() => ({ items: [] as RegistryProjectWalk[], total: 0 })),
      ]);
      setEntries(list.items);
      setExcluded(ex.project_ids);
      setWalks(walked.items);
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

  /** The people a decision can name as owner, and who decided: the caller's
   *  colleagues and the caller. Best effort -- without them an id is shown. */
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let live = true;
    void Promise.all([
      api.myColleagues(token).catch(() => []),
      api.myProfile(token).catch(() => null),
    ]).then(([colleagues, me]) => {
      if (!live) return;
      const out = new Map<string, string>();
      if (me) out.set(me.id, me.display_name || me.email || me.id);
      for (const c of colleagues) if (!out.has(c.user_id)) out.set(c.user_id, c.display_name || c.user_id);
      setPeople([...out].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)));
    });
    return () => {
      live = false;
    };
  }, [token]);
  const names = useMemo(() => Object.fromEntries(people.map((p) => [p.id, p.name])), [people]);

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
  const walkOf = (id: string) => walks.find((w) => w.project_id === id);
  const unreadable = projects.filter((p) => !(excluded ?? []).includes(p.id) && walkLine(walkOf(p.id)).failed);
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
          {unreadable.length > 0 && (
            <div className="error" style={{ fontSize: 12, margin: "0 0 8px" }} data-registry-unreadable>
              <b>
                {unreadable.length} project{unreadable.length === 1 ? "" : "s"} could not be read
              </b>{" "}
              — {unreadable.map((p) => p.name).join(", ")}. {walkLine(walkOf(unreadable[0].id)).hint ?? "See the projects below."}
            </div>
          )}
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
                    token={token}
                    entry={e}
                    entries={entries}
                    people={people}
                    names={names}
                    open={open === e.name}
                    onToggle={() => setOpen(open === e.name ? null : e.name)}
                    onDecided={() => void load()}
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
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {projects.map((p) => {
                const line = walkLine(walkOf(p.id));
                const off = (excluded ?? []).includes(p.id);
                return (
                  <li key={p.id} style={{ margin: "3px 0" }}>
                    <label>
                      <input
                        type="checkbox"
                        checked={!off}
                        disabled={excluded === null}
                        onChange={() => void toggleProject(p.id)}
                      />{" "}
                      {p.name}
                    </label>{" "}
                    <span style={{ fontSize: 12, opacity: off ? 0.5 : 0.75, color: line.failed && !off ? "var(--danger, #c33)" : undefined }}>
                      {off ? "excluded" : line.text}
                    </span>
                    {line.hint && !off && <div style={{ fontSize: 12, opacity: 0.8, marginLeft: 22 }}>{line.hint}</div>}
                  </li>
                );
              })}
            </ul>
          </details>
        </>
      )}
    </div>
  );
}

function RegistryRow({
  token,
  entry: e,
  entries,
  people,
  names,
  open,
  onToggle,
  onDecided,
  onOpenComponent,
}: {
  token: string;
  entry: RegistryEntry;
  entries: RegistryEntry[];
  people: { id: string; name: string }[];
  names: Record<string, string>;
  open: boolean;
  onToggle: () => void;
  onDecided: () => void;
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
            <div>
              <b>Owner:</b> {ownerLabel(e.owner) ?? <span style={{ opacity: 0.6 }}>nobody yet</span>}
            </div>
            {e.category && (
              <div>
                <b>Category:</b> {e.category}
              </div>
            )}
            {(e.aliases ?? []).length > 0 && (
              <div>
                <b>Also found as:</b> {(e.aliases ?? []).join(", ")}
              </div>
            )}
            {e.state === "merged" && e.merged_into && (
              <div>
                <b>Merged into</b> {e.merged_into}: what is found under this name is recorded there.
              </div>
            )}
            {e.state === "deprecated" && (
              <div>
                <b>Deprecated</b>
                {e.replaced_by ? ` — use ${e.replaced_by} instead.` : ": no longer to be chosen."}
              </div>
            )}
            {e.state === "published" && e.version && (
              <div>
                <b>Published version:</b> {e.version}
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
            <RegistryDecisions token={token} entry={e} entries={entries} people={people} names={names} onDecided={onDecided} />
          </td>
        </tr>
      )}
    </>
  );
}

/** An entry's decisions history and the moves its state allows. Anyone may
 *  read the history; only an organization administrator's move is accepted,
 *  and anyone else is told so by the server's 403. */
function RegistryDecisions({
  token,
  entry: e,
  entries,
  people,
  names,
  onDecided,
}: {
  token: string;
  entry: RegistryEntry;
  entries: RegistryEntry[];
  people: { id: string; name: string }[];
  names: Record<string, string>;
  onDecided: () => void;
}) {
  const [detail, setDetail] = useState<RegistryEntry | null>(null);
  const [form, setForm] = useState<RegistryAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ownerKind, setOwnerKind] = useState<"person" | "team">(e.owner?.kind ?? "person");
  const [ownerId, setOwnerId] = useState(e.owner?.id ?? "");
  const [ownerName, setOwnerName] = useState(e.owner?.name ?? "");
  const [reason, setReason] = useState("");
  const [target, setTarget] = useState("");
  const [version, setVersion] = useState("");
  const [kind, setKind] = useState(e.kind);
  const [category, setCategory] = useState(e.category ?? "");
  const [capabilities, setCapabilities] = useState(e.capabilities.join(", "));
  const [description, setDescription] = useState(e.description ?? "");

  useEffect(() => {
    let live = true;
    api
      .registryEntry(token, e.name)
      .then((d) => live && setDetail(d))
      .catch(() => live && setDetail(null));
    return () => {
      live = false;
    };
  }, [token, e.name, e.state]);

  const targets = useMemo(() => decisionTargets(entries, e.name), [entries, e.name]);
  const decisions = detail?.decisions ?? [];

  const open = (action: RegistryAction) => {
    setError(null);
    setForm(form === action ? null : action);
  };

  const submit = async () => {
    if (!form) return;
    const input: RegistryDecisionInput = { action: form };
    const owner = () =>
      ownerName.trim()
        ? { kind: ownerKind, id: ownerKind === "person" ? ownerId || null : null, name: ownerName.trim() }
        : undefined;
    if (form === "register" || form === "edit") {
      input.owner = owner();
      if (form === "edit") {
        input.kind = kind.trim() || undefined;
        input.category = category.trim() || null;
        input.description = description.trim() || null;
      } else if (category.trim()) {
        input.category = category.trim();
      }
      input.capabilities = capabilities
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
    }
    if (reason.trim()) input.reason = reason.trim();
    if (form === "deprecate" && target) input.replaced_by = target;
    if (form === "merge") input.merge_into = target;
    if (form === "publish" && version.trim()) input.version = version.trim();
    setBusy(true);
    setError(null);
    try {
      const after = await api.decideRegistry(token, e.name, input);
      setDetail(after);
      setForm(null);
      setReason("");
      setTarget("");
      onDecided();
    } catch (cause) {
      setError(decisionRefusal(cause instanceof ApiError ? cause.status : undefined, errText(cause)));
    } finally {
      setBusy(false);
    }
  };

  const ownerFields = (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
      <b>Owner</b>
      <select value={ownerKind} onChange={(ev) => setOwnerKind(ev.target.value as "person" | "team")} aria-label="Owner kind">
        <option value="person">person</option>
        <option value="team">team</option>
      </select>
      {ownerKind === "person" && people.length > 0 ? (
        <select
          value={ownerId}
          aria-label="Owner"
          onChange={(ev) => {
            setOwnerId(ev.target.value);
            setOwnerName(people.find((p) => p.id === ev.target.value)?.name ?? "");
          }}
        >
          <option value="">choose a person…</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      ) : (
        <input
          placeholder={ownerKind === "person" ? "Person's name" : "Team name"}
          value={ownerName}
          onChange={(ev) => {
            setOwnerName(ev.target.value);
            setOwnerId("");
          }}
          aria-label="Owner name"
        />
      )}
    </div>
  );

  const targetSelect = (label: string, required: boolean) => (
    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <b>{label}</b>
      <select value={target} onChange={(ev) => setTarget(ev.target.value)} aria-label={label}>
        <option value="">{required ? "choose an entry…" : "none"}</option>
        {targets.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
    </label>
  );

  const ready =
    form === "register"
      ? ownerName.trim() !== ""
      : form === "reject"
        ? reason.trim() !== ""
        : form === "merge"
          ? target !== ""
          : true;

  return (
    <div style={{ marginTop: 8, borderTop: "1px solid var(--border, rgba(0,0,0,0.1))", paddingTop: 6 }} data-registry-decisions>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <b>Decide</b>
        {allowedActions(e.state).map((a) => (
          <button key={a} type="button" className={form === a ? "primary" : ""} onClick={() => open(a)} disabled={busy}>
            {ACTION_LABEL[a]}
          </button>
        ))}
      </div>
      {form && (
        <div style={{ display: "grid", gap: 6, margin: "6px 0", maxWidth: 560 }}>
          {(form === "register" || form === "edit") && ownerFields}
          {(form === "register" || form === "edit") && (
            <>
              {form === "edit" && (
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <b>Kind</b>
                  <input value={kind} onChange={(ev) => setKind(ev.target.value)} aria-label="Kind" />
                </label>
              )}
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <b>Category</b>
                <input value={category} onChange={(ev) => setCategory(ev.target.value)} aria-label="Category" />
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <b>Capabilities</b>
                <input
                  value={capabilities}
                  onChange={(ev) => setCapabilities(ev.target.value)}
                  placeholder="comma-separated keys"
                  aria-label="Capabilities"
                  style={{ flex: 1 }}
                />
              </label>
              {form === "edit" && (
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <b>Description</b>
                  <input value={description} onChange={(ev) => setDescription(ev.target.value)} aria-label="Description" style={{ flex: 1 }} />
                </label>
              )}
            </>
          )}
          {form === "deprecate" && targetSelect("Replaced by", false)}
          {form === "merge" && targetSelect("Merge into", true)}
          {form === "publish" && (
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <b>Version</b>
              <input value={version} onChange={(ev) => setVersion(ev.target.value)} placeholder="e.g. 1.0.0" aria-label="Version" />
            </label>
          )}
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <b>{form === "reject" ? "Reason" : "Why"}</b>
            <input
              value={reason}
              onChange={(ev) => setReason(ev.target.value)}
              placeholder={form === "reject" ? "required: why this is not a gear" : "optional"}
              aria-label="Reason"
              style={{ flex: 1 }}
            />
          </label>
          <span>
            <button type="button" className="primary" disabled={busy || !ready} onClick={() => void submit()}>
              {busy ? "Saving…" : ACTION_LABEL[form].replace("…", "")}
            </button>{" "}
            <button type="button" onClick={() => setForm(null)} disabled={busy}>
              Cancel
            </button>
          </span>
        </div>
      )}
      {error && (
        <div className="error" style={{ fontSize: 12 }} data-registry-decision-error>
          {error}
        </div>
      )}
      <div style={{ marginTop: 4 }}>
        <b>Decisions</b>
      </div>
      {decisions.length === 0 ? (
        <div style={{ opacity: 0.6 }}>None yet: {e.state === "declared" ? "found by the walk, nobody has decided." : "nothing recorded."}</div>
      ) : (
        <ul style={{ margin: "2px 0 0", paddingLeft: 18 }}>
          {decisions.map((d, i) => (
            <li key={`${d.at}:${i}`}>
              <span style={{ opacity: 0.6 }}>{new Date(d.at).toLocaleString()}</span> · {decisionLine(d, names)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
