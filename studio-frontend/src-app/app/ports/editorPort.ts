/**
 * The shell's `editor.connect` port (ADR-0080 §4): how the editor's frame is
 * talked to. The shell knows the frame, the session, who is at the keyboard
 * and which artifact the editor should show; the kit that brings the IDE knows
 * the messages, their versions and whether the IDE hears its frame at all. The
 * shell asks it to open `{ kind, ref }` and never builds a message.
 */

import type { ArtifactAddress } from '@/app/mfe/screenLevels';

export type EditorTheme = 'light' | 'dark';

/** Who is at the keyboard. */
export interface EditorViewer {
  sub: string;
  name?: string;
  email?: string;
  kind: 'person';
}

/** What the IDE is greeted with, read afresh for every greeting so a late one carries what is current. */
export interface EditorGreeting {
  theme: EditorTheme;
  workspaceId: string;
  apiToken?: string;
  workspaceName?: string;
  viewer?: EditorViewer;
}

/**
 * The IDE the session runs and what it can do, as the backend's session says
 * (`ide`). `null`: a backend from before the field, whose only IDE could do
 * everything.
 */
export interface EditorRuntime {
  id: string;
  capabilities: readonly string[];
}

/** An artifact for the IDE to open, with how the editor's screen addresses its kind (`presentation.opens`). */
export interface EditorOpen {
  kind: string;
  /** The file's path from the workspace root (`path`), or the item's id (`workspace`). */
  ref: string;
  address: ArtifactAddress;
  /** The workspace that stores the item (`workspace` only). */
  workspaceId?: string;
  title?: string;
}

/** One studio-events event, as the shell's live channel hears it. */
export interface EditorLiveEvent {
  kind: string;
  subjectType: string;
  subjectId: string;
  payload: unknown;
}

/** What the shell hands the kit for one frame. */
export interface EditorConnection {
  frame: HTMLIFrameElement;
  /** The project whose session the frame shows. */
  projectId: string;
  runtime: EditorRuntime | null;
  greeting(): EditorGreeting;
  /** The IDE answered: once for each document the frame loads. */
  onAnswer(): void;
  /** The frame loaded again after an answer; its new document has not answered yet. */
  onReload(): void;
  /** The IDE asks the portal to open an artifact. */
  onOpenArtifact(kind: string, ref: string): void;
  /** Hears the live channel while the frame is connected; the returned function stops. */
  listen(listener: (event: EditorLiveEvent) => void): () => void;
}

/** The kit's side of one frame. */
export interface EditorChannel {
  open(target: EditorOpen): void;
  theme(theme: EditorTheme): void;
  /** A renewed token goes with the viewer: a token without one makes the IDE forget who is at the keyboard. */
  token(apiToken: string, viewer?: EditorViewer, workspaceName?: string): void;
  dispose(): void;
}

export type EditorConnect = (connection: EditorConnection) => EditorChannel;

/** Whether the runtime can do `capability`; an unknown runtime (older backend) can do everything. */
export function editorCan(runtime: EditorRuntime | null | undefined, capability: string): boolean {
  return !runtime || runtime.capabilities.includes(capability);
}
