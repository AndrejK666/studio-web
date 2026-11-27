import { describe, expect, it } from 'vitest';
import { readsThroughModel } from './ArtifactIngestApiService';

describe('readsThroughModel', () => {
  it('takes a listing of one kind the model holds, in a known organization', () => {
    expect(readsThroughModel({ scope: 'p1', type: 'repo', limit: 200, orgId: 'o1' })).toBe(true);
    expect(readsThroughModel({ scope: 'p1', type: 'workflow_run', q: 'ann', orgId: 'o1' })).toBe(true);
  });

  it('leaves the gear its own paging, the other kinds and an unknown organization', () => {
    expect(readsThroughModel({ scope: 'p1', type: 'repo', limit: 200 })).toBe(false);
    expect(readsThroughModel({ scope: 'p1', limit: 1, orgId: 'o1' })).toBe(false);
    expect(readsThroughModel({ scope: 'p1', type: 'issue', orgId: 'o1' })).toBe(false);
    expect(readsThroughModel({ scope: 'p1', type: 'repo', repo: 'r1', orgId: 'o1' })).toBe(false);
    expect(readsThroughModel({ scope: 'p1', type: 'repo', offset: 50, orgId: 'o1' })).toBe(false);
  });
});
