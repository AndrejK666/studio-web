import { afterEach, describe, expect, it, vi } from 'vitest';
import { STUDIO_ACTION_ARTIFACT_OPEN } from '@constructor-studio/mfe-shared';
import { createMfeBridgeFixture } from '../../../../__test-utils__/createMfeBridgeFixture';
import type { ArtifactRow } from '../model/artifact';
import { requestOpenArtifact } from './artifactActions';

const FILE: ArtifactRow = {
  id: 'node-1',
  kind: 'file',
  name: 'README.md',
  repository: 'group/repo',
  path: 'docs/README.md',
  url: 'https://forge.example/group/repo/-/blob/main/docs/README.md',
  sync: 'ingested',
  updatedAt: null,
  provenance: 'checkout',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('requestOpenArtifact', () => {
  it('tells the shell which artifact was asked for, and nothing else', () => {
    const { bridge, executeActionsChain } = createMfeBridgeFixture({
      domainId: 'screen',
      instanceId: 'inst',
    });

    requestOpenArtifact(bridge, 'proj-1', FILE);

    expect(executeActionsChain).toHaveBeenCalledTimes(1);
    const [chain] = executeActionsChain.mock.calls[0];
    expect(chain.action.type).toBe(STUDIO_ACTION_ARTIFACT_OPEN);
    // Exactly the five fields the schema names — no row-only data like the
    // forge url, which the shell does not need and the address must not carry.
    expect(chain.action.payload).toEqual({
      projectId: 'proj-1',
      artifactId: 'node-1',
      repository: 'group/repo',
      path: 'docs/README.md',
      kind: 'file',
    });
  });

  it('survives a chain the shell refuses — the screen stays up', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { bridge } = createMfeBridgeFixture({
      domainId: 'screen',
      instanceId: 'inst',
      executeActionsChain: vi
        .fn<ReturnType<typeof createMfeBridgeFixture>['bridge']['executeActionsChain']>()
        .mockRejectedValue(new Error('No handler for action target')),
    });

    expect(() => requestOpenArtifact(bridge, 'proj-1', FILE)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    // Logged, not swallowed: a refused request leaves a trace.
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('host action failed'),
      STUDIO_ACTION_ARTIFACT_OPEN,
      expect.any(Error)
    );
  });

  it('publishes nothing without a bridge', () => {
    expect(() => requestOpenArtifact(null, 'proj-1', FILE)).not.toThrow();
  });
});
