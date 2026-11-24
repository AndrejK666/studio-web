import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MATCH_CHOICE,
  MATCH_PROVIDERS,
  MAX_SPEC_BYTES,
  chooseModel,
  chooseProvider,
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

  it('starts on LiteLLM and its default model', () => {
    expect(DEFAULT_MATCH_CHOICE).toEqual({
      provider: 'litellm',
      model: 'glm-5.3-flash',
    });
  });

  it('gives every connection a default that it lists', () => {
    for (const provider of MATCH_PROVIDERS)
      expect(provider.models).toContain(provider.defaultModel);
  });
});

describe('choosing', () => {
  it('moves to another connection on its own default model', () => {
    expect(chooseProvider('openai')).toEqual({
      provider: 'openai',
      model: 'gpt-5.4',
    });
  });

  it('ignores a connection it does not offer', () => {
    expect(chooseProvider('constructor')).toEqual(DEFAULT_MATCH_CHOICE);
  });

  it('keeps a model the connection lists and drops one it does not', () => {
    expect(chooseModel(DEFAULT_MATCH_CHOICE, 'deepseek-v4.1-flash-1017').model).toBe(
      'deepseek-v4.1-flash-1017'
    );
    expect(chooseModel(DEFAULT_MATCH_CHOICE, 'gpt-5.5')).toEqual(DEFAULT_MATCH_CHOICE);
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

  it('builds the run with the chosen connection and model and a bounded budget', async () => {
    const body = await runBody(
      { name: 'PRD.md', content: '# PRD' },
      { provider: 'litellm', model: 'glm-5.3-flash' },
      'studio'
    );
    expect(body.product).toBe('studio');
    expect(body.documents[0]).toMatchObject({
      path: 'PRD.md',
      content: '# PRD',
    });
    expect(body.documents[0].sha256).toHaveLength(64);
    expect(body.options).toMatchObject({
      provider: 'litellm',
      model: 'glm-5.3-flash',
    });
    expect(body.options.max_calls).toBeLessThanOrEqual(400);
  });
});
