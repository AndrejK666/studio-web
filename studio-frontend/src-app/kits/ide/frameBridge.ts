// @cpt-algo:cpt-studiofrontend-algo-editor-bridge-handshake:p1
// @cpt-state:cpt-studiofrontend-state-editor-bridge:p1
// @cpt-dod:cpt-studiofrontend-dod-editor-bridge-handshake:p1
// @cpt-dod:cpt-studiofrontend-dod-editor-bridge-sender:p1
/**
 * The portal's half of the editor's `postMessage` channel
 * (docs/theia-bridge-contract-v1.md §6, ADR-0080 §4), for an IDE that hears
 * its frame (`frame_channel`).
 *
 * It knows one frame and the messages, in both versions, and nothing of the
 * shell: what to say is handed in through the `editor.connect` port. It reads
 * no `location` either: the frame is another realm, and its origin is the one
 * of its own `src`.
 *
 * **Versions.** Until the IDE answers, every greeting goes out twice, as
 * `ide.init` (with `protocol: 2`) and as `studio.init`. The first answer pins
 * the version for the rest of that frame load: an IDE that answers in `ide.*`
 * is told everything in `ide.*`, an older one in `studio.*`. A reload greets in
 * both again, since a new image may be behind the same address.
 */

import { onFrameMessage } from '@constructor-studio/mfe-shared';
import type { EditorChannel, EditorConnection, EditorTheme, EditorViewer } from '@/app/ports/editorPort';
import { FRAME_V1, FRAME_V2, FRAMES, PREFIX, type ProtocolVersion } from './protocol';

/** What the bridge says, by role; spelled in the pinned version when it goes out. */
export type Outgoing =
  | { role: 'theme'; theme: EditorTheme }
  | { role: 'token'; apiToken: string; viewer?: EditorViewer; workspaceName?: string }
  | { role: 'openInEditor'; path: string }
  | { role: 'openDocument'; workspaceId: string; documentId: string; title?: string };

/**
 * How often the greeting goes out until it is answered. The IDE listens only
 * once its session has answered over the websocket and drops what came
 * before, and until the IDE binds its port the frame shows the gate's splash.
 */
export const INIT_REPEAT_MS = 2_000;

/** The messages that open something: they wait for the answer in one place, so only the latest is told. */
const OPENS: ReadonlySet<Outgoing['role']> = new Set(['openInEditor', 'openDocument']);

type Hooks = Pick<EditorConnection, 'greeting' | 'onAnswer' | 'onReload' | 'onOpenArtifact'>;

export function connectFrameBridge(frame: HTMLIFrameElement, hooks: Hooks) {
  // Every document the frame shows is on its address's origin: the gate
  // redirects relatively, and serves its splash at the same address.
  const origin = new URL(frame.src).origin;
  const waiting = new Map<Outgoing['role'] | 'open', Outgoing>();
  let version: ProtocolVersion | null = null;
  let repeat: ReturnType<typeof setInterval> | undefined;

  // Never `*`: the greeting carries the member's token.
  const send = (message: object): void => frame.contentWindow?.postMessage(message, origin);
  const spell = (v: ProtocolVersion, { role, ...rest }: Outgoing): object => ({ type: FRAMES[v][role], ...rest });
  const greet = (): void => {
    const greeting = hooks.greeting();
    // v2 first, so an IDE that speaks both settles on it; v1 only while nothing answered.
    send({ type: FRAME_V2.init, protocol: 2, ...greeting });
    if (version === null) send({ type: FRAME_V1.init, ...greeting });
  };

  const onLoad = (): void => {
    // A new document whose bridge has not answered: the gate's splash, the
    // IDE, or the IDE again after a reload. What it was told before is not
    // told again — a reloaded IDE restores its own layout.
    if (version !== null) {
      version = null;
      hooks.onReload();
    }
    clearInterval(repeat);
    // Armed first: an answer to this very greeting stops it.
    repeat = setInterval(greet, INIT_REPEAT_MS);
    greet();
  };

  const onData = (data: unknown): void => {
    const message = (data ?? {}) as { type?: unknown; name?: unknown; kind?: unknown; ref?: unknown };
    const { type } = message;
    if (typeof type !== 'string') return;
    const spoken: ProtocolVersion | null = type.startsWith(PREFIX[2]) ? 2 : type.startsWith(PREFIX[1]) ? 1 : null;
    if (spoken === null) return;
    if (version === null) {
      // Any message of the bridge is the answer: the IDE replies to the first
      // greeting it takes, and to no repeat of it.
      version = spoken;
      clearInterval(repeat);
      waiting.forEach((m) => send(spell(spoken, m)));
      waiting.clear();
      hooks.onAnswer();
    }
    if (type === FRAME_V2.openArtifact) {
      const { kind, ref } = message;
      if (typeof kind === 'string' && kind && typeof ref === 'string' && ref) hooks.onOpenArtifact(kind, ref);
      return;
    }
    if (type === FRAME_V1.openComponent) {
      const { name } = message;
      if (typeof name === 'string' && name.length > 0) hooks.onOpenArtifact('component', name);
    }
  };

  frame.addEventListener('load', onLoad);
  // Only the frame's own window, from its own origin.
  const stopListening = onFrameMessage(frame, origin, onData);

  return {
    /** The version the IDE answered in, `null` until it has. */
    version: (): ProtocolVersion | null => version,
    /** Sent at once after the answer; until then only the latest of each role waits, and one open of either kind. */
    post(message: Outgoing): void {
      if (version !== null) {
        send(spell(version, message));
        return;
      }
      // A file or a document switched twice before the answer opens one tab, not two.
      waiting.set(OPENS.has(message.role) ? 'open' : message.role, message);
    },
    dispose(): void {
      clearInterval(repeat);
      waiting.clear();
      frame.removeEventListener('load', onLoad);
      stopListening();
    },
  };
}

/** The `editor.connect` channel for an IDE that hears its frame. */
export function frameChannel(connection: EditorConnection): EditorChannel {
  const bridge = connectFrameBridge(connection.frame, connection);
  return {
    open(target) {
      if (target.address === 'workspace' && target.workspaceId) {
        bridge.post({
          role: 'openDocument',
          workspaceId: target.workspaceId,
          documentId: target.ref,
          ...(target.title ? { title: target.title } : {}),
        });
      } else if (target.address === 'path') {
        bridge.post({ role: 'openInEditor', path: target.ref });
      }
    },
    theme: (theme) => bridge.post({ role: 'theme', theme }),
    token: (apiToken, viewer, workspaceName) => bridge.post({ role: 'token', apiToken, viewer, workspaceName }),
    dispose: () => bridge.dispose(),
  };
}
