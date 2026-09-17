/*
 * Who is writing — the local provider, and the portal provider that supersedes
 * it once somebody has actually signed in.
 *
 * The cases here are the ones where getting it wrong is silent. An identity
 * defect does not throw: it attributes a comment to the wrong person, or offers
 * one person the edit and retract controls over another person's words, and
 * nothing in the UI says so. So each case below names the wrong behaviour it
 * exists to stop.
 *
 * Run: `node test/identity.test.js` (or `npm run test:identity`).
 */

const assert = require('node:assert');

const MODULE = '../src/browser/identity';

/* localStorage, in memory. identity.js reads it through globalThis, and every
 * accessor is already wrapped in try/catch there, so nothing here has to
 * emulate a private-mode failure to be realistic. */
function memoryStorage(seed) {
    const data = new Map(Object.entries(seed || {}));
    return {
        getItem: key => (data.has(key) ? data.get(key) : null),
        setItem: (key, value) => { data.set(key, String(value)); },
        removeItem: key => { data.delete(key); },
        raw: data
    };
}

/*
 * A fresh module per case. The provider is module state that only ever moves
 * forwards (local → portal, deliberately: see identity.init), so re-requiring
 * is how a case starts from nothing without adding a reset API that exists for
 * the tests and for nobody else.
 */
function fresh(seed) {
    delete require.cache[require.resolve(MODULE)];
    globalThis.localStorage = memoryStorage(seed);
    return require(MODULE);
}

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

console.log('identity');

// -- the local provider, unchanged ------------------------------------------

test('unnamed by default, and says so', () => {
    const { identity } = fresh();
    assert.strictEqual(identity.isUnnamed(), true);
    assert.strictEqual(identity.current().name, 'You');
    assert.strictEqual(identity.current().id.startsWith('local:'), true);
});

test('a self-chosen name is mine, and an agent never is', () => {
    const { identity, isSelf } = fresh();
    identity.setDisplayName('Roma');
    assert.strictEqual(identity.current().name, 'Roma');
    assert.strictEqual(isSelf(identity.current()), true);
    assert.strictEqual(isSelf({ id: 'agent:claude', name: 'Claude', kind: 'agent' }), false);
});

// -- the portal provider -----------------------------------------------------

test('adopt keys the identity by subject, not by display name', () => {
    const { identity } = fresh();
    const me = identity.adopt({ sub: '9f1c2d34-aaaa-bbbb-cccc-0123456789ab', name: 'Andrej Kuchma' });
    assert.strictEqual(me.id, 'oidc:9f1c2d34-aaaa-bbbb-cccc-0123456789ab');
    assert.strictEqual(me.name, 'Andrej Kuchma');
    assert.strictEqual(me.kind, 'person');
    // The key names the log file this person's comments are appended to. A key
    // derived from the NAME would orphan that file on a rename.
    assert.strictEqual(me.key, 'oidc-9f1c2d34-aaaa-bbbb-cccc-0123456789ab');
});

test('seal returns the subject, so a log file is named after the account', () => {
    const { identity } = fresh();
    identity.adopt({ sub: 'sub-42', name: 'Roma' });
    assert.strictEqual(identity.seal(), 'sub-42');
    // And it did not mint anything into this browser's storage on the way.
    assert.strictEqual(globalThis.localStorage.getItem('studio-identity-id'), null);
});

test('a verified name is the provider’s, and the page may not overwrite it', () => {
    const { identity } = fresh();
    identity.adopt({ sub: 'sub-42', name: 'Roma' });
    assert.strictEqual(identity.provider().canSetName, false);
    identity.setDisplayName('Somebody Else');
    assert.strictEqual(identity.current().name, 'Roma');
});

test('a viewer without a subject is ignored, not adopted as anonymous', () => {
    const { identity } = fresh();
    identity.setDisplayName('Roma');
    identity.adopt({ name: 'Roma' });
    identity.adopt(undefined);
    assert.strictEqual(identity.current().id.startsWith('local:'), true);
    assert.strictEqual(identity.provider().canSetName, true);
});

