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

describe('a desktop token broker started before anyone signs in', () => {
    // What the backend opens at its start, for the plugin host to inherit.
    let host = 'studio.example.com';
    let signedIn = false;
    let broker: TokenBroker;

    beforeEach(async () => {
        host = 'studio.example.com';
        signedIn = false;
        broker = await startTokenBroker(() => host,
            () => signedIn ? Promise.resolve('token') : Promise.reject(new Error('not signed in to Studio')));
    });
    afterEach(() => broker.close());

    it('answers once the member signs in, at the address handed out before', async () => {
        const env = { ...process.env, [CREDENTIALS_ENV]: broker.address };
        const request = 'protocol=https\nhost=studio.example.com\n\n';
        expect(await askHelper(env, request)).toBe('');
        signedIn = true;
        expect(await askHelper(env, request)).toBe('username=studio\npassword=token\n');
    });

    it('answers for the Studio the member switched to, and no other', async () => {
        signedIn = true;
        host = 'studio.other.example';
        const env = { ...process.env, [CREDENTIALS_ENV]: broker.address };
        expect(await askHelper(env, 'protocol=https\nhost=studio.example.com\n\n')).toBe('');
        expect(await askHelper(env, 'protocol=https\nhost=studio.other.example\n\n')).toBe('username=studio\npassword=token\n');
    });
});
