/**
 * The models a Gears match can run on, and the connection each belongs to.
 *
 * Constructor's own connector is not offered: it is reachable only inside the VPN, which a deployed
 * Studio is not. Which of these two a deployment can use is the matcher service's decision; the
 * list here is what the picker offers until the service reports it (`GET /v1/providers`).
 */

export type MatchProviderCode = 'litellm' | 'openai';

export interface MatchProvider {
  code: MatchProviderCode;
  /** The host the key is sent to, shown so a person knows where their data goes. */
  host: string;
  models: readonly string[];
  defaultModel: string;
}

/** LiteLLM first: it needs no VPN and no OpenAI account, so it is the default. */
export const MATCH_PROVIDERS: readonly MatchProvider[] = [
  {
    code: 'litellm',
    host: 'litellm.ext.constr.dev',
    // glm answers a whole-catalogue call in seconds; deepseek-v4.1-flash took 104 s for one and
    // runs out of the matcher's 120 s, so it is last.
    models: ['glm-5.3-flash', 'deepseek-v4.1-flash-1017', 'deepseek-v4.1-flash'],
    defaultModel: 'glm-5.3-flash',
  },
  {
    code: 'openai',
    host: 'api.openai.com',
    models: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5'],
    defaultModel: 'gpt-5.4',
  },
];

export interface MatchChoice {
  provider: MatchProviderCode;
  model: string;
}

export const DEFAULT_MATCH_CHOICE: MatchChoice = {
  provider: MATCH_PROVIDERS[0].code,
  model: MATCH_PROVIDERS[0].defaultModel,
};

export function providerFor(code: string): MatchProvider | undefined {
  return MATCH_PROVIDERS.find((provider) => provider.code === code);
}

/** Another connection starts on its own default model: a model id means nothing on another gateway. */
export function chooseProvider(code: string): MatchChoice {
  const provider = providerFor(code);
  return provider
    ? { provider: provider.code, model: provider.defaultModel }
    : DEFAULT_MATCH_CHOICE;
}

/** A model the connection does not list falls back to its default, so a stale choice cannot be sent. */
export function chooseModel(current: MatchChoice, model: string): MatchChoice {
  const provider = providerFor(current.provider);
  if (!provider) return DEFAULT_MATCH_CHOICE;
  return {
    provider: provider.code,
    model: provider.models.includes(model) ? model : provider.defaultModel,
  };
}

/** The spec a person chose to match: its name and its text. */
export interface MatchSpec {
  name: string;
  content: string;
}

/** The service refuses a document over 500 000 bytes (`limits.max_document_bytes`). */
export const MAX_SPEC_BYTES = 500_000;

export function specTooLarge(content: string): boolean {
  return new TextEncoder().encode(content).length > MAX_SPEC_BYTES;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** What the service takes to read free-form specs: a spec outside the format is read by a model. */
export const EXTRACT_MAX_CALLS = 40;
/** The most model calls a match may spend; the service's own cap is 400. */
export const MATCH_MAX_CALLS = 150;

/** A file name as the service's path rule wants it: relative, `.md`, no odd characters. */
export function specPath(name: string): string {
  const base =
    name
      .replace(/[\\/]/g, '-')
      .replace(/[^\w.\- ]/g, '-')
      .trim() || 'spec';
  return /\.md$/i.test(base) ? base : `${base}.md`;
}

export async function runBody(spec: MatchSpec, choice: MatchChoice, product: string) {
  return {
    product,
    documents: [
      {
        path: specPath(spec.name),
        sha256: await sha256Hex(spec.content),
        content: spec.content,
      },
    ],
    options: {
      provider: choice.provider,
      model: choice.model,
      max_calls: MATCH_MAX_CALLS,
      extract_max_calls: EXTRACT_MAX_CALLS,
    },
  };
}

/** The product id the service wants: lower-case words and dashes. */
export function productId(projectName: string): string {
  return (
    projectName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  );
}
