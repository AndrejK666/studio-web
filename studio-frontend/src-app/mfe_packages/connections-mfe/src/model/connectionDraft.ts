/**
 * What the Connect source form collects, before anything is sent.
 */

// @cpt-dod:cpt-studiofrontend-dod-connection-create-scope:p1
// @cpt-algo:cpt-studiofrontend-algo-connection-create-write:p2
import {
  type CreateConnectionBody,
  type ProviderDto,
  type ProviderFieldDto,
} from '@constructor-studio/mfe-shared';
import { CONNECTION_SCOPE } from './connection';

export interface ConnectionDraft {
  readonly provider: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly token: string;
  /** The provider's options, by the names its form gives them. */
  readonly options: Readonly<Record<string, string>>;
}

export const EMPTY_DRAFT: ConnectionDraft = {
  provider: '',
  label: '',
  baseUrl: '',
  token: '',
  options: {},
};

export const BASE_URL_FIELD = 'base_url';
export const TOKEN_FIELD = 'token';

/**
 * A provider's form as its driver describes it; from an older backend that
 * describes none, the address (none for a fixed target) and the credential.
 */
export function providerFields(provider: ProviderDto): ProviderFieldDto[] {
  if (provider.fields?.length) return provider.fields;
  const token: ProviderFieldDto = {
    name: TOKEN_FIELD,
    label: provider.credential_label,
    kind: 'secret',
    required: !provider.token_optional,
    hint: '',
    placeholder: provider.credential_hint,
  };
  if (provider.fixed_target) return [token];
  return [
    {
      name: BASE_URL_FIELD,
      label: '',
      kind: 'url',
      required: !provider.default_base_url,
      hint: '',
      placeholder: provider.default_base_url,
    },
    token,
  ];
}

/** The fields that are options: neither the address nor the credential. */
export const optionFields = (fields: readonly ProviderFieldDto[]): ProviderFieldDto[] =>
  fields.filter((f) => f.name !== BASE_URL_FIELD && f.name !== TOKEN_FIELD);

function filled(field: ProviderFieldDto | undefined, value: string): boolean {
  const v = value.trim();
  if (!field) return true;
  if (!v) return !field.required;
  if (field.max_length != null && v.length > field.max_length) return false;
  if (field.pattern) {
    try {
      return new RegExp(field.pattern).test(v);
    } catch {
      return true;
    }
  }
  return true;
}

/**
 * Whether the draft can be sent: a provider, a label, and every field its
 * form requires in the shape it gives. Without the form, a credential.
 */
export function isDraftUsable(draft: ConnectionDraft, fields: readonly ProviderFieldDto[] = []): boolean {
  if (draft.provider === '' || draft.label.trim() === '') return false;
  const token = fields.find((f) => f.name === TOKEN_FIELD);
  if ((token?.required ?? true) && draft.token.trim() === '') return false;
  if (!filled(fields.find((f) => f.name === BASE_URL_FIELD), draft.baseUrl)) return false;
  return optionFields(fields).every((f) => filled(f, draft.options?.[f.name] ?? ''));
}

export function toCreateBody(
  draft: ConnectionDraft,
  ownerTenantId: string
): CreateConnectionBody {
  // @cpt-begin:cpt-studiofrontend-algo-connection-create-write:p2:inst-2
  const body: CreateConnectionBody = {
    provider: draft.provider,
    label: draft.label.trim(),
    token: draft.token,
    scope: CONNECTION_SCOPE,
    owner_tenant_id: ownerTenantId,
  };
  // @cpt-end:cpt-studiofrontend-algo-connection-create-write:p2:inst-2
  // @cpt-begin:cpt-studiofrontend-algo-connection-create-write:p2:inst-3
  // Absent, not empty: the gear reads an empty string as an installation root.
  const baseUrl = draft.baseUrl.trim();
  if (baseUrl) body.base_url = baseUrl;
  // @cpt-end:cpt-studiofrontend-algo-connection-create-write:p2:inst-3
  const options = Object.fromEntries(
    Object.entries(draft.options ?? {})
      .map(([name, value]) => [name, value.trim()] as const)
      .filter(([, value]) => value)
  );
  if (Object.keys(options).length) body.options = options;
  return body;
}
