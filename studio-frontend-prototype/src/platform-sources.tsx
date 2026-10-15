/* Platform › Sources (ADR-0046): the platform's gear repositories. Each is a
 * connection of the `gear-repository` kind in the root tenant -- one
 * repository at one ref, read with its own token or none -- and the Gearbox
 * engine reads them all together, in the order they were added, as the
 * corpus every organization's catalogue, previews and products draw on.
 *
 * Every organization sees the list; a platform administrator changes it.
 * While it is empty, the engine reads the deployment's corpus, and the page
 * says so. */

import { useCallback, useEffect, useState } from "react";

import { PLATFORM_ROOT_TENANT_ID, api, type Connection, type GearboxStatus } from "./api";
import { errText } from "./format";
import {
  GEAR_REPOSITORY,
  defaultSourceId,
  deploymentCorpus,
  gearRepositoryRows,
  isSourceId,
  readLine,
  repositoryOf,
} from "./gear-repositories";

export function PlatformSources({ token, isPlatformAdmin }: { token: string; isPlatformAdmin: boolean }) {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [status, setStatus] = useState<GearboxStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    (refresh = false) => {
      api
        .connections(token, PLATFORM_ROOT_TENANT_ID)
        .then((r) => setConnections(r.items))
        .catch((e) => {
          setConnections([]);
          setError(errText(e));
        });
      api
        .gearboxStatus(token, refresh)
        .then(setStatus)
        .catch(() => setStatus(null));
    },
    [token],
  );
  useEffect(() => load(), [load]);

  const rows = gearRepositoryRows(connections ?? [], PLATFORM_ROOT_TENANT_ID, status);
  const fallback = rows.length === 0 ? deploymentCorpus(status) : null;

  const test = async (c: Connection) => {
    setBusy(c.id);
    setError(null);
    setNote(null);
    try {
      const r = await api.testConnection(token, c.id, PLATFORM_ROOT_TENANT_ID);
      setNote(`${r.account}: ${r.display_name ?? "reachable"}`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (c: Connection) => {
    if (!window.confirm(`Stop reading ${repositoryOf(c.base_url) ?? c.label}? Its gears leave the platform's corpus.`))
      return;
    setBusy(c.id);
    setError(null);
    try {
      await api.deleteConnection(token, c.id, PLATFORM_ROOT_TENANT_ID);
      load(true);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="gear-sources" data-platform-sources>
      <style>{SOURCES_CSS}</style>
      <h1>Sources</h1>
      <p className="subtitle">
        The repositories the platform&apos;s gears come from. The Gearbox engine reads them together, in this order, so a
        gear in one may use a gear in another; where two declare the same gear, the first wins. Every organization builds
        on what they hold.
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
      {connections === null ? (
        <p className="hint">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="hint" data-gear-sources-empty>
          {fallback
            ? `No gear repository is connected, so the engine reads the deployment's corpus: ${fallback.repo}${
                fallback.git_ref ? `@${fallback.git_ref}` : ""
              } (${readLine(fallback)}). Adding one replaces it.`
            : "No gear repository is connected, and the deployment names no corpus: the engine has nothing to read."}
        </p>
      ) : (
        <table className="data-table" data-gear-sources>
          <thead>
            <tr>
              <th>#</th>
              <th>Source</th>
              <th>Repository</th>
              <th>Read</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.connection.id} data-gear-source={r.sourceId}>
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
                    {r.connection.secret_ref ? " · with a token" : " · public"}
                  </span>
                </td>
                <td>{readLine(r.read)}</td>
                <td className="gear-source-actions">
                  <button type="button" disabled={busy === r.connection.id} onClick={() => void test(r.connection)}>
                    Test
                  </button>
                  {isPlatformAdmin && (
                    <button type="button" disabled={busy === r.connection.id} onClick={() => void remove(r.connection)}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {isPlatformAdmin ? (
        <AddGearRepository
          token={token}
          taken={rows.map((r) => r.sourceId)}
          onAdded={(line) => {
            setNote(line);
            load(true);
          }}
        />
      ) : (
        <p className="hint">A platform administrator adds and removes the platform&apos;s gear repositories.</p>
      )}
    </div>
  );
}

function AddGearRepository({
  token,
  taken,
  onAdded,
}: {
  token: string;
  taken: string[];
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
        owner_tenant_id: PLATFORM_ROOT_TENANT_ID,
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
        it.
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
`;
