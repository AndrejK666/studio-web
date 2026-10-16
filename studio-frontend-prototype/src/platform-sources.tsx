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

import { useCallback, useEffect, useState } from "react";

import { PLATFORM_ROOT_TENANT_ID, api, type Connection, type GearboxStatus } from "./api";
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

export function PlatformSources({ token, isPlatformAdmin }: { token: string; isPlatformAdmin: boolean }) {
  return <GearSources token={token} tier="platform" tenantId={PLATFORM_ROOT_TENANT_ID} mayManage={isPlatformAdmin} />;
}

/** Organization › Components › Repositories: who may change the list is who
 *  may manage the organization's registry (`component.registry`). `embedded`
 *  drops the page heading, which the Components page already has. */
export function OrgSources({ token, orgId, embedded = false }: { token: string; orgId?: string; embedded?: boolean }) {
  const [mayManage, setMayManage] = useState(false);
  useEffect(() => {
    api
      .orgGearRepository(token)
      .then((r) => setMayManage(r.may_manage))
      .catch(() => setMayManage(false));
  }, [token]);
  if (!orgId) return <p className="hint">Open an organization to see its sources.</p>;
  return <GearSources token={token} tier="organization" tenantId={orgId} mayManage={mayManage} embedded={embedded} />;
}

function GearSources({
  token,
  tier,
  tenantId,
  mayManage,
  embedded = false,
}: {
  token: string;
  tier: "platform" | "organization";
  tenantId: string;
  mayManage: boolean;
  embedded?: boolean;
}) {
  const [connections, setConnections] = useState<Connection[] | null>(null);
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
    },
    [token, tenantId, org, readsConnections],
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

  return (
    <div className="gear-sources" data-platform-sources={org ? undefined : ""} data-org-sources={org ? "" : undefined}>
      <style>{SOURCES_CSS}</style>
      {!embedded && <h1>Sources</h1>}
      <p className="subtitle">
        {org
          ? "The repositories this organization's gears come from. Its corpus reads the platform's repositories first, then these, in this order; a gear in one may use a gear in another. One of them is where Create a gear writes."
          : "The repositories the platform's gears come from. The Gearbox engine reads them together, in this order, so a gear in one may use a gear in another; where two declare the same gear, the first wins. Every organization builds on what they hold."}
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
      {mayManage ? (
        <AddGearRepository
          token={token}
          ownerTenant={tenantId}
          taken={own.map((r) => r.sourceId)}
          platformIds={platformRows.map((r) => r.sourceId)}
          onAdded={(line) => {
            setNote(line);
            load(true);
          }}
        />
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
  onAdded,
}: {
  token: string;
  ownerTenant: string;
  taken: string[];
  /** On an organization's page: the platform's source ids, which its own
   *  repositories cannot share (the engine names a root by it). */
  platformIds: string[];
  onAdded: (line: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
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
`;
