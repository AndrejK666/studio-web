// From the prototype at 00828880: `App.tsx`'s connectors constants (CATEGORIES, MISSING_MEANS, HEALTH_TTL_MS,
// ORG_ONLY_PROVIDER, Reach), `environments.ts`'s environmentsByConnection
// and `project-sources.ts`'s supportsPullRequests/repoKey/hasRepository/withPicked — the pure parts, unchanged
// (`project-sources.ts` itself also calls the api, so it did not move whole). Titles and blurbs are in i18n.

import type { ProjectSource, ScreenText } from '@constructor-studio/mfe-shared';
import type {
  ConnectorProvider,
  EnvironmentUse,
  ProviderField,
  ProviderHolder,
  RemoteRepo,
  StoredConnection,
} from '../api/types';

/** Provider groups in the picker, in its order. Keys match `ConnectorDriver::category()`. */
export const CATEGORY_KEYS = ['source_code', 'ai', 'notification', 'cluster', 'registry', 'compute', 'service'] as const;

/** The kinds whose absence the "Not connected yet" line explains (the prototype's MISSING_MEANS). */
export const MISSING_EXPLAINED: readonly string[] = ['source_code', 'ai', 'notification', 'cluster'];

/** How long a connection's answer to a test is trusted before it is asked again. */
export const HEALTH_TTL_MS = 5 * 60_000;

/** The kinds whose connections an environment deploys with (ADR-0043, ADR-0048). */
const ENVIRONMENT_KINDS: readonly string[] = ['cluster', 'registry'];

type HeldBy = { provider: string; category?: string; holder?: ProviderHolder; sign_in?: boolean };

/** Who may hold a provider's connection, as its driver says; from its kind where an older backend says nothing. */
function holderOf(p: HeldBy): ProviderHolder {
  if (p.holder) return p.holder;
  if (p.sign_in) return 'personal';
  return p.category && [...ENVIRONMENT_KINDS, 'service'].includes(p.category) ? 'organization' : 'any';
}

/** A provider whose connections only the organization holds: a cluster, a registry or a service, which only the server uses. */
export const orgOnlyProvider = (p: HeldBy): boolean => holderOf(p) === 'organization';

/** Where a connection is attached, and how widely its token is readable. */
export type Reach = 'organization' | 'workspace' | 'personal';

/** How a provider's connection is made: by signing in, by pasting a credential,
 *  or either way (Constructor Research with a sign-in client, ADR-0049 §1). */
export type ConnectWay = 'sign_in' | 'paste';

/** The ways a provider offers, the sign-in first. */
export function connectWays(provider: Pick<ConnectorProvider, 'sign_in' | 'pasted_key'>): ConnectWay[] {
  const ways: ConnectWay[] = [];
  if (provider.sign_in) ways.push('sign_in');
  if (provider.pasted_key ?? !provider.sign_in) ways.push('paste');
  return ways;
}

/** The reach a newly picked provider starts with on the organization's page: the holder its driver names, else the current one. */
export function reachFor(provider: HeldBy, current: Reach): Reach {
  const holder = holderOf(provider);
  return holder === 'any' ? current : holder;
}

/** The address field: what a form without a described one asks for, and where a field writes it. */
export const BASE_URL_FIELD = 'base_url';
/** The credential field. */
export const TOKEN_FIELD = 'token';

/**
 * A provider's form, in the order it is drawn, as its driver describes it. An older backend describes none:
 * then the address (none for a fixed target, whose credential is its whole address) and the credential.
 */
export function formFields(provider: ConnectorProvider): ProviderField[] {
  if (provider.fields?.length) return provider.fields;
  const token: ProviderField = {
    name: TOKEN_FIELD,
    label: provider.credential_label,
    kind: 'secret',
    required: !provider.token_optional,
    hint: '',
    placeholder: provider.credential_hint,
  };
  if (provider.fixed_target) return [token];
  const address: ProviderField = {
    name: BASE_URL_FIELD,
    label: 'Instance URL',
    kind: 'url',
    required: !provider.default_base_url,
    hint: '',
    placeholder: provider.default_base_url,
  };
  return [address, token];
}

/** The fields that are the connection's options: neither its address nor its credential. */
export const optionFields = (fields: readonly ProviderField[]): ProviderField[] =>
  fields.filter((f) => f.name !== BASE_URL_FIELD && f.name !== TOKEN_FIELD);

