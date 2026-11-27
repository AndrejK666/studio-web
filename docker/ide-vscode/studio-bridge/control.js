'use strict';
// The control API of a VS Code session (ADR-0080 §4, v2 only).
//
// Answered by a small server beside openvscode-server (server.js), not by the
// extension itself: VS Code starts an extension host only for an open window,
// so a control API inside the extension would vanish whenever nobody has the
// IDE open, which is exactly when the backend asks for status. What needs the
// editor (open a file or a document, show a notification) goes to the windows
// that are open, over the local channel their extensions hold (channel.js),
// the way the Theia node broadcasts to its browser clients: `opened`/`shown`
// says whether one took it.
const path = require('path');
const { CONTROL_V2, PROTOCOL, RUNTIME, METHODS, CAPABILITIES, CANNOT } = require('./protocol');
const { listRepositories, resolveWorkspacePath } = require('./repositories');

function sentence(capability) {
    return `this IDE (VS Code) cannot ${CANNOT[capability] || capability.replace(/_/g, ' ')}`;
}

const text = (value) => (typeof value === 'string' ? value : '');
const optional = (value) => (typeof value === 'string' && value.trim() ? value : undefined);

/**
 * @param {object} options
 * @param {string} options.token     STUDIO_IDE_CONTROL_TOKEN
 * @param {string} options.root      the workspace root, /workspace
 * @param {object} options.env       the container's env
 * @param {{ count(): number, broadcast(method: string, params: object): Promise<unknown[]> }} options.windows
 * @param {() => number} [options.now]
 */
function createControl({ token, root, env, windows, now = Date.now }) {
    const started = now();
    const gitMode = env.STUDIO_GIT_MODE || 'disabled';
    const anyTrue = (results, key) => results.some(r => r && r[key] === true);

    const handlers = {
        getRuntimeStatus: async () => ({
            ready: true,
            workspaceMode: env.STUDIO_MANAGED_WORKSPACE === '1' ? 'managed' : 'workspace',
            activeClients: windows.count(),
            lastEventSequence: 0,
            version: env.STUDIO_IDE_VERSION || 'dev',
            uptimeSecs: Math.floor((now() - started) / 1000),
            runtime: RUNTIME,
            protocol: PROTOCOL,
            capabilities: CAPABILITIES,
        }),
        getSession: async () => ({
            actorId: env.STUDIO_ACTOR_ID || '',
            workspaceId: env.STUDIO_WORKSPACE_ID || '',
            workspaceRootName: path.basename(root),
            gitMode,
        }),
        getRepositories: async () => listRepositories(root, gitMode),
        openInEditor: async (body) => {
            const absolute = resolveWorkspacePath(root, text(body.relativePath));
            if (!absolute) {
                return { opened: false };
            }
            const results = await windows.broadcast('openInEditor', { path: absolute, preview: body.preview === true });
            return {
                opened: anyTrue(results, 'opened'),
                resolvedRelativePath: path.relative(root, absolute).split(path.sep).join('/'),
            };
        },
        openDocument: async (body) => {
            const workspaceId = text(body.workspaceId);
            const documentId = text(body.documentId);
            if (!workspaceId || !documentId) {
                return { opened: false };
            }
            const results = await windows.broadcast('openDocument', {
                workspaceId,
                documentId,
                title: optional(body.title),
                content: text(body.content),
            });
            return { opened: anyTrue(results, 'opened') };
        },
        notifyEditor: async (body) => {
            const message = text(body.message);
            if (!message) {
                return { shown: false };
            }
            const level = text(body.level).toLowerCase();
            const link = optional(body.link);
            const results = await windows.broadcast('notifyEditor', {
                level: level === 'error' ? 'error' : level === 'warn' || level === 'warning' ? 'warn' : 'info',
                message,
                detail: optional(body.detail),
                link: link && /^https?:\/\//.test(link) ? link : undefined,
                source: optional(body.source),
            });
            return { shown: anyTrue(results, 'shown') };
        },
    };

    /** One control call: `{ status, json }`. */
    async function handle(method, headers, body) {
        const presented = String(headers[CONTROL_V2.header] || '').trim();
        if (!token || presented !== token) {
            return { status: 401, json: { error: 'invalid or missing control token' } };
        }
        if (!Object.prototype.hasOwnProperty.call(METHODS, method)) {
            return { status: 404, json: { error: `no control method ${method}` } };
        }
        const capability = METHODS[method];
        if (capability && !CAPABILITIES.includes(capability)) {
            return { status: 501, json: { error: sentence(capability), unsupported: true } };
        }
        try {
            return { status: 200, json: await handlers[method](body && typeof body === 'object' ? body : {}) };
        } catch (error) {
            return { status: 502, json: { error: error instanceof Error ? error.message : String(error) } };
        }
    }

    return { handle };
}

module.exports = { createControl, sentence };
