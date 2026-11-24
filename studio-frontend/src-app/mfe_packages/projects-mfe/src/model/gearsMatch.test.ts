import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MATCH_CHOICE,
  MATCH_PROVIDERS,
  MAX_SPEC_BYTES,
  chooseProvider,
  modelsLabel,
  productId,
  providerFor,
  runBody,
  sha256Hex,
  specPath,
  specTooLarge,
} from './gearsMatch';

describe('the connections a match can run on', () => {
  it('offers LiteLLM and OpenAI, and not Constructor (it needs the VPN)', () => {
    expect(MATCH_PROVIDERS.map((p) => p.code)).toEqual(['litellm', 'openai']);
    expect(providerFor('constructor')).toBeUndefined();
  });

  it('starts on LiteLLM', () => {
    expect(DEFAULT_MATCH_CHOICE).toEqual({ provider: 'litellm' });
  });

  it('gives each connection one fixed combination of three models, the measured ones', () => {
    expect(providerFor('litellm')?.models).toEqual([
      'glm-5.3-flash',
      'glm-5.3-flash',
      'glm-5.3-flash',
    ]);
    expect(providerFor('openai')?.models).toEqual(['gpt-5.4', 'gpt-5.5', 'gpt-5.4']);
  });

  it('shows the models once each, in order', () => {
    expect(modelsLabel('litellm')).toBe('glm-5.3-flash');
    expect(modelsLabel('openai')).toBe('gpt-5.4 + gpt-5.5');
    expect(modelsLabel('nope')).toBe('');
  });
});

describe('choosing', () => {
  it('moves to another connection', () => {
    expect(chooseProvider('openai')).toEqual({ provider: 'openai' });
  });

  it('ignores a connection it does not offer', () => {
    expect(chooseProvider('constructor')).toEqual(DEFAULT_MATCH_CHOICE);
  });
});

describe('what is sent for a spec', () => {
  it('hashes text the way the service checks it', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('turns a file name into a path the service accepts', () => {
    expect(specPath('My PRD.md')).toBe('My PRD.md');
    expect(specPath('notes')).toBe('notes.md');
    expect(specPath('a/b\\c?.MD')).toBe('a-b-c-.MD');
    expect(specPath('')).toBe('spec.md');
  });

  it('turns a project name into a product id', () => {
    expect(productId('Constructor Studio!')).toBe('constructor-studio');
    expect(productId('***')).toBe('project');
  });

  it('refuses a spec over the size the service takes', () => {
    expect(specTooLarge('x'.repeat(MAX_SPEC_BYTES))).toBe(false);
    expect(specTooLarge('x'.repeat(MAX_SPEC_BYTES + 1))).toBe(true);
  });

  it('builds the run with the chosen connection and a bounded budget', async () => {
    const body = await runBody(
      { name: 'PRD.md', content: '# PRD' },
      { provider: 'litellm' },
      'studio'
    );
    expect(body.product).toBe('studio');
    expect(body.documents[0]).toMatchObject({
      path: 'PRD.md',
      content: '# PRD',
    });
    expect(body.documents[0].sha256).toHaveLength(64);
    expect(body.options).toMatchObject({ provider: 'litellm' });
    // A request cannot name a model: the service owns the combination.
    expect(body.options).not.toHaveProperty('model');
    expect(body.options.max_calls).toBeLessThanOrEqual(400);
  });
});
