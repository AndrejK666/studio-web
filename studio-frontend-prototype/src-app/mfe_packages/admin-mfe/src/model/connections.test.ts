// The "picking repositories" cases are the prototype's (src/project-sources.test.ts at 00828880), unchanged.
import { describe, expect, it } from 'vitest';
import type { ProjectSource } from '@constructor-studio/mfe-shared';
import type { ConnectorProvider, ProviderField, RemoteRepo, StoredConnection } from '../api/types';
import {
  connectWays,
  environmentsByConnection,
  fieldText,
  fieldValid,
  formFields,
  optionFields,
  usedByKind,
  hasRepository,
  missingCategories,
  nonDefaultAddress,
  orgOnlyProvider,
  reachFor,
  sharedConnections,
  supportsPullRequests,
  withPicked,
} from './connections';

const connection = {
  id: 'c1',
  provider: 'github',
  secret_ref: 'studio-connection-c1',
} as StoredConnection;

const src = (full_path: string, clone_url = `https://github.com/${full_path}.git`): ProjectSource => ({
  connection_id: 'c1',
  full_path,
  clone_url,
});

describe('picking repositories', () => {
  const pick = (full_path: string, branch?: string): RemoteRepo => ({
    id: full_path,
    name: full_path.split('/')[1],
    full_path,
    clone_url: `https://github.com/${full_path}.git`,
    default_branch: branch,
  });

  it('adds each through its connection with its default branch, shared to that branch', () => {
    const got = withPicked([], connection, [pick('acme/api', 'main')]);
    expect(got.added).toBe(1);
    expect(got.sources).toEqual([
      {
        connection_id: 'c1',
        full_path: 'acme/api',
        clone_url: 'https://github.com/acme/api.git',
        branch: 'main',
        share_mode: 'branch',
      },
    ]);
  });

  it('records the share mode chosen for them, and leaves the listed ones as they are', () => {
    const listed: ProjectSource = { ...src('acme/web'), share_mode: 'branch' };
    const got = withPicked([listed], connection, [pick('acme/web'), pick('acme/api')], 'pull_request');
    expect(got.sources.map((s) => [s.full_path, s.share_mode])).toEqual([
      ['acme/web', 'branch'],
      ['acme/api', 'pull_request'],
    ]);
  });

  it('offer a pull request only through a GitHub connection', () => {
    expect(supportsPullRequests(connection)).toBe(true);
    expect(supportsPullRequests({ provider: 'bitbucket' })).toBe(false);
    expect(supportsPullRequests(null)).toBe(false);
  });

  it('does not add a repository the config already lists, however its URL is spelled', () => {
    const got = withPicked([src('acme/api', 'https://GitHub.com/Acme/api')], connection, [pick('acme/api')]);
    expect(got.added).toBe(0);
    expect(hasRepository(got.sources, 'https://github.com/acme/api.git')).toBe(true);
  });
});

