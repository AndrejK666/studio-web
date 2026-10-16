/* The Sources pages (ADR-0046): where a tier's gears come from.
 *
 * Platform › Sources lists the platform's gear repositories. Each is a
 * connection of the `gear-repository` kind in the root tenant -- one
 * repository at one ref, read with its own token or none -- and the Gearbox
 * engine reads them all together, in the order they were added, as the
 * corpus every organization's catalogue, previews and products draw on. Every
 * organization sees the list; a platform administrator changes it. While it
 * is empty, the engine reads the deployment's corpus, and the page says so.
 *
 * Organization › Sources (phase 3) shows the platform's list read-only, then
 * the organization's own gear repositories, which its corpus reads after the
 * platform's. One of them is where "Create a gear" writes. */

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { PLATFORM_ROOT_TENANT_ID, api, type CatalogRepoSource, type Connection, type GearboxStatus } from "./api";
import { type RepositoryRoles, refLabel, repositoryRoles, rolesNote } from "./component-repositories";
import { errText } from "./format";
import {
  GEAR_REPOSITORY,
  type GearRepositoryRow,
  createTargetOf,
  defaultSourceId,
  deploymentCorpus,
  gearRepositoryRows,
  gearRepositoryRowsFromStatus,
  isSourceId,
  readLine,
  repositoryOf,
} from "./gear-repositories";

export function PlatformSources({
  token,
  isPlatformAdmin,
  catalogueSettings,
}: {
  token: string;
  isPlatformAdmin: boolean;
  catalogueSettings?: ReactNode;
}) {
  return (
    <GearSources
      token={token}
      tier="platform"
      tenantId={PLATFORM_ROOT_TENANT_ID}
      mayManage={isPlatformAdmin}
      catalogueSettings={isPlatformAdmin ? catalogueSettings : undefined}
    />
  );
}

/** Organization › Components › Repositories: who may change the list is who
 *  may manage the organization's registry (`component.registry`). `embedded`
 *  drops the page heading, which the Components page already has. */
export function OrgSources({
  token,
  orgId,
  embedded = false,
  catalogueSettings,
}: {
  token: string;
  orgId?: string;
  embedded?: boolean;
  catalogueSettings?: ReactNode;
}) {
  const [mayManage, setMayManage] = useState(false);
  useEffect(() => {
    api
      .orgGearRepository(token)
      .then((r) => setMayManage(r.may_manage))
      .catch(() => setMayManage(false));
  }, [token]);
  if (!orgId) return <p className="hint">Open an organization to see its sources.</p>;
  return (
    <GearSources
      token={token}
      tier="organization"
      tenantId={orgId}
      mayManage={mayManage}
      embedded={embedded}
      catalogueSettings={catalogueSettings}
    />
  );
}

