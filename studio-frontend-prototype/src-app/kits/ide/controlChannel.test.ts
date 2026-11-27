/**
 * The channel for an IDE that does not hear its frame (VS Code): opens go to
 * the backend's control channel, the IDE's requests come back on studio-events.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubFrame } from '@frontx-test-utils/stubFrame';
import type { EditorConnection, EditorLiveEvent, EditorRuntime } from '@/app/ports/editorPort';

const { openFile, openDocument } = vi.hoisted(() => ({ openFile: vi.fn(), openDocument: vi.fn() }));

vi.mock('@gears-frontx/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gears-frontx/react')>();
  return {
    ...actual,
    apiRegistry: {
      getService: () => ({
        openFile: (ws: string) => ({ fetch: (body: unknown) => openFile(ws, body) }),
        openDocument: (ws: string) => ({ fetch: (body: unknown) => openDocument(ws, body) }),
      }),
    },
  };
});

import { OPEN_ATTEMPTS, OPEN_RETRY_MS, controlChannel } from './controlChannel';

const VSCODE: EditorRuntime = { id: 'vscode', capabilities: ['open_file', 'open_document', 'notify', 'repositories'] };

function connect(runtime: EditorRuntime = VSCODE) {
  const f = stubFrame('https://portal.test/studio/s1/?token=gate');
  let listener: ((event: EditorLiveEvent) => void) | null = null;
  const connection: EditorConnection = {
    frame: f.frame,
    projectId: 'p1',
    runtime,
    greeting: () => ({ theme: 'dark', workspaceId: 'p1', apiToken: 'T1' }),
    onAnswer: vi.fn(),
    onReload: vi.fn(),
    onOpenArtifact: vi.fn(),
    listen: (l) => {
      listener = l;
      return () => {
        listener = null;
      };
    },
  };
  const channel = controlChannel(connection);
  return {
    f,
    channel,
    connection,
    hear: (event: EditorLiveEvent) => listener?.(event),
    listening: () => listener !== null,
  };
}

describe('controlChannel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    openFile.mockReset().mockResolvedValue({ opened: true });
    openDocument.mockReset().mockResolvedValue({ opened: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts nothing into the frame, and takes a loaded frame for the answer', () => {
    const { f, channel, connection } = connect();
    f.load();
    channel.theme('light');
    channel.token('T2', { sub: 'u1', kind: 'person' });
    channel.open({ kind: 'file', ref: 'web/README.md', address: 'path' });
    expect(f.sent()).toEqual([]);
    expect(connection.onAnswer).toHaveBeenCalledTimes(1);
  });

  it('opens a file and a document through the backend', async () => {
    const { channel } = connect();
    channel.open({ kind: 'file', ref: 'web/README.md', address: 'path' });
    await vi.runAllTimersAsync();
    channel.open({ kind: 'document', ref: 'd1', address: 'workspace', workspaceId: 'w1', title: 'PRD' });
    await vi.runAllTimersAsync();
    expect(openFile).toHaveBeenCalledWith('p1', { relativePath: 'web/README.md', preview: false });
    expect(openDocument).toHaveBeenCalledWith('p1', { workspace_id: 'w1', document_id: 'd1', title: 'PRD' });
  });

  it('tries again while the IDE comes up, and gives up after the last attempt', async () => {
    openFile.mockRejectedValue(new Error('503'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { channel } = connect();
    channel.open({ kind: 'file', ref: 'a.md', address: 'path' });
    await vi.advanceTimersByTimeAsync(OPEN_RETRY_MS * OPEN_ATTEMPTS);
    expect(openFile).toHaveBeenCalledTimes(OPEN_ATTEMPTS);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('asks nothing a runtime cannot do', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { channel } = connect({ id: 'vscode', capabilities: [] });
    channel.open({ kind: 'document', ref: 'd1', address: 'workspace', workspaceId: 'w1' });
    await vi.runAllTimersAsync();
    expect(openDocument).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it("hands the IDE's ide.open-artifact for its own workspace to the shell, and stops hearing once disposed", () => {
    const { connection, hear, channel, listening } = connect();
    hear({
      kind: 'ide.open-artifact',
      subjectType: 'workspace',
      subjectId: 'p2',
      payload: { event: { kind: 'component', ref: 'x' } },
    });
    hear({ kind: 'theia.operation', subjectType: 'workspace', subjectId: 'p1', payload: {} });
    hear({
      kind: 'ide.open-artifact',
      subjectType: 'workspace',
      subjectId: 'p1',
      payload: { event: { kind: 'component', ref: 'gw' } },
    });
    expect(connection.onOpenArtifact).toHaveBeenCalledTimes(1);
    expect(connection.onOpenArtifact).toHaveBeenCalledWith('component', 'gw');
    channel.dispose();
    expect(listening()).toBe(false);
  });
});
