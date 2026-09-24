/**
 * @jest-environment node
 */
import { execFile } from 'child_process';
import * as path from 'path';
import { CREDENTIALS_ENV, TokenBroker, startTokenBroker } from './desktop-token-broker';

const HELPER = path.join(__dirname, '..', '..', 'scripts', 'desktop-git-credentials.mjs');

/** Ask the helper what git would ask it, and return what it answered. */
function askHelper(env: NodeJS.ProcessEnv, request: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = execFile(process.execPath, [HELPER, 'get'], { env }, (error, stdout) =>
            error ? reject(error) : resolve(stdout));
        child.stdin!.end(request);
    });
}

describe('desktop token broker', () => {
    let broker: TokenBroker;
    let issued = 0;

    beforeEach(async () => {
        issued = 0;
        broker = await startTokenBroker('studio.example.com', async () => `token-${++issued}`);
    });
    afterEach(() => broker.close());

    it('gives the token only to whoever holds the secret', async () => {
        const [url, secret] = broker.address.split('#');
        expect((await fetch(url)).status).toBe(404);
        expect((await fetch(url, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(404);
        const answer = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } });
        expect(await answer.json()).toEqual({ host: 'studio.example.com', token: 'token-1' });
    });

    it('asks for a fresh token every time', async () => {
        const [url, secret] = broker.address.split('#');
        await fetch(url, { headers: { Authorization: `Bearer ${secret}` } });
        const second = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } });
        expect((await second.json()).token).toBe('token-2');
    });

    it('lets the credential helper answer git for the Studio host', async () => {
        const out = await askHelper({ ...process.env, [CREDENTIALS_ENV]: broker.address },
            'protocol=https\nhost=studio.example.com\n\n');
        expect(out).toBe('username=studio\npassword=token-1\n');
    });

    it('keeps the helper silent for any other host', async () => {
        const out = await askHelper({ ...process.env, [CREDENTIALS_ENV]: broker.address },
            'protocol=https\nhost=github.com\n\n');
        expect(out).toBe('');
    });

    it('keeps the helper silent outside a desktop session', async () => {
        const env = { ...process.env };
        delete env[CREDENTIALS_ENV];
        expect(await askHelper(env, 'protocol=https\nhost=studio.example.com\n\n')).toBe('');
    });
});
