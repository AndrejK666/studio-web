// The IDE bridge's names on the Theia side (ADR-0080 §4).
//
// The protocol has one source, `ide-bridge/protocol.json` at the repository
// root. This image is built from `theia/` alone, so the file cannot be
// imported; its names are spelled here once and `ide-bridge-names.test.ts`
// holds the two together.

/** Control API, v1 (ADR-0022) and v2 (ADR-0080). Both are served. */
export const IDE_CONTROL = {
    v1: { path: '/internal/theia/v1', header: 'x-cfs-theia-token', tokenEnv: 'STUDIO_THEIA_S2S_TOKEN' },
    v2: { path: '/internal/ide/v2', header: 'x-cfs-ide-token', tokenEnv: 'STUDIO_IDE_CONTROL_TOKEN' },
} as const;

/** What this runtime can do. Theia does all of it. */
export const THEIA_CAPABILITIES = [
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

export const IDE_PROTOCOL_VERSION = 2;

/** The frame messages by role, in both spellings. */
export const FRAME_V1 = {
    init: 'studio.init',
    theme: 'studio.theme',
    token: 'studio.token',
    openInEditor: 'studio.openInEditor',
    openDocument: 'studio.openDocument',
    openProduct: 'studio.openProduct',
    openGear: 'studio.openGear',
    openGraph: 'studio.openGraph',
    notify: 'studio.notify',
    status: 'studio.status',
    documentSaved: 'studio.documentSaved',
    openComponent: 'studio.openComponent',
} as const;

export const FRAME_V2 = {
    init: 'ide.init',
    theme: 'ide.theme',
    token: 'ide.token',
    openInEditor: 'ide.openInEditor',
    openDocument: 'ide.openDocument',
    openProduct: 'ide.openProduct',
    openGear: 'ide.openGear',
    openGraph: 'ide.openGraph',
    notify: 'ide.notify',
    status: 'ide.status',
    documentSaved: 'ide.documentSaved',
    openArtifact: 'ide.openArtifact',
} as const;

export type FrameRole = keyof typeof FRAME_V1 | keyof typeof FRAME_V2;

/**
 * A portal message's role and the protocol version it was spoken in, or
 * `undefined` for a type this bridge does not take.
 */
export function readFrameType(type: string): { role: FrameRole; protocol: 1 | 2 } | undefined {
    for (const [role, name] of Object.entries(FRAME_V1)) {
        if (name === type) {
            return { role: role as FrameRole, protocol: 1 };
        }
    }
    for (const [role, name] of Object.entries(FRAME_V2)) {
        if (name === type) {
            return { role: role as FrameRole, protocol: 2 };
        }
    }
    return undefined;
}

/** The name of `role` in `protocol`, for a message the IDE posts. */
export function frameType(role: 'status' | 'documentSaved', protocol: 1 | 2): string {
    return protocol === 2 ? FRAME_V2[role] : FRAME_V1[role];
}
