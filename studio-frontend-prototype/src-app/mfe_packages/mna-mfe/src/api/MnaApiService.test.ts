import { describe, expect, it } from 'vitest';
import { MNA_API_BASE_URL, dealPath, evidencePath, ledgerPath } from './MnaApiService';

describe('MnaApiService paths', () => {
  it('lives on studio-kits behind the gateway', () => {
    expect(MNA_API_BASE_URL).toBe('/cf/studio-kits/v1');
  });

  it('scopes the deal and its evidence by the project', () => {
    expect(dealPath({ projectId: 'p-1' })).toBe('/mna/deal?project_id=p-1');
    expect(evidencePath({ projectId: 'p 1&x' })).toBe('/mna/evidence?project_id=p+1%26x');
  });

  it('names a ledger, and one of its records, escaped', () => {
    expect(ledgerPath('findings', 'p1')).toBe('/mna/findings?project_id=p1');
    expect(ledgerPath('risks', 'p1', 'r/1')).toBe('/mna/risks/r%2F1?project_id=p1');
    expect(ledgerPath('open-questions', 'p1', 'q1')).toBe('/mna/open-questions/q1?project_id=p1');
  });
});
