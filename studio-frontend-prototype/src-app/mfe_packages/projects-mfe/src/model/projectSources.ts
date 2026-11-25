/**
 * A project's repositories, `sources[]` of its config: which entries a change
 * adds or removes. Writing them is `effects/projectSourcesEffects.ts`.
 */

import type { ProjectSource } from '@constructor-studio/mfe-shared';
import type { RepositoryPick } from './projectDraft';

function cloneUrlParts(cloneUrl: string): { protocol: string; host: string; path: string } | null {
  try {
    const url = new URL(cloneUrl.trim());
    const path = url.pathname
      .replace(/^\/+|\/+$/g, '')
      .replace(/\.git$/, '')
      .replace(/\/+$/, '');
    return url.host && path ? { protocol: url.protocol, host: url.host, path } : null;
  } catch {
    return null;
  }
}

/**
 * A clone URL reduced to what names the repository: host and path, without
 * the scheme, credentials, a trailing slash or `.git`, in lower case. `null`
 * for anything without a scheme.
 *
 * The backend's `repository_key` (`studio-backend/src/project_sources.rs`)
 * gives the same key for a provider's clone URL; both drop a query and a
 * fragment. They part on what a provider does not answer with: an explicit
 * default port, which the backend keeps in the key and `URL` drops. Change
 * both together.
 */
export function repositoryKey(cloneUrl: string): string | null {
  const parts = cloneUrlParts(cloneUrl);
  return parts && `${parts.host}/${parts.path}`.toLowerCase();
}

/** The provider host a clone URL names, lower case, as `repositoryKey` reads it; `null` without a scheme. */
export function repositoryHost(cloneUrl: string): string | null {
  return cloneUrlParts(cloneUrl)?.host.toLowerCase() ?? null;
}

// @cpt-dod:cpt-studiofrontend-dod-project-sources-menu-open-in:p1
export function repositoryWebUrl(cloneUrl: string): string | null {
  const parts = cloneUrlParts(cloneUrl);
  if (!parts || (parts.protocol !== 'https:' && parts.protocol !== 'http:')) return null;
  return `${parts.protocol}//${parts.host}/${parts.path}`;
}

/** What names a source's repository on its provider's site. */
export interface SourceWebInput {
  provider: string | null;
  cloneUrl: string;
  /** The connection's base URL, which may be an API one; `null` when unknown. */
  baseUrl: string | null;
  fullPath: string;
  branch: string | null;
}

/** A source's pages on its provider's site: the repository, and its branch where the provider is known. */
export interface SourceWebUrls {
  repository: string;
  branch: string | null;
}

/**
 * The site a connection's base URL stands for: an API base
 * (`https://api.github.com`, `https://ghe/api/v3`, `https://gitlab/api/v4`)
 * is not the site, a plain one is used as is. `null` without an http(s) base.
 */
