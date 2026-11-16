import { describe, expect, it } from 'vitest';
import type { KitContents } from '../api/KitsApiService';
import { archiveName, gearOf, gearsOf, readsOf, routeOf, writeRoutes } from './kitContents';

const EMPTY: KitContents = {
  screens: [],
  types: [],
  rules: [],
  functions: [],
  services: [],
  inbox: [],
  mcp_tools: [],
  permissions: { reads: [], writes: [], listens: [] },
  material: [],
  kinds: [],
  docs: [],
};

const RESEARCH: KitContents = {
  ...EMPTY,
  gears: [
    {
      gear: 'studio-environments',
      types: ['research-project'],
      mcp_tools: ['research_projects'],
      routes: ['POST /studio-environments/v1/research', 'POST /studio-environments/v1/research'],
      sync_only_with_kit: false,
    },
  ],
  permissions: {
    reads: ['GET /studio-environments/v1/research/projects', 'GET /studio-usage/v1/costs', 'gts.cf.studio.project.v1~'],
    writes: ['POST /studio-environments/v1/research'],
    listens: [],
  },
};

describe('kit contents', () => {
  it('splits a route and names its gear; a type is not a route', () => {
    expect(routeOf('GET /studio-usage/v1/costs')).toEqual({
      method: 'GET',
      path: '/studio-usage/v1/costs',
      gear: 'studio-usage',
    });
    expect(routeOf('gts.cf.studio.project.v1~')).toEqual({ method: '', path: 'gts.cf.studio.project.v1~', gear: null });
    expect(gearOf('/elsewhere')).toBeNull();
  });

  it('lists the claimed write routes once, with their gear', () => {
    expect(writeRoutes(RESEARCH)).toEqual([
      { method: 'POST', path: '/studio-environments/v1/research', gear: 'studio-environments' },
    ]);
    // A backend before ADR-0071 has no claims: none.
    expect(writeRoutes(EMPTY)).toEqual([]);
  });

  it('lists the reads, and the gears it claims of before the ones it only calls', () => {
    expect(readsOf(RESEARCH).map((r) => r.method)).toEqual(['GET', 'GET', '']);
    expect(gearsOf(RESEARCH)).toEqual([
      {
        gear: 'studio-environments',
        claims: true,
        calls: true,
        types: ['research-project'],
        tools: ['research_projects'],
      },
      { gear: 'studio-usage', claims: false, calls: true, types: [], tools: [] },
    ]);
  });

  it('names the archive as the server does: a commit shortened', () => {
    expect(archiveName({ slug: 'sdlc', default_version: '5c5b85c870cb4b62ed0506ae1a8ca196156d1c74' })).toBe(
      'sdlc-5c5b85c870cb.tar.gz'
    );
    expect(archiveName({ slug: 'org-costs', default_version: '0.4.0' })).toBe('org-costs-0.4.0.tar.gz');
  });
});
