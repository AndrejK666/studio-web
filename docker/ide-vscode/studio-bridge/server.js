#!/usr/bin/env node
'use strict';
// The control server of a VS Code session (ADR-0080 §4): POST
// /internal/ide/v2/<method> on 127.0.0.1:$STUDIO_IDE_CONTROL_PORT, which the
// session gate passes through. Started by studio-ide-start beside
// openvscode-server, so it answers whether or not a window is open; the
// windows' extensions connect to it over the local channel.
const http = require('http');
const os = require('os');
const path = require('path');
const { CONTROL_V2 } = require('./protocol');
const { createControl } = require('./control');
const { createWindowChannel } = require('./channel');
const { createEventSender } = require('./events');
const { listRepositories } = require('./repositories');

const MAX_BODY = 4 * 1024 * 1024;

function socketPath(env) {
    return env.STUDIO_BRIDGE_SOCKET || path.join(env.STUDIO_DATA_DIR || os.tmpdir(), 'studio-bridge.sock');
}

function createControlServer(control) {
    return http.createServer((req, res) => {
        const reply = (status, json) => {
            res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(json));
        };
        const url = new URL(req.url, 'http://x');
        const prefix = `${CONTROL_V2.path}/`;
        if (req.method !== 'POST' || !url.pathname.startsWith(prefix)) {
            return reply(404, { error: 'not a control call' });
        }
        const method = url.pathname.slice(prefix.length);
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY) {
                reply(413, { error: 'request too large' });
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (res.headersSent) return;
            let body = {};
            const raw = Buffer.concat(chunks).toString('utf8').trim();
            if (raw) {
                try {
                    body = JSON.parse(raw);
                } catch {
                    return reply(400, { error: 'the body is not JSON' });
                }
            }
            control.handle(method, req.headers, body).then(({ status, json }) => reply(status, json));
        });
    });
}

async function main(env = process.env) {
    const root = env.STUDIO_WORKSPACE_ROOT || '/workspace';
    const port = Number(env.STUDIO_IDE_CONTROL_PORT || 3005);
    const sendEvent = createEventSender(env);
    const windows = createWindowChannel(socketPath(env), (kind, payload) => void sendEvent(kind, payload));
    await windows.listening;
    const control = createControl({ token: (env[CONTROL_V2.tokenEnv] || '').trim(), root, env, windows });
    const server = createControlServer(control);
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    console.log(`[studio-bridge] control v2 on 127.0.0.1:${port}, windows on ${socketPath(env)}`);

    // The checkout lands behind the IDE, one source at a time: tell Studio when
    // the set of repositories changes, as the Theia node does.
    let last = '';
    const watch = () => {
        const repositories = listRepositories(root, env.STUDIO_GIT_MODE || 'disabled');
        const now = JSON.stringify(repositories.map(r => r.rootUri));
        if (now !== last) {
            last = now;
            void sendEvent('repositories-changed', repositories);
        }
    };
    watch();
    setInterval(watch, Number(env.STUDIO_BRIDGE_REPO_POLL_MS || 10000)).unref();
}

if (require.main === module) {
    main().catch((error) => {
        console.error('[studio-bridge] control server failed to start', error);
        process.exit(1);
    });
}

module.exports = { createControlServer, socketPath, main };
