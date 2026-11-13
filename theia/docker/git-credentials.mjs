#!/usr/bin/env node
// git credential helper for a session container.
//
// A session holds no source host's key (#1095). Its project's repositories
// are cloned through Studio's Git proxy (`studio-git`), which attaches the
// connection's key upstream, and the session proves itself to the proxy with
// the one credential the studio-session gear minted for it at launch:
// STUDIO_GIT_PROXY_TOKEN. It names this session, nothing else, and stops
// working when the session stops.
//
// The rule is deliberately narrow: answer only for the proxy addresses this
// workspace was cloned from (STUDIO_SOURCES' `clone_url`, and the root's
// STUDIO_ROOT_CLONE_URL), host AND path, so
// the session credential is never handed to some other host or repository a
// repository's config, a submodule or an agent decides to contact. Anything
// else gets no answer at all: git then fails without a prompt
// (GIT_TERMINAL_PROMPT=0), or clones anonymously when the host allows it.
//
// `store` and `erase` do nothing: nothing is persisted, so every git
// invocation re-reads the environment. Nothing here writes to stdout except
// the credential protocol, and errors are swallowed: a broken helper must not
// stall or spam a git command.

const [action] = process.argv.slice(2);

/** Read git's key=value request from stdin (terminated by a blank line/EOF). */
async function readRequest() {
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk);
    }
    const request = {};
    for (const line of Buffer.concat(chunks).toString('utf8').split(/\r?\n/)) {
        if (!line) continue;
        const separator = line.indexOf('=');
        if (separator > 0) {
            request[line.slice(0, separator)] = line.slice(separator + 1);
        }
    }
    return request;
}

/** `/cf/x/sources/api.git` and `cf/x/sources/api` compare equal; git sends the latter. */
function normalizePath(value) {
    return (value ?? '').replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '').toLowerCase();
}

/** The proxy addresses this workspace's sources are cloned from. */
function proxyRemotes() {
    const remotes = [];
    const add = (address) => {
        if (typeof address !== 'string' || !address) return;
        try {
            const url = new URL(address);
            remotes.push({
                protocol: url.protocol.replace(/:$/, ''),
                host: url.host,
                path: normalizePath(url.pathname),
            });
        } catch {
            // Not a URL: nothing to answer for.
        }
    };
    try {
        for (const source of JSON.parse(process.env.STUDIO_SOURCES ?? '[]')) {
            add(source?.clone_url);
        }
    } catch {
        // A malformed STUDIO_SOURCES answers for none of its sources.
    }
    // The workspace root, cloned through the proxy as well.
    add(process.env.STUDIO_ROOT_CLONE_URL);
    return remotes;
}

function resolve(request) {
    const token = process.env.STUDIO_GIT_PROXY_TOKEN?.trim();
    if (!token || !request.host) {
        return undefined;
    }
    const path = normalizePath(request.path);
    // `credential.useHttpPath` is what makes git send the path at all; the
    // entrypoint sets it. Without a path nothing matches.
    const known = proxyRemotes().some(
        (remote) =>
            remote.protocol === (request.protocol ?? 'https') &&
            remote.host === request.host &&
            path &&
            remote.path === path,
    );
    return known ? token : undefined;
}

async function main() {
    if (action !== 'get') {
        return; // store / erase: nothing is kept, so there is nothing to do
    }
    const token = resolve(await readRequest());
    if (!token) {
        return;
    }
    // The proxy reads the password and ignores the user name.
    process.stdout.write(`username=studio-session\npassword=${token}\n`);
}

main().catch(() => {
    // Silence is a valid answer in the credential protocol. Anything printed
    // here would either leak or confuse git.
});
