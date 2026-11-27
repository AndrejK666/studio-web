'use strict';
// The local channel between the control server and the extension of each open
// VS Code window: newline-delimited JSON over a unix socket only this user can
// open. The server sends `{ id, method, params }` to every window; each answers
// `{ id, result }`. A window may also send `{ event: { kind, payload } }`,
// which the server forwards to Studio (events.js).
const fs = require('fs');
const net = require('net');

const ANSWER_TIMEOUT_MS = 5000;

function lines(socket, onMessage) {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
        buffer += chunk;
        let at;
        while ((at = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, at);
            buffer = buffer.slice(at + 1);
            if (!line.trim()) continue;
            let message;
            try {
                message = JSON.parse(line);
            } catch {
                continue; // a line that is not JSON is dropped, not fatal
            }
            onMessage(message);
        }
    });
}

/** The server half. `onEvent(kind, payload)` gets what a window sends. */
function createWindowChannel(socketPath, onEvent = () => undefined, timeoutMs = ANSWER_TIMEOUT_MS) {
    const windows = new Set();
    const pending = new Map();
    let next = 1;
    try { fs.unlinkSync(socketPath); } catch { /* not there */ }
    const server = net.createServer((socket) => {
        windows.add(socket);
        socket.on('error', () => undefined);
        socket.on('close', () => windows.delete(socket));
        lines(socket, (message) => {
            if (message && message.event && typeof message.event.kind === 'string') {
                onEvent(message.event.kind, message.event.payload);
                return;
            }
            const waiting = message && pending.get(message.id);
            if (waiting) {
                waiting(message.result);
            }
        });
    });
    const listening = new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => {
            try { fs.chmodSync(socketPath, 0o600); } catch { /* best effort */ }
            resolve();
        });
    });

    function ask(socket, method, params) {
        const id = next++;
        return new Promise((resolve) => {
            const timer = setTimeout(() => { pending.delete(id); resolve(undefined); }, timeoutMs);
            pending.set(id, (result) => { clearTimeout(timer); pending.delete(id); resolve(result); });
            socket.write(JSON.stringify({ id, method, params }) + '\n');
        });
    }

    return {
        listening,
        count: () => windows.size,
        broadcast: (method, params) => Promise.all([...windows].map(socket => ask(socket, method, params))),
        close: () => new Promise((resolve) => {
            for (const socket of windows) socket.destroy();
            server.close(() => resolve());
        }),
    };
}

/** The window half, for the extension: answer each call with `handler`. */
function connectWindow(socketPath, handler) {
    const socket = net.connect(socketPath);
    socket.on('error', () => undefined);
    lines(socket, (message) => {
        if (!message || typeof message.method !== 'string') return;
        Promise.resolve()
            .then(() => handler(message.method, message.params || {}))
            .catch(() => undefined)
            .then((result) => socket.write(JSON.stringify({ id: message.id, result }) + '\n'));
    });
    return {
        socket,
        connected: new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); }),
        sendEvent: (kind, payload) => socket.write(JSON.stringify({ event: { kind, payload } }) + '\n'),
        close: () => socket.destroy(),
    };
}

module.exports = { createWindowChannel, connectWindow };
