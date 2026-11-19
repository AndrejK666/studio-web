import { describe, expect, it } from 'vitest';
import {
  USAGE_OPTIONS,
  compact,
  countOf,
  duration,
  periodOf,
  serviceState,
  usageRows,
  type UsageItem,
} from './gear-match-usage';

const item = (extra: Partial<UsageItem> = {}): UsageItem => ({
  project_id: 'p1',
  project_name: 'Studioweb',
  workspace_id: 'w1',
  workspace_name: 'Main',
  strategy: 'gears_matcher',
  chosen: 'gears_matcher',
  source: 'organization',
  runs: { total: 2, succeeded: 1, partial: 0, failed: 1, cancelled: 0, running: 0 },
  usage: { calls: 127, cache_hits: 0, input_tokens: 651_649, output_tokens: 51_192 },
  accepted: 1,
  rejected: 0,
  questions_open: 17,
  questions_answered: 0,
  ...extra,
});

describe('gear match usage', () => {
  it('reads the period from the address, 30 days for anything else', () => {
    expect(periodOf('7')).toBe(7);
    expect(periodOf(90)).toBe(90);
    expect(periodOf('14')).toBe(30);
    expect(periodOf(undefined)).toBe(30);
  });

  it('tells a silent service from a missing one', () => {
    expect(serviceState({ configured: false, missing: 'no address', models: [] })).toBe('missing');
    expect(serviceState({ configured: true, answers: true, models: [] })).toBe('answers');
    expect(serviceState({ configured: true, answers: false, error: 'refused', models: [] })).toBe('silent');
    expect(serviceState({ configured: true, models: [] })).toBe('unknown');
  });

  it('says big numbers and durations shortly', () => {
    expect(compact(950)).toBe('950');
    expect(compact(702_841)).toBe('703k');
    expect(compact(1_200_000)).toBe('1.2M');
    expect(duration(360_000)).toBe('6 min');
    expect(duration(95_000)).toBe('1 min 35 s');
    expect(duration(4_000)).toBe('4 s');
    expect(countOf([{ key: 'manual', projects: 2 }], 'manual')).toBe(2);
    expect(countOf([], 'manual')).toBe(0);
  });

  it('sorts projects by tokens, questions and the last run', () => {
    const quiet = item({
      project_id: 'p2',
      project_name: 'Quiet',
      usage: { calls: 0, cache_hits: 0, input_tokens: 0, output_tokens: 0 },
      questions_open: 0,
      last_run: null,
    });
    const busy = item({ last_run: { match_id: 'm', state: 'succeeded', created_at: '2026-11-18T17:22:00Z' } });
    const rows = usageRows([quiet, busy]);
    expect(rows.map((r) => r.id)).toEqual(['p2', 'p1']);
    const by = (key: string) => [...rows].sort(USAGE_OPTIONS.compare![key]).map((r) => r.id);
    expect(by('tokens')).toEqual(['p2', 'p1']);
    expect(by('questions')).toEqual(['p2', 'p1']);
    expect(by('last_run')).toEqual(['p2', 'p1']);
    expect(by('project')).toEqual(['p2', 'p1']);
  });
});
