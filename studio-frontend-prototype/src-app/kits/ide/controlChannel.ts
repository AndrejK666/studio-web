/**
 * The `editor.connect` channel for an IDE that does not hear its frame
 * (no `frame_channel`, ADR-0080 §4: VS Code). Nothing is posted into the
 * frame. Opens go through the backend's control channel instead
 * (`/studio-theia/v1/workspaces/{id}/open`, `…/documents/open`), and the IDE's
 * own requests come back on studio-events as `ide.open-artifact`.
 *
 * Theme, token and viewer are not sent: such an IDE keeps its own theme, and
 * no personal token is handed to it (ADR-0030 §1).
 */

import { apiRegistry } from '@gears-frontx/react';
import type { EditorChannel, EditorConnection, EditorOpen } from '@/app/ports/editorPort';
import { editorCan } from '@/app/ports/editorPort';
import { OPEN_ARTIFACT_EVENT } from './protocol';
import { IdeControlApiService } from './ideControlApi';

/** How often an open is tried while the IDE behind the frame is still coming up, and how long apart. */
export const OPEN_ATTEMPTS = 5;
export const OPEN_RETRY_MS = 3_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The artifact request inside an `ide.open-artifact` event's payload. */
function requested(payload: unknown): { kind: string; ref: string } | null {
  const event = (payload as { event?: { kind?: unknown; ref?: unknown } } | null)?.event;
  const kind = event?.kind;
  const ref = event?.ref;
  return typeof kind === 'string' && kind && typeof ref === 'string' && ref ? { kind, ref } : null;
}

export function controlChannel(connection: EditorConnection): EditorChannel {
  const { frame, projectId, runtime } = connection;
  let disposed = false;
  /** The latest open: a newer one replaces one still being tried. */
  let latest = 0;

  const call = async (target: EditorOpen): Promise<void> => {
    const api = apiRegistry.getService(IdeControlApiService);
    if (target.address === 'path') {
      await api.openFile(projectId).fetch({ relativePath: target.ref, preview: false });
    } else if (target.workspaceId) {
      await api.openDocument(projectId).fetch({
        workspaceId: target.workspaceId,
        documentId: target.ref,
        ...(target.title ? { title: target.title } : {}),
      });
    }
  };

  const open = async (target: EditorOpen): Promise<void> => {
    const capability = target.address === 'path' ? 'open_file' : 'open_document';
    if (!editorCan(runtime, capability)) {
      console.info(`[ide] this IDE cannot open a ${target.kind}`);
      return;
    }
    latest += 1;
    const mine = latest;
    for (let attempt = 1; attempt <= OPEN_ATTEMPTS; attempt += 1) {
      if (disposed || mine !== latest) return;
      try {
        await call(target);
        return;
      } catch (error) {
        // The IDE behind the frame may not have started its extension yet.
        if (attempt === OPEN_ATTEMPTS) console.warn('[ide] the IDE could not be told to open it:', error);
        else await sleep(OPEN_RETRY_MS);
      }
    }
  };

  // No answer comes through the frame: a loaded document is the IDE (or the
  // gate's splash, which reloads itself into it).
  const onLoad = (): void => connection.onAnswer();
  frame.addEventListener('load', onLoad);

  const stopListening = connection.listen((event) => {
    if (event.kind !== OPEN_ARTIFACT_EVENT || event.subjectId !== projectId) return;
    const request = requested(event.payload);
    if (request) connection.onOpenArtifact(request.kind, request.ref);
  });

  return {
    open: (target) => void open(target),
    theme: () => undefined,
    token: () => undefined,
    dispose() {
      disposed = true;
      frame.removeEventListener('load', onLoad);
      stopListening();
    },
  };
}
