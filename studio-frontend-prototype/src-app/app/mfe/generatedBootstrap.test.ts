/**
 * Bootstraps the GENERATED manifest aggregate on a REAL registry, the way the
 * running shell does. overlayContract.test.ts validates each instance against
 * its schema, which registerExtension does too — but registerExtension checks
 * more (an entry against the domain it is placed in), and a failure there
 * leaves the shell with no screens at all while every unit test is green.
 * Needs a build: public/generated-mfe-manifests.json is its output.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFrontX, gtsPlugin, microfrontends, presets } from '@gears-frontx/react';
import { SHELL_SCHEMAS } from './schemas';
import { bootstrapMFE } from './bootstrap';

const AGGREGATE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../public/generated-mfe-manifests.json'
);

for (const schema of SHELL_SCHEMAS) gtsPlugin.registerSchema(schema);

afterEach(() => vi.restoreAllMocks());

describe.skipIf(!existsSync(AGGREGATE))('the generated manifests on a real registry', () => {
  it('bootstrap without an error', async () => {
    const body = readFileSync(AGGREGATE, 'utf8');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
    );
    const app = createFrontX().useAll(presets.full()).use(microfrontends({ typeSystem: gtsPlugin })).build();
    await expect(bootstrapMFE(app)).resolves.toBeUndefined();
  });
});
