/**
 * The frame messages of the IDE bridge, both versions (ADR-0080 §4). The names
 * are `ide-bridge/protocol.json`'s, at the repository root; `protocol.test.ts`
 * holds the two together, so a name changes there first.
 *
 * v1 is `studio.*` (Theia before ADR-0080), v2 is `ide.*`. A frame load speaks
 * one of them: the bridge greets in both and keeps the one the IDE answers in.
 */

export type ProtocolVersion = 1 | 2;

/** The messages the portal sends or reads, by role. */
export interface FrameNames {
  init: string;
  theme: string;
  token: string;
  openInEditor: string;
  openDocument: string;
  status: string;
  documentSaved: string;
}

export const FRAME_V1: FrameNames & { openComponent: string } = {
  init: 'studio.init',
  theme: 'studio.theme',
  token: 'studio.token',
  openInEditor: 'studio.openInEditor',
  openDocument: 'studio.openDocument',
  status: 'studio.status',
  documentSaved: 'studio.documentSaved',
  /** v1's one artifact request: a component, by catalogue name. */
  openComponent: 'studio.openComponent',
};

export const FRAME_V2: FrameNames & { openArtifact: string } = {
  init: 'ide.init',
  theme: 'ide.theme',
  token: 'ide.token',
  openInEditor: 'ide.openInEditor',
  openDocument: 'ide.openDocument',
  status: 'ide.status',
  documentSaved: 'ide.documentSaved',
  /** The IDE asks the portal to open an artifact, `{ kind, ref }`. */
  openArtifact: 'ide.openArtifact',
};

export const FRAMES: Record<ProtocolVersion, FrameNames> = { 1: FRAME_V1, 2: FRAME_V2 };

/** The prefix each version's messages carry. */
export const PREFIX: Record<ProtocolVersion, string> = { 1: 'studio.', 2: 'ide.' };

/**
 * The capability flags a runtime declares (`ide.capabilities` on the session).
 * A session without the field is an older backend's: Theia, all of them.
 */
export const CAPABILITIES = [
  'open_file',
  'open_document',
  'notify',
  'repositories',
  'operations',
  'install_kit',
  'shared_session',
  'idle_report',
  'desktop',
  'frame_channel',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** The studio-events type the backend republishes an IDE's artifact request as (v2 events). */
export const OPEN_ARTIFACT_EVENT = 'ide.open-artifact';

/** The control calls the portal makes through the backend when the frame has no channel. */
export const CONTROL_API_BASE_URL = '/cf/studio-theia/v1';