function GearSources({
  token,
  tier,
  tenantId,
  mayManage,
  embedded = false,
  catalogueSettings,
}: {
  token: string;
  tier: "platform" | "organization";
  tenantId: string;
  mayManage: boolean;
  embedded?: boolean;
  /** The catalogue's own settings and sync, drawn under the list. */
  catalogueSettings?: ReactNode;
}) {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  // The other role of the same repositories: what the catalogue syncs. The
  // platform's list is a platform administrator's to read; an organization's,
  // its members'.
  const [catalogue, setCatalogue] = useState<CatalogRepoSource[] | null>(null);
  const [cratesIo, setCratesIo] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<{ url: string; ref: string; at: number } | null>(null);
  const addRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<GearboxStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [statusRead, setStatusRead] = useState(false);

  const org = tier === "organization";
  // The platform's connections are read by a platform administrator only;
  // every other member sees its list as the engine read it. An
  // organization's own are read by its members.
  const readsConnections = org || mayManage;

  const load = useCallback(
    (refresh = false) => {
      if (readsConnections)
        api
          .connections(token, tenantId)
          .then((r) => setConnections(r.items))
          .catch((e) => {
            setConnections([]);
            setError(errText(e));
          });
      // The engine may be fetching its repositories as it answers: say so
      // rather than "not read yet" while it does.
      setStatusRead(false);
      api
        .gearboxStatus(token, refresh, org ? tenantId : undefined)
        .then(setStatus)
        .catch(() => setStatus(null))
        .finally(() => setStatusRead(true));
      if (org)
        api
          .catalogSources(token)
          .then((r) => setCatalogue(r.items ?? []))
          .catch(() => setCatalogue(null));
      else if (mayManage)
        api
          .platformSources(token)
          .then((r) => {
            setCatalogue(r.items ?? []);
            setCratesIo(r.crates_io ?? null);
          })
          .catch(() => setCatalogue(null));
    },
    [token, tenantId, org, readsConnections, mayManage],
  );
  useEffect(() => load(), [load]);

  const own: GearRepositoryRow[] = readsConnections
    ? gearRepositoryRows(connections ?? [], tenantId, status)
    : gearRepositoryRowsFromStatus(status, "platform");
  const platformRows = org ? gearRepositoryRowsFromStatus(status, "platform") : [];
  const loading = readsConnections ? connections === null : !statusRead;
  const fallback = !org && own.length === 0 ? deploymentCorpus(status) : null;
  const target = org ? createTargetOf(own) : null;

  const act = async (c: Connection, what: () => Promise<void>) => {
    setBusy(c.id);
    setError(null);
    setNote(null);
    try {
      await what();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };
  const test = (c: Connection) =>
    act(c, async () => {
      const r = await api.testConnection(token, c.id, tenantId);
      setNote(`${r.account}: ${r.display_name ?? "reachable"}`);
    });
  const remove = (c: Connection) => {
    const whose = org ? "the organization's" : "the platform's";
    if (!window.confirm(`Stop reading ${repositoryOf(c.base_url) ?? c.label}? Its gears leave ${whose} corpus.`)) return;
    void act(c, async () => {
      await api.deleteConnection(token, c.id, tenantId);
      load(true);
    });
  };
  const markTarget = (c: Connection) =>
    act(c, async () => {
      await api.patchConnection(token, c.id, { options: { ...(c.options ?? {}), create_target: "true" } }, tenantId);
      setNote(`New gears go into ${repositoryOf(c.base_url) ?? c.label}.`);
      load(false);
    });

  const roles = repositoryRoles(own, catalogue ?? [], fallback);
  const saveCatalogue = async (items: CatalogRepoSource[], line: string) => {
    setError(null);
    setNote(null);
    try {
      const saved = org
        ? await api.saveCatalogSources(token, items)
        : await api.savePlatformSources(token, items, cratesIo);
      setCatalogue(saved.items);
      setNote(`${line} The catalogue picks it up at its next sync.`);
    } catch (e) {
      setError(errText(e));
    }
  };
  const listIt = (r: RepositoryRoles) =>
    void saveCatalogue(
      [
        ...(catalogue ?? []),
        { tenant: tenantId, connection_id: null, repo: r.repo, git_ref: r.engine?.ref || null, mode: "gears" },
      ],
      `${r.repo} is listed in the catalogue.`,
    );
  const unlist = (c: CatalogRepoSource) => {
    if (!window.confirm(`Stop listing ${c.repo} (${c.mode || "gears"}) in the catalogue? Products built from it are not affected.`)) return;
    void saveCatalogue(
      (catalogue ?? []).filter((x) => x !== c),
      `${c.repo} (${c.mode || "gears"}) is no longer listed.`,
    );
  };
  const buildFrom = (r: RepositoryRoles) => {
    const gears = r.catalogue.find((c) => (c.mode || "gears") === "gears") ?? r.catalogue[0];
    const ref = gears?.git_ref && gears.git_ref !== "HEAD" ? gears.git_ref : "";
    setPrefill({ url: `https://github.com/${r.repo}`, ref, at: Date.now() });
    addRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  return (
    <div className="gear-sources" data-platform-sources={org ? undefined : ""} data-org-sources={org ? "" : undefined}>
      <style>{SOURCES_CSS}</style>
      {!embedded && <h1>Repositories</h1>}
      <p className="subtitle">
        {org
          ? "Where this organization's components come from. A repository can be in the catalogue (synced into the Components list) and built from (the Gearbox engine reads it, after the platform's, when it composes a product); one of those is where Create a gear writes."
          : "Where the platform's components come from. A repository can be in the catalogue (synced into the Components list every organization sees) and built from (the Gearbox engine reads it when it composes a product; where two declare the same gear, the first wins)."}
      </p>
      {error && <div className="error">{error}</div>}
      {note && (
        <div className="hint" data-gear-source-note>
          {note}
        </div>
      )}
      {status?.problem && (
        <div className="error" data-gear-source-problem>
          The engine could not read the corpus: {status.problem}
        </div>
      )}
      {org && (status?.shadowed ?? []).length > 0 && (
        <div className="error" data-gear-source-shadowed>
          Not read: {(status?.shadowed ?? []).join(", ")}. A platform repository has the same source id; give this
          organization&apos;s repository another.
        </div>
      )}
      {org && (
        <section data-platform-rows>
          <h3>The platform&apos;s</h3>
          {!statusRead ? (
            <p className="hint">Asking the engine what it reads…</p>
          ) : platformRows.length === 0 ? (
            <p className="hint">
              {deploymentCorpus(status)
                ? `The deployment's corpus: ${deploymentCorpus(status)?.repo} (${readLine(deploymentCorpus(status))}).`
                : "The platform has no gear repository."}
            </p>
          ) : (
            <SourceTable rows={platformRows} statusRead={statusRead} />
          )}
          <h3>This organization&apos;s</h3>
        </section>
      )}
      {loading ? (
        <p className="hint">{readsConnections ? "Loading…" : "Asking the engine what it reads…"}</p>
      ) : roles.length > 0 && (catalogue !== null || own.length > 0) ? (
        <RolesTable
          rows={roles}
          statusRead={statusRead}
          busy={busy}
          mayManage={mayManage}
          catalogueRead={catalogue !== null}
          onTest={test}
          onRemove={mayManage ? remove : undefined}
          onList={listIt}
          onUnlist={unlist}
          onBuild={buildFrom}
          target={org ? target : undefined}
          onTarget={org && mayManage ? markTarget : undefined}
        />
      ) : own.length === 0 ? (
        <p className="hint" data-gear-sources-empty>
          {org
            ? "None yet. Products here read the platform's gears; a repository added here adds this organization's own."
            : fallback
              ? `No gear repository is connected, so the engine reads the deployment's corpus: ${fallback.repo}${
                  fallback.git_ref ? `@${fallback.git_ref}` : ""
                } (${readLine(fallback)}). Adding one replaces it.`
              : "No gear repository is connected, and the deployment names no corpus: the engine has nothing to read."}
        </p>
      ) : (
        <SourceTable
          rows={own}
          statusRead={statusRead}
          busy={busy}
          onTest={test}
          onRemove={mayManage ? remove : undefined}
          target={target}
          onTarget={org && mayManage ? markTarget : undefined}
        />
      )}
      {catalogueSettings && (
        <details className="gear-source-catalogue" data-catalogue-settings>
          <summary>Catalogue settings and sync — modes, refs, connections{org ? "" : ", crates.io"}</summary>
          {catalogueSettings}
        </details>
      )}
      {mayManage ? (
        <div ref={addRef}>
          <AddGearRepository
            key={prefill?.at ?? 0}
            token={token}
            ownerTenant={tenantId}
            taken={own.map((r) => r.sourceId)}
            platformIds={platformRows.map((r) => r.sourceId)}
            initialUrl={prefill?.url}
            initialRef={prefill?.ref}
            onAdded={(line) => {
              setNote(line);
              setPrefill(null);
              load(true);
            }}
          />
        </div>
      ) : (
        <p className="hint">
          {org
            ? "An organization administrator adds and removes the organization's gear repositories."
            : "A platform administrator adds and removes the platform's gear repositories."}
        </p>
      )}
    </div>
  );
}

/** One row per repository, with its two roles side by side. */
function RolesTable({
  rows,
  statusRead,
  busy,
  mayManage,
  catalogueRead,
  onTest,
  onRemove,
  onList,
  onUnlist,
  onBuild,
  target,
  onTarget,
}: {
  rows: RepositoryRoles[];
  statusRead: boolean;
  busy: string | null;
  mayManage: boolean;
  /** Whether the catalogue's list could be read: a member who may not read
   *  the platform's sees only what the engine reads. */
  catalogueRead: boolean;
  onTest: (c: Connection) => void;
  onRemove?: (c: Connection) => void;
  onList: (r: RepositoryRoles) => void;
  onUnlist: (c: CatalogRepoSource) => void;
  onBuild: (r: RepositoryRoles) => void;
  target?: string | null;
  onTarget?: (c: Connection) => void;
}) {
  const org = target !== undefined;
  return (
    <table className="data-table" data-repository-roles>
      <thead>
        <tr>
          <th>Repository</th>
          <th title="Synced into the Components list: descriptions, versions, activity">In the catalogue</th>
          <th title="Read by the Gearbox engine when it composes a product">Built from</th>
          {org && <th>New gears</th>}
          <th aria-label="Actions" />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const c = r.engine?.connection ?? null;
          const note = catalogueRead ? rolesNote(r) : null;
          return (
            <tr key={r.repo} data-repository={r.repo}>
              <td>
                <a href={`https://github.com/${r.repo}`} target="_blank" rel="noreferrer">
                  {r.repo}
                </a>
                {note && (
                  <div className="gear-source-warn" data-roles-note>
                    {note}
                  </div>
                )}
              </td>
              <td data-role-catalogue>
                {!catalogueRead ? (
                  <span className="sub">—</span>
                ) : r.catalogue.length === 0 ? (
                  mayManage ? (
                    <button type="button" className="ghost" onClick={() => onList(r)}>
                      List it
                    </button>
                  ) : (
                    <span className="sub">not listed</span>
                  )
                ) : (
                  r.catalogue.map((s, i) => (
                    <span key={i} className="gear-role-chip">
                      {s.mode || "gears"} · {refLabel(s.git_ref)}
                      {s.shadowed_by_platform && <span className="sub"> · the platform lists it too</span>}
                      {mayManage && (
                        <button type="button" className="ghost" title="Stop listing it" onClick={() => onUnlist(s)}>
                          ×
                        </button>
                      )}
                    </span>
                  ))
                )}
              </td>
              <td data-role-engine>
                {r.engine ? (
                  <>
                    <code>{r.engine.sourceId}</code> <span className="sub">· {refLabel(r.engine.ref)}</span>
                    <div className="sub">
                      {statusRead ? readLine(r.engine.read) : "reading…"}
                      {r.fallback && " · the deployment's corpus, until a repository is added"}
                      {c && (c.secret_ref ? " · with a token" : " · public")}
                    </div>
                  </>
                ) : mayManage ? (
                  <button type="button" className="ghost" onClick={() => onBuild(r)}>
                    Build from it…
                  </button>
                ) : (
                  <span className="sub">not built from</span>
                )}
              </td>
              {org && (
                <td data-gear-source-target>
                  {c && target === c.id ? (
                    <span className="badge">Create a gear writes here</span>
                  ) : c && onTarget ? (
                    <button type="button" disabled={busy === c.id} onClick={() => onTarget(c)}>
                      Write new gears here
                    </button>
                  ) : null}
                </td>
              )}
              <td className="gear-source-actions">
                {c && (
                  <button type="button" disabled={busy === c.id} onClick={() => onTest(c)}>
                    Test
                  </button>
                )}
                {c && onRemove && (
                  <button type="button" disabled={busy === c.id} onClick={() => onRemove(c)} title="Stop building from it">
                    Remove
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SourceTable({
  rows,
  statusRead,
  busy,
  onTest,
  onRemove,
  target,
  onTarget,
}: {
  rows: GearRepositoryRow[];
  statusRead: boolean;
  busy?: string | null;
  onTest?: (c: Connection) => void;
  onRemove?: (c: Connection) => void;
  /** The repository Create a gear writes into, when this is an
   *  organization's list. */
  target?: string | null;
  onTarget?: (c: Connection) => void;
}) {
  const org = target !== undefined;
  return (
    <table className="data-table" data-gear-sources>
      <thead>
        <tr>
          <th>#</th>
          <th>Source</th>
          <th>Repository</th>
          <th>Read</th>
          {org && <th>New gears</th>}
          <th aria-label="Actions" />
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const c = r.connection;
          return (
            <tr key={c?.id ?? r.sourceId} data-gear-source={r.sourceId}>
              <td>{i + 1}</td>
              <td>
                <code>{r.sourceId}</code>
              </td>
              <td>
                <a href={`https://github.com/${r.repo}`} target="_blank" rel="noreferrer">
                  {r.repo}
                </a>
                <span className="sub">
                  {r.ref ? ` @ ${r.ref}` : " @ default branch"}
                  {c && (c.secret_ref ? " · with a token" : " · public")}
                </span>
              </td>
              <td>{statusRead ? readLine(r.read) : "reading…"}</td>
              {org && (
                <td data-gear-source-target>
                  {c && target === c.id ? (
                    <span className="badge">Create a gear writes here</span>
                  ) : c && onTarget ? (
                    <button type="button" disabled={busy === c.id} onClick={() => onTarget(c)}>
                      Write new gears here
                    </button>
                  ) : null}
                </td>
              )}
              <td className="gear-source-actions">
                {c && onTest && (
                  <button type="button" disabled={busy === c.id} onClick={() => onTest(c)}>
                    Test
                  </button>
                )}
                {c && onRemove && (
                  <button type="button" disabled={busy === c.id} onClick={() => onRemove(c)}>
                    Remove
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function AddGearRepository({
  token,
  ownerTenant,
  taken,
  platformIds,
  initialUrl,
  initialRef,
  onAdded,
}: {
  token: string;
  ownerTenant: string;
  taken: string[];
  /** On an organization's page: the platform's source ids, which its own
   *  repositories cannot share (the engine names a root by it). */
  platformIds: string[];
  /** Filled in from a catalogue row's "Build from it". */
  initialUrl?: string;
  initialRef?: string;
  onAdded: (line: string) => void;
}) {
  const [url, setUrl] = useState(initialUrl ?? "");
  const [ref, setRef] = useState(initialRef ?? "");
  const [sourceId, setSourceId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const repo = repositoryOf(url);
  const id = sourceId.trim() || defaultSourceId(url);
  const problem = !url.trim()
    ? null
    : !repo
      ? "Give the repository as https://github.com/<owner>/<repo>."
      : !isSourceId(id)
        ? `"${id}" is not a source id: lowercase letters, digits and single hyphens, starting with a letter.`
        : taken.includes(id)
          ? `The source id "${id}" is taken; give this repository another.`
          : platformIds.includes(id)
            ? `The platform has a repository with the source id "${id}"; give this one another.`
            : null;

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.createConnection(token, {
        provider: GEAR_REPOSITORY,
        label: id,
        base_url: url.trim(),
        token: secret.trim(),
        scope: "organization",
        owner_tenant_id: ownerTenant,
        options: { source_id: id, ...(ref.trim() ? { ref: ref.trim() } : {}) },
      });
      setUrl("");
      setRef("");
      setSourceId("");
      setSecret("");
      onAdded(`Added ${r.account}: ${r.display_name ?? "reachable"}.`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card gear-source-add" data-gear-source-add>
      <h3>Add a gear repository</h3>
      <div className="gear-source-form">
        <label>
          Repository
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/constructorfabric/gears-rust"
          />
        </label>
        <label>
          Branch or tag
          <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="default branch" />
        </label>
        <label>
          Source id
          <input
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
            placeholder={defaultSourceId(url) || "gears-rust"}
          />
        </label>
        <label>
          Read token
          <input
            type="password"
            autoComplete="off"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="blank for a public repository"
          />
        </label>
      </div>
      {(problem || error) && <div className="error">{problem ?? error}</div>}
      <button type="button" className="primary" disabled={busy || !repo || !!problem} onClick={() => void add()}>
        {busy ? "Testing…" : "Test & add"}
      </button>
      <p className="hint">
        Studio checks that the repository is there at that ref, and counts its <code>gear.gdl</code> files, before it adds
        it. Create a gear and Publish need a token that may write.
      </p>
    </section>
  );
}

const SOURCES_CSS = `
.gear-sources .sub { color:var(--muted-foreground); font-size:12px; }
.gear-sources .gear-source-actions { display:flex; gap:6px; justify-content:flex-end; }
.gear-sources .gear-source-add { margin-top:16px; display:grid; gap:10px; }
.gear-sources .gear-source-form { display:grid; gap:10px; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); }
.gear-sources .gear-source-form label { display:grid; gap:4px; font-size:13px; }
.gear-sources h3 { margin:16px 0 8px; }
.gear-sources .gear-role-chip { display:inline-flex; gap:4px; align-items:center; margin:0 6px 4px 0; padding:1px 6px; border:1px solid var(--border); border-radius:999px; font-size:12px; }
.gear-sources .gear-role-chip button { padding:0 4px; min-height:0; line-height:1; }
.gear-sources .gear-source-warn { margin-top:4px; font-size:12px; color:#b45309; }
.gear-sources .gear-source-catalogue { margin-top:16px; }
.gear-sources .gear-source-catalogue summary { cursor:pointer; font-weight:600; margin-bottom:8px; }
`;
