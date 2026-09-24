import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type GearboxStatus,
  type KitInstallation,
  type PlanRow,
  type KitMaterialization,
  type ProductChange,
  type ProductPreview,
  type ProjectProduct,
  type ProjectRepository,
  type StudioKit,
} from "./api";
import { errText } from "./format";
import {
  PRODUCT_PROFILES,
  defaultPicks,
  gearLabel,
  isPickable,
  productIdFrom,
  corpusErrors,
  groupDiagnostics,
} from "./product";
import { usePortalNav, type PortalNav } from "./portal-nav";
import { useStudioBridge } from "./studio-bridge";

export function ProjectKits({
  token,
  projectId,
  projectName,
  workspaceId,
}: {
  token: string;
  projectId: string;
  /** Names the product a picked set of gears is composed into. */
  projectName: string;
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
  const product = useProjectProduct(token, projectId, projectName);

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
      {product.composing && (
        <ProductCard token={token} projectId={projectId} projectName={projectName} product={product} />
      )}
      {product.gearbox && !product.gearbox.enabled && (
        <p className="hint" style={{ fontSize: 12 }}>
          Composing a product from gears needs the Gearbox engine, which is off in this deployment
          {product.gearbox.problem ? ` (${product.gearbox.problem})` : ""}.
        </p>
      )}
      <SuggestedComponents token={token} projectId={projectId} workspaceId={workspaceId} product={product} />

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
 * could only be asked from the other end: open one PRD, press Compose, get
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
  product,
}: {
  token: string;
  projectId: string;
  workspaceId: string;
  product: ProductState;
}) {
  const [plan, setPlan] = useState<PlanRow[] | null>(null);
  const [docCount, setDocCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nav = usePortalNav();

  const suggest = async () => {
    setBusy(true);
    setError(null);
    try {
      // The catalogue and the profiles are read by the server now, which is
      // also where the matching rules live. What still travels from here is the
      // workspace's own capability vocabulary.
      const [declared, vocab] = await Promise.all([
        api.declaredCapabilities(token, projectId),
        api.capabilities(token, workspaceId),
      ]);
      // Every capability the project's documents declare, in the order first
      // met -- Studio's own documents and the repository files bound to a type
      // alike. The server indexes these from front matter, so this is a read.
      const caps = declared.items.map((c) => c.key);
      setDocCount(new Set(declared.items.flatMap((c) => c.sources.map((s) => s.id))).size);
      const next = (await api.composePlan(token, caps, vocab.items ?? [])).items;
      setPlan(next);
      // A product nobody has picked for yet starts from the best built gear
      // per capability. One that has picks keeps them: suggestions are a
      // source of candidates, not the product.
      if (product.composing && product.loaded && product.picks.length === 0) {
        void product.seed(defaultPicks(next));
      }
    } catch (cause) {
      setError(errText(cause));
    } finally {
      setBusy(false);
    }
  };

  const built = plan?.flatMap((r) => r.candidates).filter((c) => c.built !== "docs-only").length ?? 0;
  const gaps = plan?.filter((r) => r.gap).length ?? 0;
  const unbuilt = plan?.filter((r) => r.unbuilt).length ?? 0;
  const composing = product.composing;

  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <h2>Suggested from your documents</h2>
          <p className="subtitle">
            The capabilities this project&apos;s documents declare, matched against the component
            catalogue. Components that have been built come first.
            {composing && " + puts a gear into the product above; its name opens its page in the catalogue."}
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
              ? "No document in this project declares a capability yet. Fill a PRD's questionnaire, or put `capabilities: auth, storage` in the front matter of a PRD in the repository and confirm it on the Specs tab — this reads them from there."
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
                      {row.candidates.map((c) => {
                        const pickable = composing && isPickable(c);
                        const picked = pickable && product.picks.includes(c.name);
                        return (
                          <span
                            key={c.name}
                            title={
                              `matched: ${c.why.join(", ")}` +
                              (c.built === "docs-only"
                                ? " · the catalogue found no crate under this component — docs and a manifest only"
                                : "")
                            }
                            style={{
                              ...chipStyle(picked),
                              opacity: c.built === "docs-only" ? 0.6 : 1,
                            }}
                          >
                            {pickable && (
                              <button
                                type="button"
                                aria-pressed={picked}
                                title={picked ? "In the product — click to take it out" : "Put it into the product"}
                                onClick={() => product.toggle(c.name)}
                                style={chipToggleStyle}
                              >
                                {picked ? "✓" : "+"}
                              </button>
                            )}
                            <ComponentLink nav={nav} name={c.name} />
                            <span style={{ opacity: 0.6, marginLeft: 5 }}>{c.kind}</span>
                            {c.composable === "runs" && (
                              <span title="Described for composition: the Gearbox engine can put it into a product" style={{ marginLeft: 5, fontSize: 9, fontWeight: 700, color: "var(--success, var(--primary))" }}>
                                GDL
                              </span>
                            )}
                            {c.composable === "blocked" && (
                              <span title={`Described, but cannot run from this corpus: ${c.composable_why ?? ""}`} style={{ marginLeft: 5, fontSize: 9, fontWeight: 700, color: "var(--danger, #c33)" }}>
                                BLOCKED
                              </span>
                            )}
                            {c.built === "docs-only" && (
                              <span style={{ marginLeft: 5, fontWeight: 700 }}>docs only</span>
                            )}
                          </span>
                        );
                      })}
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

/* ── The project's product ────────────────────────────────────────────────── */

type ProductState = {
  /** The engine's status; null while loading or when the call failed. */
  gearbox: GearboxStatus | null;
  /** Whether previews run here at all. */
  composing: boolean;
  /** The saved record has been read, so picks can be written back. */
  loaded: boolean;
  record: ProjectProduct | null;
  picks: string[];
  setPicks: (update: (current: string[]) => string[]) => void;
  toggle: (name: string) => void;
  profile: string;
  setProfile: (profile: string) => void;
  /** Re-read the record, after a preview wrote its verdict into it. */
  refresh: () => Promise<void>;
  /** What completion last changed, with its reasons; empty when nothing did. */
  adjustments: ProductChange[];
  /** Bumped whenever completion replaces the picks, so a preview can follow. */
  completedAt: number;
  /** Start the product from these picks, completed into a set that resolves. */
  seed: (picks: string[]) => Promise<void>;
  /** Complete the current picks. */
  complete: () => Promise<void>;
  saveError: string | null;
};

/** The project's product as the server keeps it: read on mount, and written
 *  back as picks and profile change, so leaving the tab keeps what was chosen
 *  and every screen that asks sees the same product. */
function useProjectProduct(token: string, projectId: string, projectName: string): ProductState {
  const [gearbox, setGearbox] = useState<GearboxStatus | null>(null);
  const [record, setRecord] = useState<ProjectProduct | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [picks, setPicksState] = useState<string[]>([]);
  const [profile, setProfileState] = useState("dev");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [adjustments, setAdjustments] = useState<ProductChange[]>([]);
  const [completedAt, setCompletedAt] = useState(0);
  // Set by the person's changes and cleared by a write, so what was just
  // read from the server is never written straight back.
  const dirty = useRef(false);

  useEffect(() => {
    let live = true;
    setLoaded(false);
    void Promise.all([
      api.gearboxStatus(token).catch(() => null),
      api.projectProduct(token, projectId).catch(() => null),
    ]).then(([engine, saved]) => {
      if (!live) return;
      setGearbox(engine);
      setRecord(saved);
      setPicksState(saved?.gears ?? []);
      setProfileState(saved?.profile ?? "dev");
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [token, projectId]);

  useEffect(() => {
    if (!loaded || !dirty.current) return;
    const timer = setTimeout(() => {
      dirty.current = false;
      api
        .saveProjectProduct(token, projectId, {
          product_id: productIdFrom(projectName),
          name: projectName,
          gears: picks,
          profile,
        })
        .then((saved) => {
          setRecord(saved.value);
          setSaveError(null);
        })
        .catch((cause) => setSaveError(errText(cause)));
    }, 400);
    return () => clearTimeout(timer);
  }, [picks, profile, loaded, token, projectId, projectName]);

  const setPicks = useCallback((update: (current: string[]) => string[]) => {
    dirty.current = true;
    setPicksState(update);
  }, []);

  // Completion is advice the person can undo: it replaces the picks, keeps
  // its reasons on screen, and if the engine is unreachable the picks stand.
  const completeInto = async (start: string[]) => {
    try {
      const done = await api.completeProduct(token, start);
      setAdjustments(done.changes);
      setPicks(() => done.gears);
      setCompletedAt(Date.now());
    } catch (cause) {
      setSaveError(errText(cause));
      setPicks(() => start);
    }
  };

  return {
    gearbox,
    composing: gearbox?.enabled === true,
    loaded,
    record,
    picks,
    setPicks,
    toggle: (name) =>
      setPicks((current) => (current.includes(name) ? current.filter((n) => n !== name) : [...current, name])),
    profile,
    setProfile: (next) => {
      dirty.current = true;
      setProfileState(next);
    },
    refresh: async () => {
      const saved = await api.projectProduct(token, projectId).catch(() => null);
      if (saved) setRecord(saved);
    },
    saveError,
    adjustments,
    completedAt,
    seed: (start) => completeInto(start),
    complete: () => completeInto(picks),
  };
}

const chipStyle = (picked: boolean) =>
  ({
    fontSize: 11,
    display: "inline-flex",
    alignItems: "center",
    border: picked ? "1px solid var(--primary)" : "1px solid var(--border)",
    background: picked ? "var(--accent)" : "transparent",
    borderRadius: 999,
    padding: "2px 8px",
  }) as const;

const chipToggleStyle = {
  border: "none",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  padding: "0 4px 0 0",
  font: "inherit",
  fontWeight: 700,
} as const;

/** A component's name that opens its page in the platform catalogue. */
function ComponentLink({ nav, name, label }: { nav: PortalNav | null; name: string; label?: string }) {
  const text = label ?? gearLabel(name);
  if (!nav) return <b>{text}</b>;
  return (
    <button
      type="button"
      className="link"
      title={`Open ${name} in the component catalogue`}
      onClick={() => nav.openComponent(name)}
      style={{ border: "none", background: "transparent", padding: 0, font: "inherit", fontWeight: 700, color: "var(--primary)", cursor: "pointer" }}
    >
      {text}
    </button>
  );
}

/** The product this project is made of: the gears in it, each leading to its
 *  catalogue page; the engine's verdict on them; and the two ways onward — into
 *  the project's repository, and into the IDE where the language server keeps
 *  checking it. */
function ProductCard({
  token,
  projectId,
  projectName,
  product,
}: {
  token: string;
  projectId: string;
  projectName: string;
  product: ProductState;
}) {
  const studio = useStudioBridge();
  const nav = usePortalNav();
  const { gearbox, picks, profile, record } = product;
  const [asPr, setAsPr] = useState(false);
  const [busy, setBusy] = useState<"preview" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ProductPreview | null>(null);
  // A product project owns the repository its wizard created, so saving goes
  // onto the base branch the IDE opens. Any other project's gear repo may be
  // shared, and gets a `product/…` branch instead.
  const [ownsRepo, setOwnsRepo] = useState(false);
  useEffect(() => {
    api
      .projectConfig(token, projectId)
      .then((c) => setOwnsRepo(c?.kind === "product"))
      .catch(() => setOwnsRepo(false));
  }, [token, projectId]);
  // The picks and profile the shown preview answers. Anything else and the
  // preview is about a different product, which the screen has to say.
  const [asked, setAsked] = useState<string | null>(null);
  const question = JSON.stringify([profile, [...picks].sort()]);
  const stale = preview !== null && asked !== question;
  const productId = productIdFrom(projectName);
  // The crate behind an engine id, for linking a resolved gear to its page.
  const crateOf = (id: string) => preview?.gears.find((g) => g.id === id)?.crate_name ?? `cf-gears-${id}`;

  const run = async (write: boolean) => {
    setBusy(write ? "save" : "preview");
    setError(null);
    try {
      const result = await api.previewProduct(token, projectId, {
        product_id: productId,
        name: projectName,
        gears: picks,
        profile,
        ...(write ? { write: true, open_pr: asPr, onto_base: ownsRepo } : {}),
      });
      setPreview(result);
      setAsked(question);
      await product.refresh();
    } catch (cause) {
      setError(errText(cause));
    } finally {
      setBusy(null);
    }
  };

  // Completion replaced the picks: show at once what the engine makes of them.
  useEffect(() => {
    if (product.completedAt > 0 && picks.length > 0) void run(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.completedAt]);

  const errors = preview?.diagnostics.filter((d) => d.severity === "error").length ?? 0;
  const warnings = preview?.diagnostics.filter((d) => d.severity === "warning").length ?? 0;
  const last = record?.last_preview;

  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <h2>
            Product <code style={{ fontSize: 13, fontWeight: 500 }}>{productId}</code>
          </h2>
          <p className="subtitle">
            The gears this project ships as one product, composed and checked by the Gearbox engine.
            Saved with the project; a gear&apos;s name opens its page in the component catalogue.
          </p>
        </div>
        <span className="hint" style={{ fontSize: 11 }}>
          {gearbox?.engine_version ?? "gearbox"} · {gearbox?.corpus_ref}
          {gearbox?.corpus_commit ? `@${gearbox.corpus_commit.slice(0, 7)}` : ""}
        </span>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        {picks.length === 0 ? (
          <span className="empty" style={{ fontSize: 12 }}>
            Nothing in the product yet — press Suggest below and pick gears with +.
          </span>
        ) : (
          picks.map((name) => (
            <span key={name} style={chipStyle(true)}>
              <ComponentLink nav={nav} name={name} />
              <button
                type="button"
                title="Take it out of the product"
                aria-label={`Remove ${name}`}
                onClick={() => product.toggle(name)}
                style={{ ...chipToggleStyle, padding: "0 0 0 6px", opacity: 0.6 }}
              >
                ×
              </button>
            </span>
          ))
        )}
      </div>
      {product.adjustments.length > 0 && (
        <div style={{ fontSize: 12, marginTop: 8 }}>
          <div style={{ opacity: 0.7 }}>Adjusted so the product can resolve — each can be undone:</div>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {product.adjustments.map((c) => (
              <li key={`${c.gear}-${c.added}`}>
                <b>{c.added ? "+" : "−"}</b> <ComponentLink nav={nav} name={c.gear} />
                <span style={{ opacity: 0.75 }}> — {c.reason}</span>
                {!c.added && !picks.includes(c.gear) && (
                  <button
                    type="button"
                    className="link"
                    onClick={() => product.setPicks((current) => [...current, c.gear])}
                    style={{ border: "none", background: "transparent", color: "var(--primary)", cursor: "pointer", fontSize: 12 }}
                  >
                    put back
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {product.saveError && <div className="error">Not saved: {product.saveError}</div>}

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
        <select value={profile} onChange={(e) => product.setProfile(e.target.value)} aria-label="Deployment profile">
          {PRODUCT_PROFILES.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <button className="primary" disabled={busy !== null || picks.length === 0} onClick={() => void run(false)}>
          {busy === "preview" ? "Resolving…" : "Preview product"}
        </button>
        <button
          className="ghost"
          disabled={busy !== null || picks.length === 0}
          title="Take out what the catalogue shows cannot run, add the plugins and hosts that are missing, then preview"
          onClick={() => void product.complete()}
        >
          Make it resolve
        </button>
        {!preview && last && (
          <span style={{ fontSize: 12 }}>
            <span className={`badge ${last.ok ? "ok" : "failed"}`}>
              {last.ok ? `resolved for ${last.profile}` : `did not resolve for ${last.profile}`}
            </span>{" "}
            <span style={{ opacity: 0.7 }}>
              {last.errors} error{last.errors === 1 ? "" : "s"} · {last.warnings} warning
              {last.warnings === 1 ? "" : "s"}
              {last.applications.length > 0 ? ` · ${last.applications.join(", ")}` : ""}
              {record?.updated_at ? ` · ${new Date(record.updated_at).toLocaleString()}` : ""}
            </span>
          </span>
        )}
      </div>
      {error && <div className="error">{error}</div>}

      {preview && (
        <div style={{ marginTop: 10, opacity: stale ? 0.55 : 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className={`badge ${preview.ok ? "ok" : "failed"}`}>
              {preview.ok ? `resolves for ${preview.profile}` : `does not resolve for ${preview.profile}`}
            </span>
            <span style={{ fontSize: 12, opacity: 0.75 }}>
              {errors} error{errors === 1 ? "" : "s"} · {warnings} warning{warnings === 1 ? "" : "s"}
            </span>
            {stale && <span className="badge warn">the product changed since — preview again</span>}
          </div>

          {(() => {
            const c = corpusErrors(preview.diagnostics);
            if (c.errors === 0) return null;
            return (
              <p className="error" style={{ fontSize: 12 }} data-corpus-errors>
                {c.errors === errors ? "Every error here is" : `${c.errors} of these errors are`} in the gear
                corpus&apos;s own descriptions ({c.files} <code>gear.gdl</code> file{c.files === 1 ? "" : "s"} in{" "}
                <code>{gearbox?.corpus_ref ?? "the corpus"}</code>), not in this product. The Gearbox engine (
                {gearbox?.engine_version ?? "its version"}) cannot read them, so the engine and the corpus disagree
                — nothing picked here can fix that; the deployment has to move the engine or pin the corpus.
              </p>
            );
          })()}

          {preview.not_described.length > 0 && (
            <p className="hint" style={{ fontSize: 12 }}>
              Left out, because no <code>gear.gdl</code> describes{" "}
              {preview.not_described.length === 1 ? "it" : "them"} yet:{" "}
              {preview.not_described.map((n, i) => (
                <span key={n}>
                  {i > 0 && ", "}
                  <ComponentLink nav={nav} name={n} />
                </span>
              ))}
              .
            </p>
          )}
          {preview.added.length > 0 && (
            <p className="hint" style={{ fontSize: 12 }}>
              Added: {preview.added.map((a) => `${a.id} (${a.reason})`).join(", ")}.
            </p>
          )}

          {preview.plugin_options.length > 0 && (
            <div style={{ fontSize: 12, margin: "8px 0" }}>
              {preview.plugin_options.map((o) => (
                <div key={o.host} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", margin: "0 0 4px" }}>
                  <span>
                    <b>{o.host}</b> needs a plugin:
                  </span>
                  {o.available.map((name) => (
                    <span key={name} style={chipStyle(picks.includes(name))}>
                      <button
                        type="button"
                        disabled={picks.includes(name)}
                        title="Put this plugin into the product, then preview again"
                        onClick={() => product.setPicks((current) => (current.includes(name) ? current : [...current, name]))}
                        style={chipToggleStyle}
                      >
                        {picks.includes(name) ? "✓" : "+"}
                      </button>
                      <ComponentLink nav={nav} name={name} />
                    </span>
                  ))}
                </div>
              ))}
            </div>
          )}

          {preview.diagnostics.length > 0 && (
            <ul style={{ listStyle: "none", padding: 0, margin: "8px 0", fontSize: 12 }}>
              {groupDiagnostics(preview.diagnostics).map((d, i) => (
                <li key={`${d.code}-${i}`} style={{ margin: "0 0 6px" }}>
                  <span className={`badge ${d.severity === "error" ? "danger" : d.severity === "warning" ? "warn" : "info"}`}>
                    {d.code}
                  </span>{" "}
                  {d.message}
                  {d.profiles.length > 0 && <span style={{ opacity: 0.6 }}> · {d.profiles.join(", ")}</span>}
                  {d.file && (
                    <span style={{ opacity: 0.6 }}>
                      {" "}
                      — {d.file}
                      {d.line ? `:${d.line}` : ""}
                    </span>
                  )}
                  {d.help && <div style={{ opacity: 0.7, marginLeft: 8 }}>{d.help}</div>}
                </li>
              ))}
            </ul>
          )}

          {preview.applications.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, margin: "8px 0" }}>
              {preview.applications.map((a) => (
                <div
                  key={a.name}
                  style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "6px 10px", fontSize: 12 }}
                >
                  <b>{a.name}</b>
                  <span style={{ opacity: 0.6 }}>
                    {" "}
                    · {a.kind}
                    {a.replicas > 1 ? ` · ×${a.replicas}` : ""}
                    {a.listens.length > 0 ? ` · ${a.listens.map((l) => `${l.name} ${l.address}`).join(", ")}` : ""}
                  </span>
                  <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {a.gears.map((g) => {
                      const why = preview.gears.find((x) => x.id === g)?.reasons ?? [];
                      const pulled = why.length > 0 && !why.includes("selected");
                      return (
                        <span key={g} title={why.join("; ")} style={{ opacity: pulled ? 0.7 : 1 }}>
                          <ComponentLink nav={nav} name={crateOf(g)} label={g} />
                          {pulled && <span style={{ fontSize: 10 }}> ({why[0]})</span>}
                        </span>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          <details style={{ margin: "8px 0" }}>
            <summary style={{ fontSize: 12, cursor: "pointer" }}>product.gdl</summary>
            <pre style={{ fontSize: 11, maxHeight: 320, overflow: "auto" }}>{preview.product_gdl}</pre>
          </details>
        </div>
      )}

      {(preview || record?.written) && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
          {preview && (
            <>
              <button className="ghost" disabled={busy !== null || stale} onClick={() => void run(true)}>
                {busy === "save" ? "Saving…" : "Save product.gdl to the repository"}
              </button>
              <label style={{ fontSize: 12 }}>
                <input type="checkbox" checked={asPr} onChange={(e) => setAsPr(e.target.checked)} /> as a pull
                request
              </label>
            </>
          )}
          {studio && record?.written && (
            <button
              className="ghost"
              disabled={studio.opening !== null}
              title="Opens this project's IDE in the Gearbox perspective with the product open: resolution, graph, lock and conflicts, and the GDL language checking the file as you edit"
              onClick={() =>
                void studio.openProduct({ id: projectId, name: projectName }, "product.gdl", record.written?.branch)
              }
            >
              Open in IDE
            </button>
          )}
        </div>
      )}
      {record?.written && (
        <p className="hint" style={{ fontSize: 12 }}>
          {record.written.pr_url ? (
            <>
              product.gdl is in a pull request:{" "}
              <a href={record.written.pr_url} target="_blank" rel="noreferrer">
                {record.written.pr_url}
              </a>
            </>
          ) : (
            <>
              product.gdl is committed on <code>{record.written.branch}</code> as{" "}
              <code>{record.written.commit_sha.slice(0, 7)}</code>.
            </>
          )}{" "}
          {ownsRepo
            ? "The IDE opens the repository's sources from the Sources tab; if the project repository is not there yet, add it there first."
            : "This project's gear repository may be shared, so the description went onto its own branch; the IDE shows it once that branch is merged or checked out."}
        </p>
      )}
    </section>
  );
}
