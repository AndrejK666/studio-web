import { describe, expect, it } from 'vitest';
import { draftOf, overridesOf, type MatcherSettings } from './matcher-settings';

const values = { provider: 'constructor', models: ['c1', 'c1', 'c1'], max_calls: 400, max_extract_calls: 60 };
const settings = (overrides: MatcherSettings['overrides'] = {}): MatcherSettings => ({
  strategy: 'gears_matcher',
  scope: 'deployment',
  may_change: true,
  version: 0,
  effective: values,
  config: values,
  overrides,
  providers: [{ id: 'constructor', available: true }],
  ceilings: { max_calls: 2000, max_extract_calls: 500 },
});
const ceilings = settings().ceilings;

describe('matcher settings', () => {
  it('fills the form from the override, empty where the configuration is used', () => {
    expect(draftOf(settings())).toEqual({
      provider: '',
      sameModel: false,
      models: ['', '', ''],
      maxCalls: '',
      maxExtractCalls: '',
    });
    const d = draftOf(settings({ provider: 'openai', models: ['gpt-x'], max_calls: 300 }));
    expect(d).toMatchObject({ provider: 'openai', sameModel: true, models: ['gpt-x', 'gpt-x', 'gpt-x'], maxCalls: '300' });
  });

  it('sends null for every field left to the configuration', () => {
    expect(overridesOf(draftOf(settings()), ceilings)).toEqual({
      overrides: { provider: null, models: null, max_calls: null, max_extract_calls: null },
    });
  });

  it('sends one model for all roles, or three', () => {
    const d = draftOf(settings());
    expect(overridesOf({ ...d, sameModel: true, models: ['m', '', ''] }, ceilings)).toMatchObject({
      overrides: { models: ['m'] },
    });
    expect(overridesOf({ ...d, models: ['a', 'b', 'c'] }, ceilings)).toMatchObject({
      overrides: { models: ['a', 'b', 'c'] },
    });
    expect(overridesOf({ ...d, models: ['a', '', 'c'] }, ceilings)).toEqual({ problem: 'models_three' });
    expect(overridesOf({ ...d, models: ['a b', 'b', 'c'] }, ceilings)).toEqual({ problem: 'models_bad' });
  });

  it('keeps the bounds between 1 and their ceilings', () => {
    const d = draftOf(settings());
    expect(overridesOf({ ...d, maxCalls: '2000', maxExtractCalls: '1' }, ceilings)).toMatchObject({
      overrides: { max_calls: 2000, max_extract_calls: 1 },
    });
    expect(overridesOf({ ...d, maxCalls: '2001' }, ceilings)).toEqual({ problem: 'max_calls_bad' });
    expect(overridesOf({ ...d, maxCalls: '0' }, ceilings)).toEqual({ problem: 'max_calls_bad' });
    expect(overridesOf({ ...d, maxExtractCalls: '1.5' }, ceilings)).toEqual({ problem: 'max_extract_calls_bad' });
  });
});
