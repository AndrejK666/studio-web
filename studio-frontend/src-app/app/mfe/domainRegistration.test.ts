/**
 * Registers the shell's domains on a REAL registry. `bootstrap.test.ts` mocks
 * `registerDomain`, so it cannot see the registry's own checks — the one that
 * refuses a domain declaring an action without a handler once took the whole
 * screen slot down (#319) with every unit test green.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFrontXApp,
  gtsPlugin,
} from '@gears-frontx/react';
import { SHELL_SCHEMAS } from './schemas';
import { bootstrapMFE } from './bootstrap';

// What main.tsx registers before constructing the app.
for (const schema of SHELL_SCHEMAS) gtsPlugin.registerSchema(schema);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('shell domains on a real registry', () => {
  it('register — every declared action has a handler, and every handler a declaration', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    );
    const app = createFrontXApp({ microfrontends: { typeSystem: gtsPlugin, mfeHandlers: [] } });

    await expect(bootstrapMFE(app)).resolves.toBeUndefined();
  });
});