/** Whether a value fills its field: present when required, in its shape and length when given. */
export function fieldValid(field: ProviderField, value: string): boolean {
  const v = value.trim();
  if (!v) return !field.required;
  if (field.max_length != null && v.length > field.max_length) return false;
  if (field.pattern) {
    try {
      if (!new RegExp(field.pattern).test(v)) return false;
    } catch {
      // A pattern this browser cannot read is the server's to check.
    }
  }
  if (field.kind === 'select' && field.choices?.length) return field.choices.some((c) => c.value === v);
  return true;
}

/**
 * A field's words: the dictionary's `int_field_<provider>_<name>` (and `…_hint`) where it has them, so a provider's
 * words can be translated, else the driver's own. Not a list of providers: a dictionary entry or none.
 */
export function fieldText(t: ScreenText, provider: string, field: ProviderField, part: 'label' | 'hint'): string {
  const key = `int_field_${provider}_${field.name}${part === 'hint' ? '_hint' : ''}`.replace(/[^a-z0-9_]/gi, '_');
  const said = t(key);
  return said && said !== key && !said.endsWith(`:${key}`) ? said : field[part];
}

/** The organization's page lists the shared connections: never a person's own. */
export function sharedConnections(connections: readonly StoredConnection[]): StoredConnection[] {
  return connections.filter((c) => c.scope !== 'personal');
}

/** The profile lists the caller's own: the connections stored as personal. */
export function personalConnections(connections: readonly StoredConnection[]): StoredConnection[] {
  return connections.filter((c) => c.scope === 'personal');
}

/** What a person may connect as their own: anything but what only the organization holds. */
export function personalProviders<P extends HeldBy>(providers: readonly P[]): P[] {
  return providers.filter((p) => !orgOnlyProvider(p));
}

/** The kinds this Studio offers that nothing is connected for yet. */
export function missingCategories(
  providers: readonly Pick<ConnectorProvider, 'provider' | 'category'>[],
  connections: readonly Pick<StoredConnection, 'provider'>[]
): string[] {
  const categoryOf = (p: string) => providers.find((x) => x.provider === p)?.category;
  return CATEGORY_KEYS.filter(
    (key) => providers.some((p) => p.category === key) && !connections.some((c) => categoryOf(c.provider) === key)
  );
}

/** A connection's address, shown only when it is not the provider's default. */
export function nonDefaultAddress(baseUrl: string, defaultUrl: string): string | null {
  if (!baseUrl || baseUrl.replace(/\/$/, '') === defaultUrl.replace(/\/$/, '')) return null;
  return baseUrl.replace(/^https?:\/\//, '');
}

/** What uses a connection of a kind: an environment deploys with a cluster or a registry; a tier reads a gear repository. */
export function usedByKind(category: string | undefined): 'environments' | 'gear_repositories' | null {
  if (category && ENVIRONMENT_KINDS.includes(category)) return 'environments';
  return category === 'gears' ? 'gear_repositories' : null;
}

/** Which environments deploy with each cluster or registry connection. */
export function environmentsByConnection(environments: readonly EnvironmentUse[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of environments) {
    out.set(e.connection_id, [...(out.get(e.connection_id) ?? []), e.name]);
    if (e.registry_connection_id) out.set(e.registry_connection_id, [...(out.get(e.registry_connection_id) ?? []), e.name]);
  }
  return out;
}

/** How the IDE's "Share with the team" lands edits. */
export type ShareMode = 'branch' | 'pull_request';

/** Whether shares through `connection` can open a pull request: GitHub only for now. */
export function supportsPullRequests(connection: Pick<StoredConnection, 'provider'> | null | undefined): boolean {
  return connection?.provider === 'github';
}

/** What names a repository: host and path, case and `.git` aside. */
export function repoKey(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.trim());
    const path = u.pathname.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
    return path ? `${u.hostname}/${path}`.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Whether the config already lists the repository at `url`. */
export function hasRepository(sources: readonly ProjectSource[] | undefined, url: string): boolean {
  const key = repoKey(url);
  return !!key && (sources ?? []).some((s) => repoKey(s.clone_url) === key);
}

/** `sources` with the picked repositories added through `connection`; one already listed is not added twice. */
export function withPicked(
  sources: readonly ProjectSource[] | undefined,
  connection: Pick<StoredConnection, 'id'>,
  picks: readonly RemoteRepo[],
  shareMode: ShareMode = 'branch'
): { sources: ProjectSource[]; added: number } {
  const out = [...(sources ?? [])];
  let added = 0;
  for (const r of picks) {
    if (hasRepository(out, r.clone_url)) continue;
    out.push({
      connection_id: connection.id,
      full_path: r.full_path,
      clone_url: r.clone_url,
      ...(r.default_branch ? { branch: r.default_branch } : {}),
      share_mode: shareMode,
    });
    added += 1;
  }
  return { sources: out, added };
}
