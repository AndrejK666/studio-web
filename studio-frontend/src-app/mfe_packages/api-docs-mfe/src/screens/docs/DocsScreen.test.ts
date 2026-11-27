import { describe, expect, it } from 'vitest';
import { SCALAR_URL, STORAGE_SHIM, viewerPage } from './DocsScreen';

describe("the viewer's page", () => {
  const doc = {
    paths: { '/studio-tasks/v1/runs': { get: { tags: ['StudioTasks'], summary: 'say </script> here' } } },
  };

  it('loads the pinned viewer and hands it the description grouped by gear', () => {
    const page = viewerPage(doc, false);
    expect(page).toContain(SCALAR_URL);
    expect(page).toContain('x-tagGroups');
    expect(page).toContain('Studio · Tasks');
  });

  it('never lets the description end its script', () => {
    const page = viewerPage(doc, true);
    // The storage shim, the viewer, and the call that starts it: three scripts, none ended early.
    expect(page.match(/<\/script>/g)).toHaveLength(3);
    expect(page).toContain('"darkMode":true');
  });

  // A sandboxed frame has no origin, so its localStorage throws: the viewer read it while
  // loading and never defined window.Scalar (walk 2026-11-17).
  // The frame has no origin, so the description's relative server read "null/cf" (walks 2026-11-17, -18).
  it("names the server at the portal's origin", () => {
    const page = viewerPage({ ...doc, servers: [{ url: '/cf' }] }, false, 'http://127.0.0.1:8081');
    expect(page).toContain('"servers":[{"url":"http://127.0.0.1:8081/cf"}]');
  });

  it('gives the frame storage before the viewer loads', () => {
    const page = viewerPage(doc, false);
    expect(page.indexOf(STORAGE_SHIM)).toBeGreaterThan(-1);
    expect(page.indexOf(STORAGE_SHIM)).toBeLessThan(page.indexOf(SCALAR_URL));
  });
});
