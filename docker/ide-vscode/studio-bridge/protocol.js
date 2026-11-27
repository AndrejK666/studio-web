'use strict';
// The bridge's names on the VS Code side (ADR-0080 §4). Spelled once here and
// held against ide-bridge/protocol.json by test/protocol.test.js.

const CONTROL_V2 = Object.freeze({
    path: '/internal/ide/v2',
    header: 'x-cfs-ide-token',
    tokenEnv: 'STUDIO_IDE_CONTROL_TOKEN',
});

const PROTOCOL = 2;
const RUNTIME = 'vscode';

/** Which capability each control method needs (`null`: none). */
const METHODS = Object.freeze({
    getRuntimeStatus: null,
    getSession: null,
    getRepositories: 'repositories',
    enqueueOperation: 'operations',
    getOperationDeltas: 'operations',
    retryOperation: 'operations',
    openInEditor: 'open_file',
    openDocument: 'open_document',
    notifyEditor: 'notify',
    installKit: 'install_kit',
});

/** What a VS Code session does: the minimal set of ADR-0080 P2. */
const CAPABILITIES = Object.freeze(['open_file', 'open_document', 'notify', 'repositories']);

/** Every capability the protocol knows, for the sentences below. */
const ALL_CAPABILITIES = Object.freeze([
    'open_file', 'open_document', 'notify', 'repositories', 'operations',
    'install_kit', 'shared_session', 'idle_report', 'desktop', 'frame_channel',
]);

/** What a refusal says, per capability: "this IDE (VS Code) cannot …". */
const CANNOT = Object.freeze({
    operations: 'queue git operations; commit and push from its Source Control view',
    install_kit: 'install a kit',
    open_file: 'open a file',
    open_document: 'open a portal document',
    notify: 'show a notification',
    repositories: 'list its repositories',
});

const EVENT_KINDS = Object.freeze([
    'operation', 'audit', 'repositories-changed', 'workspace-snapshot-changed', 'workspace-activity', 'open-artifact',
]);

module.exports = { CONTROL_V2, PROTOCOL, RUNTIME, METHODS, CAPABILITIES, ALL_CAPABILITIES, CANNOT, EVENT_KINDS };
