/**
 * The kit's names are the protocol's (ADR-0080 §4): every message, capability
 * and event the ide kit spells is in `ide-bridge/protocol.json`, the one file
 * the backend, the Theia side and the VS Code extension test against too.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAPABILITIES, CONTROL_API_BASE_URL, FRAME_V1, FRAME_V2, OPEN_ARTIFACT_EVENT, PREFIX } from './protocol';

const PROTOCOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../ide-bridge/protocol.json');

interface Protocol {
  protocol: number;
  capabilities: string[];
  events: { v2Prefix: string; v1Prefix: string; kinds: string[] };
  frame: { v1: Record<string, string>; v2: Record<string, string> };
}

const protocol = JSON.parse(fs.readFileSync(PROTOCOL, 'utf8')) as Protocol;

describe('the ide kit speaks ide-bridge/protocol.json', () => {
  it('is protocol 2', () => {
    expect(protocol.protocol).toBe(2);
  });

  it('names every v1 frame message as the protocol does', () => {
    for (const [role, name] of Object.entries(FRAME_V1)) expect(protocol.frame.v1[role], role).toBe(name);
  });

  it('names every v2 frame message as the protocol does', () => {
    for (const [role, name] of Object.entries(FRAME_V2)) expect(protocol.frame.v2[role], role).toBe(name);
  });

  it('tells the versions apart by their prefixes', () => {
    expect(PREFIX[2]).toBe(protocol.events.v2Prefix);
    for (const name of Object.values(protocol.frame.v2)) expect(name.startsWith(PREFIX[2])).toBe(true);
    for (const name of Object.values(protocol.frame.v1)) expect(name.startsWith(PREFIX[1])).toBe(true);
  });

  it('knows exactly the protocol capabilities', () => {
    expect([...CAPABILITIES].sort()).toEqual([...protocol.capabilities].sort());
  });

  it('listens for the open-artifact event as the backend republishes it', () => {
    expect(protocol.events.kinds).toContain('open-artifact');
    expect(OPEN_ARTIFACT_EVENT).toBe(`${protocol.events.v2Prefix}open-artifact`);
  });

  it("calls the IDE bridge gear's REST", () => {
    expect(CONTROL_API_BASE_URL).toBe('/cf/studio-theia/v1');
  });
});
