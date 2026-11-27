'use strict';
// constructorfabric.studio-bridge, the window side (ADR-0080 §3, §4).
//
// The control server (server.js) answers Studio; this extension is how it
// reaches an open window. It connects to the server's local channel and does
// what only a window can: open a file, open a portal document, show a
// notification. And it is how the IDE asks the portal for something:
// `studio.openArtifact` sends an `open-artifact` event, which the backend
// republishes for the portal. No script runs in the workbench page and no
// token is held here: the portal talks to this window only through the
// backend's control channel.
const vscode = require('vscode');
const os = require('os');
const path = require('path');
const { connectWindow } = require('./channel');
const { documentUri } = require('./documents');

const RECONNECT_MS = 2000;

/** Portal documents, shown read-only: the IDE holds no token to read or save them. */
class StudioDocumentProvider {
    constructor() {
        this.files = new Map();
        this.emitter = new vscode.EventEmitter();
        this.onDidChangeFile = this.emitter.event;
    }

    put(uri, content) {
        const existed = this.files.has(uri.toString());
        this.files.set(uri.toString(), { data: Buffer.from(content, 'utf8'), mtime: Date.now() });
        this.emitter.fire([{ type: existed ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri }]);
    }

    stat(uri) {
        const file = this.files.get(uri.toString());
        if (!file) {
            // Every directory on the way to a document exists, so the editor can
            // resolve its parents.
            for (const key of this.files.keys()) {
                if (key.startsWith(uri.toString().replace(/\/?$/, '/'))) {
                    return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
                }
            }
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        return { type: vscode.FileType.File, ctime: file.mtime, mtime: file.mtime, size: file.data.length };
    }

    readFile(uri) {
        const file = this.files.get(uri.toString());
        if (!file) throw vscode.FileSystemError.FileNotFound(uri);
        return file.data;
    }

    readDirectory() { return []; }
    watch() { return new vscode.Disposable(() => undefined); }
    createDirectory(uri) { throw vscode.FileSystemError.NoPermissions(uri); }
    writeFile(uri) { throw vscode.FileSystemError.NoPermissions(uri); }
    delete(uri) { throw vscode.FileSystemError.NoPermissions(uri); }
    rename(uri) { throw vscode.FileSystemError.NoPermissions(uri); }
}

function socketPath() {
    return process.env.STUDIO_BRIDGE_SOCKET
        || path.join(process.env.STUDIO_DATA_DIR || os.tmpdir(), 'studio-bridge.sock');
}

function activate(context) {
    const documents = new StudioDocumentProvider();
    context.subscriptions.push(vscode.workspace.registerFileSystemProvider('studio-doc', documents, {
        isCaseSensitive: true,
        isReadonly: true,
    }));

    const handle = async (method, params) => {
        switch (method) {
            case 'openInEditor': {
                const uri = vscode.Uri.file(params.path);
                const stat = await vscode.workspace.fs.stat(uri);
                if (stat.type & vscode.FileType.Directory) {
                    await vscode.commands.executeCommand('revealInExplorer', uri);
                } else {
                    await vscode.window.showTextDocument(uri, { preview: params.preview === true });
                }
                return { opened: true };
            }
            case 'openDocument': {
                const uri = vscode.Uri.parse(documentUri(params.workspaceId, params.documentId, params.title));
                documents.put(uri, params.content || '');
                await vscode.window.showTextDocument(uri, { preview: false });
                return { opened: true };
            }
            case 'notifyEditor': {
                const text = params.detail ? `${params.message} — ${params.detail}` : params.message;
                const labelled = params.source ? `${params.source}: ${text}` : text;
                const show = params.level === 'error' ? vscode.window.showErrorMessage
                    : params.level === 'warn' ? vscode.window.showWarningMessage
                        : vscode.window.showInformationMessage;
                // Not awaited: the notification stays until somebody reads it,
                // and the backend only asks whether it was shown.
                const actions = params.link ? ['Open'] : [];
                void Promise.resolve(show(labelled, ...actions)).then((choice) => {
                    if (choice === 'Open' && params.link) {
                        void vscode.env.openExternal(vscode.Uri.parse(params.link));
                    }
                });
                return { shown: true };
            }
            default:
                return undefined;
        }
    };

    let connection;
    let stopped = false;
    let timer;
    const connect = () => {
        if (stopped) return;
        connection = connectWindow(socketPath(), handle);
        connection.socket.on('close', () => {
            if (!stopped) timer = setTimeout(connect, RECONNECT_MS);
        });
    };
    connect();
    context.subscriptions.push({ dispose: () => { stopped = true; clearTimeout(timer); connection?.close(); } });

    context.subscriptions.push(vscode.commands.registerCommand('studio.openArtifact', async (kind, ref) => {
        let artifactKind = typeof kind === 'string' ? kind : undefined;
        let artifactRef = typeof ref === 'string' ? ref : undefined;
        if (!artifactKind) {
            artifactKind = await vscode.window.showQuickPick(['component', 'document', 'file'], {
                placeHolder: 'What should the Studio portal open?',
            });
        }
        if (artifactKind && !artifactRef) {
            artifactRef = await vscode.window.showInputBox({ prompt: `Which ${artifactKind}?` });
        }
        if (!artifactKind || !artifactRef) {
            return false;
        }
        connection?.sendEvent('open-artifact', { kind: artifactKind, ref: artifactRef });
        return true;
    }));
}

function deactivate() {
    return undefined;
}

module.exports = { activate, deactivate };