export function providerSiteUrl(baseUrl: string | null): string | null {
  const base = (baseUrl ?? '').trim();
  if (!base) return null;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const api = /^api\.(github\.com|bitbucket\.org)$/i.exec(url.host);
  if (api) return `https://${api[1].toLowerCase()}`;
  const path = url.pathname.replace(/\/api\/v\d+\/?$/i, '').replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

function branchPath(provider: string | null, branch: string): string | null {
  const ref = branch.split('/').map(encodeURIComponent).join('/');
  switch (provider) {
    case 'github':
      return `/tree/${ref}`;
    case 'gitlab':
      return `/-/tree/${ref}`;
    case 'bitbucket':
      return `/src/${ref}`;
    default:
      return null;
  }
}

/**
 * Where a source opens on its provider's site. The clone URL names the
 * repository when it is an http(s) one; otherwise the connection's site and
 * the source's path do. `null` when neither says where.
 */
export function sourceWebUrls(source: SourceWebInput): SourceWebUrls | null {
  const fromClone = repositoryWebUrl(source.cloneUrl);
  const site = fromClone === null ? providerSiteUrl(source.baseUrl) : null;
  const path = source.fullPath.replace(/^\/+|\/+$/g, '');
  const repository = fromClone ?? (site !== null && path ? `${site}/${path}` : null);
  if (repository === null) return null;
  const tail = source.branch ? branchPath(source.provider, source.branch) : null;
  return { repository, branch: tail === null ? null : `${repository}${tail}` };
}

export function sameRepository(a: string, b: string): boolean {
  const key = repositoryKey(a);
  return key !== null && key === repositoryKey(b);
}

/**
 * `sources` with `entries` appended. A repository already attached — through
 * any connection — is not attached twice: a second connection would sync a
 * second copy of it into the graph. `added` is what was actually appended.
 */
export function withSources(
  sources: readonly ProjectSource[],
  entries: readonly ProjectSource[]
): { sources: ProjectSource[]; added: ProjectSource[] } {
  const next = [...sources];
  const added: ProjectSource[] = [];
  for (const entry of entries) {
    if (next.some((source) => sameRepository(source.clone_url, entry.clone_url))) continue;
    next.push(entry);
    added.push(entry);
  }
  return { sources: next, added };
}

/** `sources` without the entry attached through that connection at that path. */
export function withoutSource(
  sources: readonly ProjectSource[],
  entry: Pick<ProjectSource, 'connection_id' | 'full_path'>
): ProjectSource[] {
  return sources.filter(
    (source) =>
      source.connection_id !== entry.connection_id || source.full_path !== entry.full_path
  );
}

/** The source a picked repository is attached as, from the wizard or from Connect source. */
export function sourceOf(pick: RepositoryPick): ProjectSource {
  return {
    connection_id: pick.connectionId,
    full_path: pick.fullPath,
    clone_url: pick.cloneUrl,
    ...(pick.defaultBranch ? { branch: pick.defaultBranch } : {}),
    share_mode: 'branch',
  };
}

/** How the IDE's "Share with the team" lands edits in a source. */
export type ShareMode = NonNullable<ProjectSource['share_mode']>;

/**
 * Whether shares through a connection of `provider` can open a pull request:
 * GitHub only for now (the prototype's `supportsPullRequests`, mirroring the
 * backend's `ConnectorDriver::supports_pull_requests`). Change both together.
 */
export function supportsPullRequests(provider: string | null | undefined): boolean {
  return provider === 'github';
}

/**
 * Why `name` cannot be a branch, or null when it can: git's own rules for a
 * ref name, the ones a person mistypes (spaces, `..`, a leading `-` or `/`, a
 * trailing `.lock`, `/` or `.`, control characters and `~^:?*[\`).
 */
export function branchNameProblem(name: string): 'empty' | 'invalid' | null {
  const b = name.trim();
  if (!b) return 'empty';
  if (
    /[\s~^:?*[\\]/.test(b) ||
    [...b].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f) ||
    b.includes('..') ||
    b.includes('@{') ||
    b.includes('//') ||
    b.startsWith('-') ||
    b.startsWith('/') ||
    b.endsWith('/') ||
    b.endsWith('.') ||
    b.endsWith('.lock') ||
    b === '@'
  ) {
    return 'invalid';
  }
  return null;
}

/**
 * `sources` with the entry attached through that connection at that path
 * checked out at `branch` (a session's checkout, a build's base, the specs'
 * sync); every other entry, and every other field of that one, as it was.
 */
export function withBranch(
  sources: readonly ProjectSource[],
  entry: Pick<ProjectSource, 'connection_id' | 'full_path'>,
  branch: string
): ProjectSource[] {
  const b = branch.trim();
  return sources.map((source) =>
    source.connection_id === entry.connection_id && source.full_path === entry.full_path
      ? { ...source, branch: b }
      : source
  );
}

/**
 * `sources` with the entry attached through that connection at that path
 * shared as `mode`; every other entry, and every other field of that one, as
 * it was. An entry the config no longer lists changes nothing.
 */
export function withShareMode(
  sources: readonly ProjectSource[],
  entry: Pick<ProjectSource, 'connection_id' | 'full_path'>,
  mode: ShareMode
): ProjectSource[] {
  return sources.map((source) =>
    source.connection_id === entry.connection_id && source.full_path === entry.full_path
      ? { ...source, share_mode: mode }
      : source
  );
}
