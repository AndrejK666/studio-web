/**
 * The connections a Gears match can run on, and the models each one uses.
 *
 * A person chooses the connection, never the models: each connection has one fixed combination, the
 * one that was measured, and the matcher service owns it (`PROVIDER_MODELS` in its `request.py`).
 * The list here only says what to show.
 *
 * Constructor's own connector is not offered: it is reachable only inside the VPN, which a deployed
 * Studio is not. Which of these two a deployment can use is the service's decision.
 */

export type MatchProviderCode = 'litellm' | 'openai';

export interface MatchProvider {
  code: MatchProviderCode;
  /** The host the key is sent to, shown so a person knows where their data goes. */
  host: string;
  /** The three models a run uses: candidates, candidates, checks. For display. */
  models: readonly [string, string, string];
}

/** LiteLLM first: it needs no VPN and no OpenAI account, so it is the default. */
export const MATCH_PROVIDERS: readonly MatchProvider[] = [
  {
    code: 'litellm',
    host: 'litellm.ext.constr.dev',
    models: ['glm-5.3-flash', 'glm-5.3-flash', 'glm-5.3-flash'],
  },
  {
    code: 'openai',
    host: 'api.openai.com',
    // The reasoning model in the second slot is what keeps the quality, and it makes a run slower.
    models: ['gpt-5.4', 'gpt-5.5', 'gpt-5.4'],
  },
];

export interface MatchChoice {
  provider: MatchProviderCode;
}

export const DEFAULT_MATCH_CHOICE: MatchChoice = { provider: MATCH_PROVIDERS[0].code };

export function providerFor(code: string): MatchProvider | undefined {
  return MATCH_PROVIDERS.find((provider) => provider.code === code);
}

/** A connection this page does not offer falls back to the default, so it cannot be sent. */
export function chooseProvider(code: string): MatchChoice {
  const provider = providerFor(code);
  return provider ? { provider: provider.code } : DEFAULT_MATCH_CHOICE;
}

/** The models as a person reads them: each distinct one once, in order (`gpt-5.4 + gpt-5.5`). */
export function modelsLabel(code: string): string {
  const models = providerFor(code)?.models ?? [];
  return Array.from(new Set(models)).join(' + ');
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
    // The connection only: the service decides the models, so a request cannot name one.
    options: {
      provider: choice.provider,
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
