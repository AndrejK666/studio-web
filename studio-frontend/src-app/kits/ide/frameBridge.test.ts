/**
 * The editor's postMessage channel against a stubbed frame: no IDE, no
 * browser navigation — a frame is an event target with a window to post to,
 * and the portal is the event target its messages arrive on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubFrame } from '@frontx-test-utils/stubFrame';
import type { EditorGreeting } from '@/app/ports/editorPort';
import { INIT_REPEAT_MS, connectFrameBridge, frameChannel } from './frameBridge';

const ORIGIN = 'https://portal.test';
const ADDRESS = `${ORIGIN}/studio/s1/?token=gate`;

const INIT: EditorGreeting = { theme: 'light', workspaceId: 'p1', apiToken: 'T1' };
const V2_INIT = { type: 'ide.init', protocol: 2, ...INIT };
const V1_INIT = { type: 'studio.init', ...INIT };

function connect(frame: HTMLIFrameElement, overrides: Partial<Parameters<typeof connectFrameBridge>[1]> = {}) {
  const options = {
    greeting: vi.fn(() => INIT),
    onAnswer: vi.fn(),
    onReload: vi.fn(),
    onOpenArtifact: vi.fn(),
    ...overrides,
  };
  return { bridge: connectFrameBridge(frame, options), options };
}

describe('connectFrameBridge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('greets in both versions until any bridge message answers, then stops', () => {
    const f = stubFrame(ADDRESS);
    const { options } = connect(f.frame);
    expect(f.sent()).toEqual([]);

    f.load();
    expect(f.sent()).toEqual([V2_INIT, V1_INIT]);
    vi.advanceTimersByTime(INIT_REPEAT_MS);
    expect(f.types()).toEqual(['ide.init', 'studio.init', 'ide.init', 'studio.init']);

    f.answer({ type: 'studio.status', dirty: 0 });
    expect(options.onAnswer).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(INIT_REPEAT_MS * 5);
    expect(f.types()).toHaveLength(4);

    // A later message is not a second answer.
    f.answer({ type: 'studio.status', dirty: 1 });
    expect(options.onAnswer).toHaveBeenCalledTimes(1);
  });

  it('speaks v2 to an IDE that answers in ide.*, and v1 to one that answers in studio.*', () => {
    const v2 = stubFrame(ADDRESS);
    const a = connect(v2.frame);
    v2.load();
    v2.answer({ type: 'ide.status', dirty: 0 });
    a.bridge.post({ role: 'theme', theme: 'dark' });
    expect(a.bridge.version()).toBe(2);
    expect(v2.sent().slice(-1)).toEqual([{ type: 'ide.theme', theme: 'dark' }]);

    const v1 = stubFrame(ADDRESS);
    const b = connect(v1.frame);
    v1.load();
    v1.answer({ type: 'studio.status', dirty: 0 });
    b.bridge.post({ role: 'theme', theme: 'dark' });
    expect(b.bridge.version()).toBe(1);
    expect(v1.sent().slice(-1)).toEqual([{ type: 'studio.theme', theme: 'dark' }]);
  });

  it('stops greeting an IDE that answers studio.init at once', () => {
    const f = stubFrame(ADDRESS, () => true);
    connect(f.frame);
    f.load();
    // ide.init went unanswered, studio.init was answered: no repeat follows.
    vi.advanceTimersByTime(INIT_REPEAT_MS * 3);
    expect(f.types()).toEqual(['ide.init', 'studio.init']);
  });

  it("posts to the frame's own origin only, never to `*`", () => {
    const f = stubFrame(ADDRESS);
    const { bridge } = connect(f.frame);

    f.load();
    f.answer({ type: 'studio.status', dirty: 0 });
    bridge.post({ role: 'theme', theme: 'dark' });

    expect(f.content.postMessage.mock.calls.map(([, target]) => target)).toEqual([ORIGIN, ORIGIN, ORIGIN]);
  });

  it('reads the greeting afresh for every repeat', () => {
    const f = stubFrame(ADDRESS);
    let token = 'T1';
    connect(f.frame, { greeting: () => ({ ...INIT, apiToken: token }) });

    f.load();
    token = 'T2';
    vi.advanceTimersByTime(INIT_REPEAT_MS);

    expect(f.sent().map((message) => message.apiToken)).toEqual(['T1', 'T1', 'T2', 'T2']);
  });

  it('holds the rest until the answer, only the latest of each role, then spells it in the answered version', () => {
    const f = stubFrame(ADDRESS);
    const { bridge } = connect(f.frame);

    bridge.post({ role: 'openInEditor', path: 'web/README.md' });
    bridge.post({ role: 'theme', theme: 'dark' });
    bridge.post({ role: 'openInEditor', path: 'web/src/main.ts' });
    f.load();
    f.answer({ type: 'ide.status', dirty: 0 });

    expect(f.sent()).toEqual([
      V2_INIT,
      V1_INIT,
      { type: 'ide.openInEditor', path: 'web/src/main.ts' },
      { type: 'ide.theme', theme: 'dark' },
    ]);

    bridge.post({ role: 'token', apiToken: 'T2' });
    expect(f.sent().slice(-1)).toEqual([{ type: 'ide.token', apiToken: 'T2' }]);
  });

  it('holds one open until the answer, the latest, whether a file or a document', () => {
    const f = stubFrame(ADDRESS);
    const { bridge } = connect(f.frame);

    bridge.post({ role: 'openInEditor', path: 'web/README.md' });
    bridge.post({ role: 'openDocument', workspaceId: 'w1', documentId: 'd1', title: 'Payments PRD' });
    f.load();
    f.answer({ type: 'studio.status', dirty: 0 });

    expect(f.sent()).toEqual([
      V2_INIT,
      V1_INIT,
      { type: 'studio.openDocument', workspaceId: 'w1', documentId: 'd1', title: 'Payments PRD' },
    ]);
  });

  it.each([
    ['another window', { type: 'studio.status', dirty: 0 }, { source: {} }],
    ['another origin', { type: 'ide.status', dirty: 0 }, { origin: 'https://evil.test' }],
    ['an opaque origin', { type: 'studio.status', dirty: 0 }, { origin: 'null' }],
    ['a message that is not the bridge’s', { type: 'webpackOk' }, {}],
    ['a message with no type', { dirty: 0 }, {}],
    ['a string', 'studio.status', {}],
  ])('takes %s for no answer', (_case, data, sender) => {
    const f = stubFrame(ADDRESS);
    const { bridge, options } = connect(f.frame);
    bridge.post({ role: 'openInEditor', path: 'web/README.md' });

    f.load();
    f.answer(data, sender);
    vi.advanceTimersByTime(INIT_REPEAT_MS);

    expect(options.onAnswer).not.toHaveBeenCalled();
    expect(f.types()).toEqual(['ide.init', 'studio.init', 'ide.init', 'studio.init']);
  });

  it('starts over when the frame loads again after an answer, greets in both again, and tells nothing twice', () => {
    const f = stubFrame(ADDRESS);
    const { bridge, options } = connect(f.frame);
    bridge.post({ role: 'openInEditor', path: 'web/README.md' });
    f.load();
    f.answer({ type: 'studio.status', dirty: 0 });

    f.load();
    expect(options.onReload).toHaveBeenCalledTimes(1);
    expect(bridge.version()).toBeNull();
    bridge.post({ role: 'theme', theme: 'dark' });
    expect(f.types()).toEqual(['ide.init', 'studio.init', 'studio.openInEditor', 'ide.init', 'studio.init']);

    // A new image behind the same address answers in v2.
    f.answer({ type: 'ide.status', dirty: 0 });
    expect(options.onAnswer).toHaveBeenCalledTimes(2);
    expect(f.types().slice(-1)).toEqual(['ide.theme']);
  });

  it("does not take the gate's splash reloading itself for an IDE that reloaded", () => {
    const f = stubFrame(ADDRESS);
    const { options } = connect(f.frame);

    f.load();
    f.load();
    f.load();

    expect(options.onReload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(INIT_REPEAT_MS);
    // One repeat running, not three: three loads and one repeat, two greetings each.
    expect(f.types()).toHaveLength(8);
  });

  it('hands an artifact request to the shell: ide.openArtifact, and studio.openComponent as a component', () => {
    const f = stubFrame(ADDRESS);
    const { options } = connect(f.frame);
    f.load();

    f.answer({ type: 'studio.openComponent', name: 'cf-gears-api-gateway' });
    f.answer({ type: 'studio.openComponent', name: '' });
    f.answer({ type: 'studio.openComponent' });
    f.answer({ type: 'ide.openArtifact', kind: 'component', ref: 'cf-gears-studio' });
    f.answer({ type: 'ide.openArtifact', kind: 'file' });

    expect(vi.mocked(options.onOpenArtifact).mock.calls).toEqual([
      ['component', 'cf-gears-api-gateway'],
      ['component', 'cf-gears-studio'],
    ]);
  });

  it('stops everything once disposed', () => {
    const f = stubFrame(ADDRESS);
    const { bridge, options } = connect(f.frame);
    f.load();

    bridge.dispose();
    vi.advanceTimersByTime(INIT_REPEAT_MS * 3);
    f.load();
    f.answer({ type: 'studio.status', dirty: 0 });

    expect(f.types()).toEqual(['ide.init', 'studio.init']);
    expect(options.onAnswer).not.toHaveBeenCalled();
  });
});

describe('frameChannel', () => {
  it('turns { kind, ref } into the open its address takes', () => {
    vi.useFakeTimers();
    const f = stubFrame(ADDRESS);
    const channel = frameChannel({
      frame: f.frame,
      projectId: 'p1',
      runtime: null,
      greeting: () => INIT,
      onAnswer: vi.fn(),
      onReload: vi.fn(),
      onOpenArtifact: vi.fn(),
      listen: () => () => undefined,
    });
    f.load();
    f.answer({ type: 'ide.status', dirty: 0 });

    channel.open({ kind: 'file', ref: 'web/README.md', address: 'path' });
    channel.open({ kind: 'document', ref: 'd1', address: 'workspace', workspaceId: 'w1', title: 'PRD' });
    channel.token('T2', { sub: 'u1', kind: 'person' }, 'Payments');

    expect(f.sent().slice(-3)).toEqual([
      { type: 'ide.openInEditor', path: 'web/README.md' },
      { type: 'ide.openDocument', workspaceId: 'w1', documentId: 'd1', title: 'PRD' },
      { type: 'ide.token', apiToken: 'T2', viewer: { sub: 'u1', kind: 'person' }, workspaceName: 'Payments' },
    ]);
    channel.dispose();
    vi.useRealTimers();
  });
});
