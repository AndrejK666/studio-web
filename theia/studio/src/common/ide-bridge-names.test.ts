import * as fs from 'fs';
import * as path from 'path';
import {
    FRAME_V1, FRAME_V2, IDE_CONTROL, IDE_PROTOCOL_VERSION, THEIA_CAPABILITIES, frameType, readFrameType
} from './ide-bridge-names';

/**
 * The Theia side against the protocol's one source (ADR-0080 §4). The image is
 * built from `theia/` alone; a test run mounts the repository's `ide-bridge/`
 * beside it (`/ide-bridge` in the container), which is where this looks.
 */
const protocol = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../../../ide-bridge/protocol.json'), 'utf8'
));

describe('the Theia side speaks ide-bridge/protocol.json', () => {
    it('serves the protocol version the file names', () => {
        expect(IDE_PROTOCOL_VERSION).toBe(protocol.protocol);
    });

    it('serves both control paths, headers and token variables', () => {
        for (const version of ['v1', 'v2'] as const) {
            expect(IDE_CONTROL[version].path).toBe(protocol.control[version].path);
            expect(IDE_CONTROL[version].header).toBe(protocol.control[version].header.toLowerCase());
            expect(IDE_CONTROL[version].tokenEnv).toBe(protocol.control[version].tokenEnv);
        }
    });

    it('flags every capability, each one the file knows', () => {
        expect([...THEIA_CAPABILITIES].sort()).toEqual([...protocol.capabilities].sort());
    });

    it('spells the frame messages as the file does, in both versions', () => {
        expect(FRAME_V1).toEqual(protocol.frame.v1);
        expect(FRAME_V2).toEqual(protocol.frame.v2);
    });

    it('reads either spelling and answers in the one it was spoken', () => {
        expect(readFrameType('studio.init')).toEqual({ role: 'init', protocol: 1 });
        expect(readFrameType('ide.init')).toEqual({ role: 'init', protocol: 2 });
        expect(readFrameType('ide.openComponent')).toBeUndefined();
        expect(readFrameType('studio.unknown')).toBeUndefined();
        expect(frameType('status', 1)).toBe('studio.status');
        expect(frameType('status', 2)).toBe('ide.status');
    });
});