test('adopting the same viewer twice fires onChanged once', () => {
    const { identity } = fresh();
    let changes = 0;
    identity.onChanged(() => { changes++; });
    identity.adopt({ sub: 'sub-42', name: 'Roma' });
    identity.adopt({ sub: 'sub-42', name: 'Roma' });
    identity.adopt({ sub: 'sub-42', name: 'Roma' });
    // Every silent token renew re-posts the viewer. Firing for each one would
    // re-render every open comment thread a few times an hour for nothing.
    assert.strictEqual(changes, 1);
});

test('a renamed account fires onChanged, because the surfaces show the name', () => {
    const { identity } = fresh();
    identity.adopt({ sub: 'sub-42', name: 'Roma' });
    let changes = 0;
    identity.onChanged(() => { changes++; });
    identity.adopt({ sub: 'sub-42', name: 'Roma Ivanov' });
    assert.strictEqual(changes, 1);
    assert.strictEqual(identity.current().name, 'Roma Ivanov');
});

test('init does not sign an adopted viewer back out', () => {
    const { identity } = fresh();
    // The portal's handshake does not wait for the frontend module's own
    // startup, and the order the two contributions run in is the container's
    // to decide. An unconditional reset here was a coin flip on every boot.
    identity.adopt({ sub: 'sub-42', name: 'Roma' });
    identity.init();
    assert.strictEqual(identity.current().id, 'oidc:sub-42');
});

// -- what this machine wrote before anybody signed in ------------------------

test('after signing in, my own earlier work on this machine is still mine', () => {
    const { identity, isSelf } = fresh({
        'studio-identity-id': 'roma',
        'studio-identity-name': 'Roma'
    });
    const earlier = { id: 'local:roma', name: 'Roma', kind: 'person' };
    assert.strictEqual(isSelf(earlier), true, 'mine before the sign-in');
    identity.adopt({ sub: 'sub-42', name: 'Roma' });
    assert.strictEqual(isSelf(earlier), true, 'still mine after it');
});

test('but not the work of whoever used this machine before me', () => {
    const { identity, isSelf } = fresh({
        'studio-identity-id': 'roma',
        'studio-identity-name': 'Roma'
    });
    identity.adopt({ sub: 'sub-42', name: 'Andrej Kuchma' });
    // Same browser profile, same minted id, different person. Claiming this
    // would hand Andrej the edit and retract controls over Roma's words.
    assert.strictEqual(isSelf({ id: 'local:roma', name: 'Roma', kind: 'person' }), false);
});

test('and never a stranger’s, whatever id they wrote under', () => {
    const { identity, isSelf } = fresh({
        'studio-identity-id': 'roma',
        'studio-identity-name': 'Roma'
    });
    identity.adopt({ sub: 'sub-42', name: 'Roma' });
    // Another machine's local id: the name matches, the id was never minted
    // here, so it is somebody else who happens to be called Roma.
    assert.strictEqual(isSelf({ id: 'local:roma-7f3a', name: 'Roma', kind: 'person' }), false);
    assert.strictEqual(isSelf({ id: 'oidc:sub-99', name: 'Roma', kind: 'person' }), false);
});

test('a retired placeholder id stays mine across the sign-in', () => {
    const { identity, isSelf } = fresh({
        'studio-identity-id': 'roma',
        'studio-identity-name': 'Roma',
        'studio-identity-superseded': 'anon-3f2a1b9c'
    });
    identity.adopt({ sub: 'sub-42', name: 'Roma' });
    assert.strictEqual(isSelf({ id: 'local:anon-3f2a1b9c', name: 'Roma', kind: 'person' }), true);
});

test('comments written before identity existed are still mine by name', () => {
    const { identity, isSelf, authorRecord } = fresh();
    identity.adopt({ sub: 'sub-42', name: 'Roma' });
    // A bare author string is not an identity; authorRecord parks it under
    // `legacy:`, and the name is all there is to go on.
    assert.strictEqual(isSelf(authorRecord('roma')), true);
    assert.strictEqual(isSelf(authorRecord('someone else')), false);
    assert.strictEqual(isSelf('you'), true);
});

if (failures) {
    console.error(failures + ' failing');
    process.exit(1);
}
console.log('  all passing');
