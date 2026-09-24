#!/usr/bin/env node
// git credential helper for a desktop Studio (ADR-0027 §3).
//
// The session container's helper (theia/docker/git-credentials.mjs) answers
// with source host tokens that sit in its environment. A desktop has none and
// must not: its clones point at Studio's Git proxy, and the only credential
// that host takes is the member's own Studio token. This helper asks the IDE
// backend's token broker for it (STUDIO_DESKTOP_CREDENTIALS, see
// src/node/desktop-token-broker.ts) every time git needs one, so a token that
// was refreshed a minute ago is the one git sends, and nothing is stored.
//
// Narrow on purpose, like the container's helper: it answers only for the
// Studio host the broker names, so a submodule or a stray remote on another
// host never receives a Studio token. `store` and `erase` do nothing.
//
//   git config credential.https://studio.example.com.helper \
//       '!node /path/to/desktop-git-credentials.mjs'

const [action] = process.argv.slice(2);

async function readRequest() {
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk);
    }
    const request = {};
    for (const line of Buffer.concat(chunks).toString('utf8').split(/\r?\n/)) {
        const separator = line.indexOf('=');
        if (separator > 0) {
            request[line.slice(0, separator)] = line.slice(separator + 1);
        }
    }
    return request;
}

async function main() {
    if (action !== 'get') {
        return;
    }
    const broker = process.env.STUDIO_DESKTOP_CREDENTIALS;
    if (!broker || !broker.includes('#')) {
        return;
    }
    const request = await readRequest();
    const [url, secret] = broker.split('#');
    const response = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } });
    if (!response.ok) {
        return;
    }
    const { host, token } = await response.json();
    if (!token || request.host !== host) {
        return;
    }
    process.stdout.write(`username=studio\npassword=${token}\n`);
}

// A broken helper must not stall or spam a git command: git then fails with
// its own "Authentication failed", which is the right outcome.
main().catch(() => undefined);
