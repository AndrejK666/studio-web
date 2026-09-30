// @cpt-algo:cpt-studiofrontend-algo-editor-session-sources:p1
// @cpt-dod:cpt-studiofrontend-dod-editor-session-sources:p1
// @cpt-dod:cpt-studiofrontend-dod-editor-session-no-personal-token:p1
/**
 * A project's sources as the `repos` of a session launch. Exported for #323:
 * an artifact's `repository` is the source's `full_path`, and this is where
 * its checkout lives.
 */

import type { ConnectionDto } from '../connector/connectorTypes';
import type { ProjectSource } from './projectConfig';

export interface SessionSource {
  /** Directory under the workspace root: `[a-z0-9_-]+`, unique in the launch. */
  name: string;
  kind: 'git';
  url: string;
  /** The connection's credstore reference, resolved by the backend; never a token. */
  token_ref?: string;
}

/** Readable by its owner alone: in a shared session it would serve every member. */
const PERSONAL_SCOPE = 'personal';

// TODO: the spec is silent on an empty last segment; `source` keeps the name valid.
const FALLBACK_DIRECTORY = 'source';

function sourceDirectory(fullPath: string): string {
  const last = fullPath.split('/').filter(Boolean).pop() ?? '';
  return last.toLowerCase().replace(/[^a-z0-9_-]/g, '-') || FALLBACK_DIRECTORY;
}

export function sessionSources(
  sources: readonly ProjectSource[],
  connections: readonly ConnectionDto[]
): SessionSource[] {
  const byId = new Map(connections.map((connection) => [connection.id, connection]));
  const taken = new Set<string>();
  // Nothing to clone, and the backend answers a git source without a url with a 500.
  // `?.`/`??`: the metadata is free-form, a stored source may lack a field.
  return sources
    .filter((source) => source.clone_url?.trim())
    .map((source): SessionSource => {
      const base = sourceDirectory(source.full_path ?? '');
      let name = base;
      for (let suffix = 2; taken.has(name); suffix += 1) name = `${base}-${suffix}`;
      taken.add(name);
      // One place decides the credential; ADR-0030 removes it altogether.
      const connection = byId.get(source.connection_id);
      const tokenRef = connection && connection.scope !== PERSONAL_SCOPE ? connection.secret_ref : '';
      return { name, kind: 'git', url: source.clone_url, ...(tokenRef ? { token_ref: tokenRef } : {}) };
    });
}
