'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { test } = require('node:test');
const { createControl } = require('../control');
const { createControlServer } = require('../server');
const { createWindowChannel, connectWindow } = require('../channel');
const { envelope, ingressUrl, createEventSender } = require('../events');
const { documentUri } = require('../documents');

const TOKEN = 'control-token';
const headers = { 'x-cfs-ide-token': TOKEN };

function workspace() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-bridge-'));
    fs.mkdirSync(path.join(root, 'docs', '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'README.md'), '# hi');
    fs.mkdirSync(path.join(root, 'api', '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, 'plain'));
    return root;
}

function fakeWindows(answers = []) {
    const calls = [];
    return {
        calls,
        count: () => answers.length,
        broadcast: async (method, params) => { calls.push({ method, params }); return answers.map(a => a(method, params)); },
    };
}

const env = { STUDIO_WORKSPACE_ID: 'ws-1', STUDIO_ACTOR_ID: 'svc', STUDIO_GIT_MODE: 'commit', STUDIO_MANAGED_WORKSPACE: '1' };

test('refuses a call without the token, or with another', async () => {
    const control = createControl({ token: TOKEN, root: workspace(), env, windows: fakeWindows() });
    assert.equal((await control.handle('getRuntimeStatus', {}, {})).status, 401);
    assert.equal((await control.handle('getRuntimeStatus', { 'x-cfs-ide-token': 'other' }, {})).status, 401);
    const shut = createControl({ token: '', root: workspace(), env, windows: fakeWindows() });
    assert.equal((await shut.handle('getRuntimeStatus', { 'x-cfs-ide-token': '' }, {})).status, 401);
});

test('says which IDE it is and what it can do', async () => {
    const control = createControl({ token: TOKEN, root: workspace(), env, windows: fakeWindows([() => ({})]) });
    const { status, json } = await control.handle('getRuntimeStatus', headers, {});
    assert.equal(status, 200);
    assert.equal(json.runtime, 'vscode');
    assert.equal(json.protocol, 2);
    assert.equal(json.ready, true);
    assert.equal(json.activeClients, 1);
    assert.equal(json.workspaceMode, 'managed');
    assert.deepEqual(json.capabilities, ['open_file', 'open_document', 'notify', 'repositories']);
    assert.equal('idleSecs' in json, false, 'no idle report: VS Code cannot tell a browser is open');
});

test('answers what it cannot do as a sentence, with 501', async () => {
    const control = createControl({ token: TOKEN, root: workspace(), env, windows: fakeWindows() });
    for (const method of ['enqueueOperation', 'getOperationDeltas', 'retryOperation', 'installKit']) {
        const { status, json } = await control.handle(method, headers, {});
        assert.equal(status, 501, method);
        assert.equal(json.unsupported, true);
        assert.match(json.error, /^this IDE \(VS Code\) cannot /);
    }
    assert.equal((await control.handle('dropDatabase', headers, {})).status, 404);
});

test('session and repositories come from the env and the disk', async () => {
    const root = workspace();
    const control = createControl({ token: TOKEN, root, env, windows: fakeWindows() });
    const session = (await control.handle('getSession', headers, {})).json;
    assert.deepEqual(session, { actorId: 'svc', workspaceId: 'ws-1', workspaceRootName: path.basename(root), gitMode: 'commit' });
    const repositories = (await control.handle('getRepositories', headers, {})).json;
    assert.deepEqual(repositories.map(r => [r.label, r.kind, r.gitMode]), [['api', 'source', 'commit'], ['docs', 'source', 'commit']]);
    assert.ok(repositories.every(r => /^repo-[0-9a-f]{16}$/.test(r.repositoryId)));
});

test('opens a file by its path from the root, or one level below, and never outside', async () => {
    const root = workspace();
    const windows = fakeWindows([() => ({ opened: true })]);
    const control = createControl({ token: TOKEN, root, env, windows });
    assert.deepEqual((await control.handle('openInEditor', headers, { relativePath: 'docs/README.md' })).json,
        { opened: true, resolvedRelativePath: 'docs/README.md' });
    assert.deepEqual((await control.handle('openInEditor', headers, { relativePath: 'README.md' })).json,
        { opened: true, resolvedRelativePath: 'docs/README.md' });
    assert.deepEqual((await control.handle('openInEditor', headers, { relativePath: '../etc/passwd' })).json, { opened: false });
    assert.deepEqual((await control.handle('openInEditor', headers, { relativePath: 'missing.md' })).json, { opened: false });
    assert.equal(windows.calls.length, 2);
    assert.equal(windows.calls[0].params.path, path.join(root, 'docs', 'README.md'));
});

test('with no window open, nothing is opened or shown', async () => {
    const control = createControl({ token: TOKEN, root: workspace(), env, windows: fakeWindows([]) });
    assert.equal((await control.handle('openInEditor', headers, { relativePath: 'docs/README.md' })).json.opened, false);
    assert.equal((await control.handle('notifyEditor', headers, { message: 'hi' })).json.shown, false);
    assert.equal((await control.handle('openDocument', headers, { workspaceId: 'w', documentId: 'd' })).json.opened, false);
});

test('a document goes to the window with its content; a notification with a safe link only', async () => {
    const windows = fakeWindows([() => ({ opened: true, shown: true })]);
    const control = createControl({ token: TOKEN, root: workspace(), env, windows });
    assert.deepEqual((await control.handle('openDocument', headers,
        { workspaceId: 'w1', documentId: 'd1', title: 'Spec', content: '# Spec' })).json, { opened: true });
    assert.deepEqual(windows.calls[0].params, { workspaceId: 'w1', documentId: 'd1', title: 'Spec', content: '# Spec' });
    assert.deepEqual((await control.handle('openDocument', headers, { workspaceId: 'w1' })).json, { opened: false });
    assert.deepEqual((await control.handle('notifyEditor', headers,
        { level: 'warning', message: 'm', link: 'javascript:alert(1)' })).json, { shown: true });
    assert.equal(windows.calls[1].params.level, 'warn');
    assert.equal(windows.calls[1].params.link, undefined);
});

test('a portal document has the address Theia gives it', () => {
    assert.equal(documentUri('w1', 'd1', 'My Spec: v2'), 'studio-doc:/w1/d1/my-spec-v2.md');
    assert.equal(documentUri('w1', 'd1'), 'studio-doc:/w1/d1/document.md');
});

test('events go to the ingress with the v2 header, the payload in `event`', async () => {
    assert.equal(ingressUrl({ STUDIO_GATEWAY_URL: 'http://gw/cf/' }), 'http://gw/cf/studio-theia/v1/events');
    assert.equal(ingressUrl({ STUDIO_IDE_EVENT_INGRESS_URL: 'http://x/e', STUDIO_GATEWAY_URL: 'http://gw' }), 'http://x/e');
    assert.deepEqual(envelope({ STUDIO_WORKSPACE_ID: 'w' }, 'open-artifact', { kind: 'component', ref: 'c' }),
        { session: { workspaceId: 'w' }, kind: 'open-artifact', event: { kind: 'component', ref: 'c' } });
    const sent = [];
    const send = createEventSender({ STUDIO_GATEWAY_URL: 'http://gw', STUDIO_IDE_CONTROL_TOKEN: 't', STUDIO_WORKSPACE_ID: 'w' },
        async (url, init) => { sent.push({ url, init }); return { ok: true, status: 200 }; }, { warn: () => undefined });
    assert.equal(await send('open-artifact', { kind: 'component', ref: 'c' }), true);
    assert.equal(await send('made-up', {}), false);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].init.headers['X-CFS-Ide-Token'], 't');
    assert.equal(JSON.parse(sent[0].init.body).event.ref, 'c');
});

test('end to end: HTTP control call → channel → a window, and a window event out', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-bridge-sock-'));
    const socket = path.join(dir, 'bridge.sock');
    const events = [];
    const windows = createWindowChannel(socket, (kind, payload) => events.push({ kind, payload }), 1000);
    await windows.listening;
    const opened = [];
    const win = connectWindow(socket, async (method, params) => { opened.push([method, params.path]); return { opened: true }; });
    await win.connected;
    for (let i = 0; i < 50 && windows.count() === 0; i += 1) await new Promise(r => setTimeout(r, 10));
    const root = workspace();
    const server = createControlServer(createControl({ token: TOKEN, root, env, windows }));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const post = (method, body, hdrs) => new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST',
            path: `/internal/ide/v2/${method}`, headers: { 'content-type': 'application/json', ...hdrs } }, (res) => {
            let text = '';
            res.on('data', c => text += c);
            res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text) }));
        });
        req.on('error', reject);
        req.end(data);
    });
    try {
        assert.equal((await post('getRuntimeStatus', {}, {})).status, 401);
        const status = await post('getRuntimeStatus', {}, headers);
        assert.equal(status.json.activeClients, 1);
        assert.deepEqual((await post('openInEditor', { relativePath: 'docs/README.md' }, headers)).json,
            { opened: true, resolvedRelativePath: 'docs/README.md' });
        assert.deepEqual(opened, [['openInEditor', path.join(root, 'docs', 'README.md')]]);
        win.sendEvent('open-artifact', { kind: 'component', ref: 'cf-gears-api-gateway' });
        for (let i = 0; i < 50 && events.length === 0; i += 1) await new Promise(r => setTimeout(r, 10));
        assert.deepEqual(events, [{ kind: 'open-artifact', payload: { kind: 'component', ref: 'cf-gears-api-gateway' } }]);
    } finally {
        win.close();
        await windows.close();
        await new Promise(r => server.close(r));
    }
});
