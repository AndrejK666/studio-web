import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type CatalogNode,
  type KitInstallation,
  type KitMaterialization,
  type ProjectRepository,
  type StudioKit,
} from "./api";
import { composePlan, profilesByName, type PlanRow } from "./compose";
import { errText } from "./format";

export function ProjectKits({
  token,
  projectId,
  workspaceId,
}: {
  token: string;
  projectId: string;
  /** The parent workspace — documents and the capability vocabulary hang off it. */
  workspaceId: string;
}) {
  const [catalog, setCatalog] = useState<StudioKit[] | null>(null);
  const [installed, setInstalled] = useState<KitInstallation[]>([]);
  const [versions, setVersions] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repositories, setRepositories] = useState<ProjectRepository[] | null>(null);
  const [repositoriesNote, setRepositoriesNote] = useState<string | null>(null);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [scopes, setScopes] = useState<Record<string, boolean>>({});
  // Slug@version pairs already reconciled on this mount, so a reload does not
  // re-run a rollout that has nothing left to do.
  const reconciled = useRef(new Set<string>());

  const reload = useCallback(async () => {
    setError(null);
    let current: KitInstallation[] = [];
    try {
      const [kits, installations] = await Promise.all([
        api.kits(token),
        api.kitInstallations(token, projectId),
      ]);
      current = installations.items;
      setCatalog(kits.items);
      setInstalled(current);
      setVersions((previous) => {
        const next = { ...previous };
        for (const kit of kits.items) {
          const existing = current.find((item) => item.kit_slug === kit.slug);
          if (!next[kit.slug]) next[kit.slug] = existing?.version ?? kit.default_version;
        }
        return next;
      });
    } catch (cause) {
      setError(errText(cause));
      setCatalog([]);
    }

    // Loaded apart from the catalogue, and its failure is not an error banner.
    // The repository list comes from the running IDE, so "no session yet" is
    // the ordinary state of this page -- folding it into the load above would
    // blank the kit grid every time someone opens the tab before the IDE.
    let mounted: ProjectRepository[] | null = null;
    try {
      mounted = (await api.projectRepositories(token, projectId)).items;
      setRepositories(mounted);
      setRepositoriesNote(null);
    } catch (cause) {
      setRepositories(null);
      setRepositoriesNote(errText(cause));
    }

    /*
     * The automatic half of "install in every repository".
     *
     * A kit scoped that way is meant to reach a repository that joined the
     * project after it was installed, and a running session is the only moment
     * the portal can see that such a repository exists. The call is idempotent
     * -- the backend skips repositories already at this version -- and it is
     * keyed by slug@version here so a reload does not keep asking.
     */
    if (!mounted) return;
    const pending = current.filter(
      (installation) =>
        installation.scope === "all-repositories" &&
        installation.status !== "installing" &&
        !reconciled.current.has(`${installation.kit_slug}@${installation.version}`),
    );
    if (pending.length === 0) return;
    for (const installation of pending) {
      reconciled.current.add(`${installation.kit_slug}@${installation.version}`);
      try {
        await api.reconcileKitInstallation(token, projectId, installation.kit_slug);
      } catch {
        // Per-repository outcomes are recorded on the rows either way; the
        // refresh below is what surfaces them.
      }
    }
    try {
      setInstalled((await api.kitInstallations(token, projectId)).items);
    } catch {
      // Keep what is on screen rather than blanking it over a refresh.
    }
  }, [projectId, token]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const bySlug = useMemo(
    () => new Map(installed.map((installation) => [installation.kit_slug, installation])),
    [installed],
  );

  /*
   * Where a kit lands, most specific first: what the user picked, then the
   * repository this kit was last materialized into (so "Reinstall / update"
   * does not silently move it), then the project repository.
   *
   * Undefined is a valid answer -- with no session the list is unknown, the
   * request goes out without `repository_id`, and the IDE resolves the project
   * repository itself. That is the same call this page made before the picker
   * existed.
   */
  const defaultRepositoryId = useMemo(
    () =>
      repositories?.find((repository) => repository.kind === "project")?.repository_id ??
      repositories?.[0]?.repository_id,
    [repositories],
  );

  const targetFor = (slug: string): string | undefined =>
    targets[slug] ?? bySlug.get(slug)?.repository_id ?? defaultRepositoryId;

  const everyRepository = (slug: string): boolean =>
    scopes[slug] ?? bySlug.get(slug)?.scope === "all-repositories";

  /*
   * The label recorded at materialization time wins: it is what the repository
   * was called when the kit landed there, and it stays readable after the IDE
   * is closed. The live list only fills gaps -- rows upgraded from a
   * pre-materializations document have no label of their own.
   */
  const repositoryLabel = (entry: KitMaterialization): string => {
    const mounted = repositories?.find(
      (repository) => repository.repository_id === entry.repository_id,
    );
    const name = entry.repository_label ?? mounted?.label ?? entry.repository_id;
    return mounted?.kind === "project" ? `${name} · whole project` : name;
  };

  const install = async (kit: StudioKit) => {
    const version = (versions[kit.slug] ?? kit.default_version).trim();
    if (!version) return;
    setBusy(kit.slug);
    setError(null);
    try {
      const scope = everyRepository(kit.slug) ? "all-repositories" : "project";
      await api.requestKitInstallation(token, projectId, {
        kit_slug: kit.slug,
        version,
        install_mode: "copy",
        scope,
      });
      if (scope === "all-repositories") {
        // One call covers every repository, so there is no target to choose
        // and no point materializing one of them first.
        reconciled.current.add(`${kit.slug}@${version}`);
        await api.reconcileKitInstallation(token, projectId, kit.slug);
      } else {
        await api.materializeKitInstallation(token, projectId, kit.slug, targetFor(kit.slug));
      }
      await reload();
    } catch (cause) {
      await reload();
      setError(errText(cause));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (kit: StudioKit) => {
    setBusy(kit.slug);
    setError(null);
    try {
      await api.removeKitInstallation(token, projectId, kit.slug);
      await reload();
    } catch (cause) {
      setError(errText(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="kits-view">
      <SuggestedComponents token={token} projectId={projectId} workspaceId={workspaceId} />

      <div className="card-head">
        <div>
          <h2>Project kits</h2>
          <p className="subtitle">
            Reusable Studio workflows and conventions, pinned to a Git version for this project.
          </p>
        </div>
        <button className="ghost" onClick={() => void reload()} disabled={busy !== null}>
          Refresh
        </button>
      </div>

      <div className="notice">
        Open this project's IDE first. Install requests are sent through the authenticated backend
        to its trusted <code>cfs</code> runner; the browser never executes repository scripts.
      </div>
      {repositoriesNote && (
        <div className="notice">
          The IDE has not reported its repositories yet, so a kit will be installed into the
          project repository. Open the IDE and press Refresh to choose a different one.
        </div>
      )}
      {error && <div className="error">{error}</div>}

      {catalog === null ? (
        <p className="empty">Loading kit registry…</p>
      ) : catalog.length === 0 ? (
        <p className="empty">No kits are published in this registry.</p>
      ) : (
        <div className="kit-grid">
          {catalog.map((kit) => {
            const installation = bySlug.get(kit.slug);
            const isBusy = busy === kit.slug;
            return (
              <article className="card kit-card" key={kit.slug}>
                <div className="kit-card-head">
                  <div>
                    <span className="badge info">{kit.publisher}</span>
                    <h3>{kit.name}</h3>
                  </div>
                  {installation && (
                    <span className={`badge ${installation.status}`}>{installation.status}</span>
                  )}
                </div>
                <p>{kit.description}</p>
                <p className="sub">
                  <a href={kit.repository_url} target="_blank" rel="noreferrer">
                    {kit.repository_url} ↗
                  </a>
                  <br />Manifest: <code>{kit.manifest_path}</code>
                </p>
                <div className="kit-controls">
                  <label>
                    Version / Git ref
                    <input
                      value={versions[kit.slug] ?? kit.default_version}
                      onChange={(event) =>
                        setVersions((current) => ({ ...current, [kit.slug]: event.target.value }))
                      }
                    />
                  </label>
                  <label>
                    Source policy
                    <input value="Official GitHub kit · managed copy" disabled />
                  </label>
                  {repositories && repositories.length > 1 && (
                    <label className="kit-scope">
                      <input
                        type="checkbox"
                        checked={everyRepository(kit.slug)}
                        onChange={(event) =>
                          setScopes((current) => ({
                            ...current,
                            [kit.slug]: event.target.checked,
                          }))
                        }
                      />
                      Install in every repository
                    </label>
                  )}
                  {repositories && repositories.length > 1 && !everyRepository(kit.slug) && (
                    <label>
                      Repository
                      <select
                        value={targetFor(kit.slug) ?? ""}
                        onChange={(event) =>
                          setTargets((current) => ({ ...current, [kit.slug]: event.target.value }))
                        }
                      >
                        {repositories.map((repository) => (
                          <option key={repository.repository_id} value={repository.repository_id}>
                            {repository.kind === "project"
                              ? `${repository.label} · whole project`
                              : repository.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
                {installation && (
                  <p className="sub">
                    Requested <code>{installation.version}</code> · {installation.install_mode} ·{" "}
                    {new Date(installation.requested_at).toLocaleString()}
                  </p>
                )}
                {installation && installation.materializations?.length ? (
                  <ul className="sub kit-materializations">
                    {installation.materializations.map((entry) => (
                      <li key={entry.repository_id}>
                        {repositoryLabel(entry)} · <code>{entry.version}</code> ·{" "}
                        {new Date(entry.materialized_at).toLocaleString()}
                        {entry.status === "failed" && (
                          <span className="badge failed"> failed</span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {installation?.failure_reason && (
                  <div className="error">{installation.failure_reason}</div>
                )}
                <div className="inline kit-actions">
                  <button className="primary" disabled={isBusy} onClick={() => void install(kit)}>
                    {isBusy ? "Installing…" : installation ? "Reinstall / update" : "Install in IDE"}
                  </button>
                  {installation && (
                    <button className="ghost" disabled={isBusy} onClick={() => void remove(kit)}>
                      Remove
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

/*
 * What this project could be built from, read off its own documents.
 *
 * The question — "из каких компонентов, которые мы знаем в нашей системе, можно
 * построить этот продукт" — is the Components tab's question, and until now it
 * could only be asked from the other end: open one App Spec, press Compose, get
 * a modal. That reads one document; a project is a stack of them.
 *
 * Two things it deliberately does NOT do. It does not load on mount: the
 * catalogue and its profiles are a few hundred kilobytes, and a tab that opens
 * to install a kit should not pay for them. And it does not hide a candidate
 * that was never built -- it labels it and sorts it last (see compose.ts). A
 * design may legitimately name a component that is still only a design; what
 * would be wrong is answering "build it from these" with a directory of docs.
 */
function SuggestedComponents({
  token,
  projectId,
  workspaceId,
}: {
  token: string;
  projectId: string;
  workspaceId: string;
}) {
  const [plan, setPlan] = useState<PlanRow[] | null>(null);
  const [docCount, setDocCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suggest = async () => {
    setBusy(true);
    setError(null);
    try {
      const [docs, components, profs, vocab] = await Promise.all([
        api.projectDocuments(token, workspaceId, projectId),
        api.listComponents(token),
        api
          .listComponentProfiles(token)
          .catch(() => ({ nodes: [] as CatalogNode[] })),
        api.capabilities(token, workspaceId),
      ]);
      // Every capability the project's documents declare, deduplicated and in
      // the order they were first met. The server indexes these from front
      // matter on every write, so this is a read, not a parse.
      const caps: string[] = [];
      let seen = 0;
      for (const doc of docs.items) {
        if (!doc.capabilities?.length) continue;
        seen += 1;
        for (const cap of doc.capabilities) if (!caps.includes(cap)) caps.push(cap);
      }
      setDocCount(seen);
      setPlan(composePlan(caps, components.nodes ?? [], profilesByName(profs.nodes ?? []), vocab.items ?? []));
    } catch (cause) {
      setError(errText(cause));
    } finally {
      setBusy(false);
    }
  };

  const built = plan?.flatMap((r) => r.candidates).filter((c) => c.built !== "docs-only").length ?? 0;
  const gaps = plan?.filter((r) => r.gap).length ?? 0;
  const unbuilt = plan?.filter((r) => r.unbuilt).length ?? 0;

  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <h2>Suggested from your documents</h2>
          <p className="subtitle">
            The capabilities this project&apos;s documents declare, matched against the component
            catalogue. Components that have been built come first.
          </p>
        </div>
        <button className="ghost" onClick={() => void suggest()} disabled={busy}>
          {busy ? "Matching…" : plan ? "Refresh" : "Suggest"}
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {plan !== null &&
        (plan.length === 0 ? (
          <p className="empty" style={{ fontSize: 13 }}>
            {docCount === 0
              ? "No document in this project declares a capability yet. Fill a spec's questionnaire and the capabilities land in its front matter — this reads them from there."
              : "The documents declare no capabilities to match."}
          </p>
        ) : (
          <>
            <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 12px" }}>
              {plan.length} capabilit{plan.length === 1 ? "y" : "ies"} from {docCount} document
              {docCount === 1 ? "" : "s"} · {built} built candidate{built === 1 ? "" : "s"} ·{" "}
              {unbuilt} with nothing built yet · {gaps} with nothing at all.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {plan.map((row) => (
                <div
                  key={row.capability}
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: "8px 10px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <code style={{ fontSize: 12, fontWeight: 700 }}>{row.capability}</code>
                    {row.gap && (
                      <span style={{ fontSize: 10, fontWeight: 700, opacity: 0.75 }}>
                        NOTHING IN THE CATALOGUE
                      </span>
                    )}
                    {row.unbuilt && (
                      <span style={{ fontSize: 10, fontWeight: 700, opacity: 0.75 }}>
                        NOTHING BUILT YET
                      </span>
                    )}
                  </div>
                  {row.candidates.length > 0 && (
                    <div
                      style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}
                    >
                      {row.candidates.map((c) => (
                        <span
                          key={c.name}
                          title={
                            `matched: ${c.why.join(", ")}` +
                            (c.built === "docs-only"
                              ? " · the catalogue found no crate under this component — docs and a manifest only"
                              : "")
                          }
                          style={{
                            fontSize: 11,
                            border: "1px solid var(--border)",
                            borderRadius: 999,
                            padding: "2px 8px",
                            opacity: c.built === "docs-only" ? 0.6 : 1,
                          }}
                        >
                          <b>{c.name.replace(/^cf-gears-/, "").replace(/^@[^/]+\//, "")}</b>
                          <span style={{ opacity: 0.6, marginLeft: 5 }}>{c.kind}</span>
                          {c.built === "docs-only" && (
                            <span style={{ marginLeft: 5, fontWeight: 700 }}>docs only</span>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        ))}
    </section>
  );
}
