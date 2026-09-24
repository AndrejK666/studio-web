import * as crypto from 'crypto';
import * as http from 'http';

/**
 * How a `git` started by anything in the desktop IDE gets the member's Studio
 * token without the token being written anywhere (ADR-0027 §3).
 *
 * The IDE backend listens on a loopback port and puts the address, with a
 * random secret, in its own environment as `STUDIO_DESKTOP_CREDENTIALS`.
 * Everything it starts inherits that — the plugin host, `vscode.git`, a
 * terminal, an agent — and the credential helper
 * (`scripts/desktop-git-credentials.mjs`) asks the broker for a token each
 * time `git` needs one. The token lives in this process's memory only; what a
 * repository's `.git/config` names is the helper, and the environment carries
 * a secret that is worthless once this process exits.
 */
export const CREDENTIALS_ENV = 'STUDIO_DESKTOP_CREDENTIALS';

export interface TokenBroker {
    /** `http://127.0.0.1:<port>/token#<secret>` — the value of `STUDIO_DESKTOP_CREDENTIALS`. */
    readonly address: string;
    close(): Promise<void>;
}

/**
 * Serve `token()` to whoever presents the secret. `host` is the Studio host the
 * helper may answer for; it is handed back so the helper can refuse every
 * other host without knowing anything itself.
 */
export async function startTokenBroker(host: string, token: () => Promise<string>): Promise<TokenBroker> {
    const secret = crypto.randomBytes(32).toString('hex');
    const server = http.createServer(async (req, res) => {
        const presented = req.headers.authorization === `Bearer ${secret}`;
        if (req.method !== 'GET' || req.url !== '/token' || !presented) {
            res.writeHead(404).end();
            return;
        }
        try {
            const value = await token();
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
                .end(JSON.stringify({ host, token: value }));
        } catch (error) {
            res.writeHead(503, { 'Content-Type': 'application/json' })
                .end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as { port: number }).port;
    return {
        address: `http://127.0.0.1:${port}/token#${secret}`,
        close: () => new Promise<void>(resolve => server.close(() => resolve())),
    };
}