describe('the organization page', () => {
  const providers = [
    { provider: 'github', category: 'source_code' },
    { provider: 'anthropic', category: 'ai' },
    { provider: 'kubernetes', category: 'cluster' },
  ];

  it('lists the shared connections, never a person’s own', () => {
    const rows = [
      { ...connection, id: 'a', scope: 'organization' },
      { ...connection, id: 'b', scope: 'personal' },
      { ...connection, id: 'c', scope: 'workspace' },
    ];
    expect(sharedConnections(rows).map((c) => c.id)).toEqual(['a', 'c']);
  });

  it('names the kinds offered that nothing is connected for, in the picker’s order', () => {
    expect(missingCategories(providers, [{ provider: 'github' }])).toEqual(['ai', 'cluster']);
    expect(missingCategories(providers, [])).toEqual(['source_code', 'ai', 'cluster']);
  });

  it('keeps a connection where its driver says it is held', () => {
    expect(orgOnlyProvider({ provider: 'kubernetes', holder: 'organization' })).toBe(true);
    expect(orgOnlyProvider({ provider: 'github', category: 'source_code', holder: 'any' })).toBe(false);
    expect(reachFor({ provider: 'kubernetes', holder: 'organization' }, 'personal')).toBe('organization');
    expect(reachFor({ provider: 'github', holder: 'any' }, 'personal')).toBe('personal');
    // A pasted Research key is the person's own account too: its driver says so, not its name.
    expect(reachFor({ provider: 'research', sign_in: false, holder: 'personal' }, 'organization')).toBe('personal');
  });

  it('reads the holder from the kind where an older backend does not say it', () => {
    expect(orgOnlyProvider({ provider: 'x', category: 'cluster' })).toBe(true);
    expect(orgOnlyProvider({ provider: 'x', category: 'registry' })).toBe(true);
    expect(orgOnlyProvider({ provider: 'x', category: 'service' })).toBe(true);
    expect(orgOnlyProvider({ provider: 'github', category: 'source_code' })).toBe(false);
    expect(reachFor({ provider: 'research', sign_in: true }, 'organization')).toBe('personal');
  });

  it('draws the form its driver describes, else the address and the credential', () => {
    const base: ConnectorProvider = {
      provider: 'github',
      display_name: 'GitHub',
      default_base_url: 'https://api.github.com',
      instance_id: 'i',
      category: 'source_code',
      credential_label: 'PAT',
      credential_hint: 'ghp_…',
    };
    expect(formFields(base).map((f) => [f.name, f.kind, f.required, f.placeholder])).toEqual([
      ['base_url', 'url', false, 'https://api.github.com'],
      ['token', 'secret', true, 'ghp_…'],
    ]);
    expect(formFields({ ...base, fixed_target: true }).map((f) => f.name)).toEqual(['token']);
    expect(formFields({ ...base, default_base_url: '' })[0].required).toBe(true);
    const described: ProviderField[] = [
      { name: 'strategy', label: 'Strategy ID', kind: 'text', required: true, hint: '', placeholder: '' },
      { name: 'token', label: 'Secret', kind: 'secret', required: true, hint: '', placeholder: '' },
    ];
    expect(formFields({ ...base, fields: described })).toBe(described);
    expect(optionFields(described).map((f) => f.name)).toEqual(['strategy']);
  });

  it('checks a value against its field: required, pattern, length and choices', () => {
    const field: ProviderField = {
      name: 'strategy',
      label: 'Strategy ID',
      kind: 'text',
      required: true,
      hint: '',
      placeholder: '',
      pattern: '^[a-z][a-z0-9_]{0,39}$',
      max_length: 40,
    };
    expect(fieldValid(field, '')).toBe(false);
    expect(fieldValid(field, 'acme_matcher')).toBe(true);
    expect(fieldValid(field, 'Acme')).toBe(false);
    expect(fieldValid({ ...field, pattern: null }, 'x'.repeat(41))).toBe(false);
    expect(fieldValid({ ...field, required: false }, '  ')).toBe(true);
    const select: ProviderField = { ...field, kind: 'select', pattern: null, choices: [{ value: 'a', label: 'A' }] };
    expect(fieldValid(select, 'a')).toBe(true);
    expect(fieldValid(select, 'b')).toBe(false);
  });

  it('takes a field’s words from the dictionary where it has them, else the driver’s', () => {
    const field: ProviderField = { name: 'strategy', label: 'Strategy ID', kind: 'text', required: true, hint: 'snake_case', placeholder: '' };
    const dictionary: Record<string, string> = { int_field_assembly_service_strategy: 'ID стратегии' };
    const t = Object.assign((key: string) => dictionary[key] ?? `screen.admin:${key}`, { count: (key: string) => key });
    expect(fieldText(t, 'assembly-service', field, 'label')).toBe('ID стратегии');
    expect(fieldText(t, 'assembly-service', field, 'hint')).toBe('snake_case');
    expect(fieldText(t, 'other', field, 'label')).toBe('Strategy ID');
  });

  it('says what uses a connection from its kind', () => {
    expect(usedByKind('cluster')).toBe('environments');
    expect(usedByKind('registry')).toBe('environments');
    expect(usedByKind('gears')).toBe('gear_repositories');
    expect(usedByKind('source_code')).toBeNull();
    expect(usedByKind(undefined)).toBeNull();
  });

  it('says which ways a provider is connected: sign in, paste, or either', () => {
    expect(connectWays({})).toEqual(['paste']);
    expect(connectWays({ sign_in: true })).toEqual(['sign_in']);
    expect(connectWays({ sign_in: true, pasted_key: true })).toEqual(['sign_in', 'paste']);
    expect(connectWays({ sign_in: false, pasted_key: true })).toEqual(['paste']);
  });

  it('shows an address only when it is not the provider’s default', () => {
    expect(nonDefaultAddress('https://github.com/', 'https://github.com')).toBeNull();
    expect(nonDefaultAddress('https://git.acme.dev', 'https://gitlab.com')).toBe('git.acme.dev');
    expect(nonDefaultAddress('', 'https://gitlab.com')).toBeNull();
  });

  it('says which environments deploy with each cluster and registry', () => {
    const uses = environmentsByConnection([
      { name: 'dev', connection_id: 'k1', registry_connection_id: 'r1' },
      { name: 'prod', connection_id: 'k1' },
    ]);
    expect(uses.get('k1')).toEqual(['dev', 'prod']);
    expect(uses.get('r1')).toEqual(['dev']);
  });
});
