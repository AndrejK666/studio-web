import { describe, expect, it } from 'vitest';
import type { ProjectProduct } from '../../api/types';
import { landed, needsCheck } from './keptCheck';

const verdict = (sha: string, extra: object = {}) => ({
  ok: true,
  errors: 0,
  warnings: 0,
  applications: [],
  gears: [],
  gdl_sha256: sha,
  ...extra,
});

describe('needsCheck', () => {
  const kept = { revision: 3, sha256: 'b' };

  it('asks nothing while the kept verdict is about the saved revision', () => {
    const product: ProjectProduct = { checks: { prod: verdict('b') } };
    expect(needsCheck(product, 'prod', kept)).toBe(false);
  });

  it('asks when the verdict is about another text, or there is none', () => {
    expect(needsCheck({ checks: { prod: verdict('a') } }, 'prod', kept)).toBe(true);
    expect(needsCheck({}, 'prod', kept)).toBe(true);
    expect(needsCheck({ checks: { prod: verdict('b') } }, 'dev', kept)).toBe(true);
  });

  it('follows a check already queued for the revision instead of asking again', () => {
    const product: ProjectProduct = {
      checks: { prod: verdict('a') },
      check_runs: { prod: { run_id: 'r', state: 'queued', revision: 3 } },
    };
    expect(needsCheck(product, 'prod', kept)).toBe(false);
    const older = { ...product, check_runs: { prod: { run_id: 'r', state: 'queued' as const, revision: 2 } } };
    expect(needsCheck(older, 'prod', kept)).toBe(true);
  });

  it('asks nothing without a saved revision or a record', () => {
    expect(needsCheck(null, 'prod', kept)).toBe(false);
    expect(needsCheck({}, 'prod', null)).toBe(false);
  });
});

describe('landed', () => {
  it('is the verdict the run made, or the run no longer waiting', () => {
    expect(landed({ checks: { prod: verdict('b', { run_id: 'r' }) } }, 'prod', 'r')).toBe(true);
    expect(landed({ check_runs: { prod: { run_id: 'r', state: 'failed', error: 'x' } } }, 'prod', 'r')).toBe(true);
    expect(landed({ check_runs: { prod: { run_id: 'r', state: 'queued' } } }, 'prod', 'r')).toBe(false);
    expect(landed({ check_runs: { prod: { run_id: 'other', state: 'succeeded' } } }, 'prod', 'r')).toBe(false);
  });
});
