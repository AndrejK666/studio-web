'use strict';
// The VS Code side against the protocol's one source (ADR-0080 §4).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { CONTROL_V2, PROTOCOL, METHODS, CAPABILITIES, ALL_CAPABILITIES, EVENT_KINDS } = require('../protocol');

const protocol = JSON.parse(fs.readFileSync(
    process.env.IDE_BRIDGE_PROTOCOL || path.resolve(__dirname, '../../../../ide-bridge/protocol.json'), 'utf8'));

test('serves the v2 control path, header and token variable', () => {
    assert.equal(CONTROL_V2.path, protocol.control.v2.path);
    assert.equal(CONTROL_V2.header, protocol.control.v2.header.toLowerCase());
    assert.equal(CONTROL_V2.tokenEnv, protocol.control.v2.tokenEnv);
    assert.equal(PROTOCOL, protocol.protocol);
});

test('knows every control method and the capability each needs', () => {
    assert.deepEqual(METHODS, protocol.control.methods);
});

test('flags only capabilities the protocol has, and knows them all', () => {
    assert.deepEqual([...ALL_CAPABILITIES].sort(), [...protocol.capabilities].sort());
    for (const capability of CAPABILITIES) {
        assert.ok(protocol.capabilities.includes(capability), capability);
    }
});

test('the minimal VS Code set: no operations, kits, shared session, idle report, desktop or frame', () => {
    assert.deepEqual([...CAPABILITIES].sort(), ['notify', 'open_document', 'open_file', 'repositories']);
});

test('sends only the event kinds the protocol has', () => {
    assert.deepEqual([...EVENT_KINDS].sort(), [...protocol.events.kinds].sort());
    assert.ok(protocol.events.ingressHeaders.includes('X-CFS-Ide-Token'));
});
