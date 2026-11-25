import { describe, expect, it } from 'vitest';
import type { ProviderDto, ProviderFieldDto } from '@constructor-studio/mfe-shared';
import { EMPTY_DRAFT, isDraftUsable, providerFields, toCreateBody } from './connectionDraft';

const FILLED = { ...EMPTY_DRAFT, provider: 'github', label: 'GitHub', token: 'ghp_x' };

describe('draft completeness', () => {
  it('needs a provider, a label and a credential', () => {
    expect(isDraftUsable(FILLED)).toBe(true);
    expect(isDraftUsable({ ...FILLED, provider: '' })).toBe(false);
    expect(isDraftUsable({ ...FILLED, label: '   ' })).toBe(false);
    expect(isDraftUsable({ ...FILLED, token: '' })).toBe(false);
  });

  it('does not require a base URL — the gear has a default for every provider', () => {
    expect(isDraftUsable({ ...FILLED, baseUrl: '' })).toBe(true);
  });
});

describe('request body', () => {
  it('sends organization scope and the owner tenant, neither of them asked for', () => {
    expect(toCreateBody(FILLED, 'org-1')).toEqual({
      provider: 'github',
      label: 'GitHub',
      token: 'ghp_x',
      scope: 'organization',
      owner_tenant_id: 'org-1',
    });
  });

  it('omits an empty base URL instead of sending one, so the gear applies its default', () => {
    expect(toCreateBody({ ...FILLED, baseUrl: '  ' }, 'org-1')).not.toHaveProperty('base_url');
  });

  it('passes a given base URL through, trimmed', () => {
    expect(toCreateBody({ ...FILLED, baseUrl: ' https://ghe.corp ' }, 'org-1').base_url).toBe(
      'https://ghe.corp'
    );
  });

  it('trims the label, because the gear stores what it is sent', () => {
    expect(toCreateBody({ ...FILLED, label: '  GitHub  ' }, 'org-1').label).toBe('GitHub');
  });
});

describe('the provider’s form', () => {
  const github: ProviderDto = {
    provider: 'github',
    display_name: 'GitHub',
    default_base_url: 'https://api.github.com',
    instance_id: 'i',
    category: 'source_code',
    credential_label: 'PAT',
    credential_hint: 'ghp_…',
    fixed_target: false,
  };
  const strategy: ProviderFieldDto = {
    name: 'strategy',
    label: 'Strategy ID',
    kind: 'text',
    required: true,
    hint: '',
    placeholder: '',
    pattern: '^[a-z][a-z0-9_]{0,39}$',
  };
  const service: ProviderFieldDto[] = [
    strategy,
    { ...strategy, name: 'base_url', label: 'Instance URL', kind: 'url', pattern: null },
    { ...strategy, name: 'token', label: 'Secret', kind: 'secret', pattern: null },
  ];

  it('is the address and the credential when the driver describes none', () => {
    expect(providerFields(github).map((f) => f.name)).toEqual(['base_url', 'token']);
    expect(providerFields({ ...github, fixed_target: true }).map((f) => f.name)).toEqual(['token']);
    expect(providerFields({ ...github, fields: service })).toBe(service);
  });

  it('needs every required field in the shape it gives', () => {
    const draft = { ...FILLED, provider: 'assembly-service', token: 's', baseUrl: 'https://matcher.example' };
    expect(isDraftUsable(draft, service)).toBe(false);
    expect(isDraftUsable({ ...draft, options: { strategy: 'Not Snake' } }, service)).toBe(false);
    expect(isDraftUsable({ ...draft, options: { strategy: 'acme_matcher' } }, service)).toBe(true);
    expect(isDraftUsable({ ...draft, baseUrl: '', options: { strategy: 'acme_matcher' } }, service)).toBe(false);
  });

  it('sends the options it was given, trimmed, and none when there are none', () => {
    expect(toCreateBody({ ...FILLED, options: { strategy: ' acme ', empty: ' ' } }, 'org-1').options).toEqual({
      strategy: 'acme',
    });
    expect(toCreateBody(FILLED, 'org-1')).not.toHaveProperty('options');
  });
});
