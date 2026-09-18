/*
 * The git identity a session commits under.
 *
 * Two things are being guarded, and only one of them is about formatting.
 *
 * THE DEFECT. The entrypoint writes a global git identity into the container
 * user's home. `viewer-credentials.js` then repoints HOME for the plugin host,
 * so one viewer's assistant credentials cannot be another's — and the plugin
 * host is where the IDE's built-in git extension runs. With HOME moved, git
 * finds no global config, and Commit answers "Make sure you configure your
 * user.name and user.email in git". Reported from use; confirmed by reading the
 * plugin host's own environ in a running session and finding no `.gitconfig` in
 * any credential home.
 *
 * THE ORDER. `include` first, `[user]` second. Git applies the last value it
 * reads, so this way the session's own config still supplies everything the
 * person does not state, and the person still wins over its default identity.
 * Reversed, every commit would go on being authored by a shared "Constructor
 * Studio" — in a product whose whole point is telling collaborators apart.
 *
 * Run: `node test/git-identity.test.js` (or `npm run test:git-identity`).
 */

const assert = require('node:assert');
const { gitIdentityConfig, writeGitConfig } = require('../src/node/viewer-credentials-env');

const CONTAINER = '/home/node/.gitconfig';

let failures = 0;
function test(name, fn) {
    try {
        fn();
        console.log('  ok   ' + name);
    } catch (error) {
        failures++;
        console.error('  FAIL ' + name);
        console.error('       ' + (error && error.message));
    }
}

console.log('git identity');

test('the session’s own config is always included', () => {
    // Without this line the moved HOME has no git config at all, which is the
    // failure the whole file exists for.
    const config = gitIdentityConfig(CONTAINER, undefined);
    assert.ok(config.includes('[include]'), config);
    assert.ok(config.includes('path = ' + CONTAINER), config);
});

test('an anonymous home still gets a usable config', () => {
    // Before anybody has announced themselves — and forever, in a standalone
    // session — the include alone is what lets a commit happen at all.
    const config = gitIdentityConfig(CONTAINER, undefined);
    assert.ok(!config.includes('[user]'), config);
});

test('the person is stated after the include, so they win', () => {
    const config = gitIdentityConfig(CONTAINER, { name: 'Roma', email: 'roma@example.com' });
    assert.ok(config.indexOf('[include]') < config.indexOf('[user]'), config);
    assert.ok(config.includes('\tname = Roma'), config);
    assert.ok(config.includes('\temail = roma@example.com'), config);
});

test('a person with no address commits under their own name anyway', () => {
    // Git needs an address to commit; the include supplies the session's. The
    // alternative — refusing to state the name either — would leave the commit
    // authored by nobody in particular, which is strictly worse.
    const config = gitIdentityConfig(CONTAINER, { name: 'Roma' });
    assert.ok(config.includes('\tname = Roma'), config);
    assert.ok(!config.includes('email ='), config);
});

test('an address with no name is still an address', () => {
    const config = gitIdentityConfig(CONTAINER, { email: 'roma@example.com' });
    assert.ok(config.includes('\temail = roma@example.com'), config);
    assert.ok(!config.includes('name ='), config);
});

test('blank fields are not fields', () => {
    // The portal sends what its token claims carry, and a claim can be an empty
    // string. `name = ` is not a git identity, it is a parse error waiting.
    const config = gitIdentityConfig(CONTAINER, { name: '   ', email: '' });
    assert.ok(!config.includes('[user]'), config);
});

test('the file is tab-indented and newline-terminated, as git writes it', () => {
    const config = gitIdentityConfig(CONTAINER, { name: 'Roma' });
    assert.ok(config.endsWith('\n'), JSON.stringify(config));
    assert.ok(/\n\tname = /.test(config), JSON.stringify(config));
});

// -- the config a home actually receives -------------------------------------

test('a brand-new home comes out with the include AND the person in it', () => {
    /* Measured on the dev stand, not imagined: `.studio-credentials/oidc-<sub>-<hash>/`
     * was an EMPTY directory. `setViewer` rewrote the config for a viewer it
     * already knew, and `home()` wrote it for a home it was asked for, but the
     * FIRST adoption — the moment a person stops being anonymous — created the
     * directory and put nothing in it. git in that home then had neither the
     * include nor a `[user]`, which is the "Make sure you configure your
     * user.name and user.email" the session answered to the one person who HAD
     * said who they were. */
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-home-'));
    try {
        writeGitConfig(home, { name: 'ANDREI KUCHMA', email: 'andrej.kuchma@constructor.tech' });
        const config = fs.readFileSync(path.join(home, '.gitconfig'), 'utf8');
        assert.ok(config.includes('[include]'), config);
        assert.ok(config.includes('	name = ANDREI KUCHMA'), config);
        assert.ok(config.includes('	email = andrej.kuchma@constructor.tech'), config);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test('an anonymous home still gets the include, so a commit is possible at all', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-home-'));
    try {
        writeGitConfig(home, undefined);
        const config = fs.readFileSync(path.join(home, '.gitconfig'), 'utf8');
        assert.ok(config.includes('[include]'), config);
        assert.ok(!config.includes('[user]'), config);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

if (failures) {
    console.error(failures + ' failing');
    process.exit(1);
}
console.log('  all passing');
