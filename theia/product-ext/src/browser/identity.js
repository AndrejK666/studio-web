/*
 * Who is writing.
 *
 * Until now the product had no identity model at all: comment-ui.js decided
 * "is this me?" by testing the author string against the set {you, me}, so a
 * thread authored "roma" rendered as somebody else's, and every party writing
 * into a document was indistinguishable from every other. That is the thing
 * this module fixes, and it is a prerequisite for the append-only comment log
 * (comment-log.js), which partitions its files by author.
 *
 * DELIBERATELY NOT AUTHENTICATION. A display name typed into a text field is
 * self-declared and unverified; anyone can claim any name. OIDC is coming and
 * will make it verified. So the job here is to build the SEAM that OIDC drops
 * into, and to be honest in the UI meanwhile.
 *
 * The seam is the author record:
 *
 *   { id:   'local:roma',   // PROVIDER-PREFIXED. Becomes 'oidc:<sub>' later,
 *                           // with no change at any call site.
 *     name: 'Roma',         // display, mutable, never an identifier
 *     kind: 'person',       // 'person' | 'agent' | 'product'
 *     key:  'local-roma' }  // filename-safe form of `id`
 *
 * Two rules make the record safe to persist:
 *
 *  1. `id` is minted ONCE and frozen (localStorage, see MINTED_ID_KEY).
 *     Renaming yourself changes `name` and nothing else. If `id` tracked the
 *     name, then step 2's log file — which is named after `key` — would be
 *     orphaned by a rename, and the fold would read one person as two.
 *
 *     ONE exception, and it is deliberate: an id minted before the user had a
 *     name is a placeholder ('local:anon-3f2a1b9c'), and something always reads
 *     current() during startup, so in practice everyone would get one. Log
 *     files are named after the key and are COMMITTED — an unreadable filename
 *     in a pull request defeats the point of a sidecar you can review. So the
 *     first real naming re-mints once, and the placeholder is remembered in
 *     SUPERSEDED_KEY so isSelf() still recognises anything written under it.
 *     Ops carry their own author record, so an older log folds in unchanged and
 *     simply shows the name that was true when it was written.
 *  2. `key` is always `id` with ':' replaced, so the two can never disagree.
 *     Under OIDC that yields 'oidc-<sub>' with no separate rule to remember.
 *
 * WHERE THE NAME IS STORED, and why not with the other settings: the name is
 * stored per machine, in localStorage, NOT in <root>/.studio/settings.json.
 * That file is committed to the repository. A display name written there would
 * travel to everyone who clones the repo and would silently claim their
 * comments as this user's. The control for it lives on the Project page,
 * because that is where a user looks for it, but the value is user-scoped and
 * the UI says so.
 */

const MINTED_ID_KEY = 'studio-identity-id';
const NAME_KEY = 'studio-identity-name';
/* Placeholder ids this user has retired, newline-separated. Only ever appended
 * to — an id here may name a log file that still exists on disk. */
const SUPERSEDED_KEY = 'studio-identity-superseded';

/* A minted id that was made up because the user had not said who they were. */
const PLACEHOLDER = /^anon-/;

/* Authors that are not people. An agent's words are committed alongside a
 * person's in the same log, so "not a person" has to stay legible in the UI —
 * comment-ui.js gives these a dashed disc. Keyed by the token that appears in
 * a legacy author string as well as by the record id. */
const AGENT_AUTHORS = new Map([
    ['claude', { id: 'agent:claude', name: 'Claude', kind: 'agent', key: 'agent-claude' }],
    ['codex', { id: 'agent:codex', name: 'Codex', kind: 'agent', key: 'agent-codex' }],
    ['assistant', { id: 'agent:assistant', name: 'Assistant', kind: 'agent', key: 'agent-assistant' }]
]);

/* Author strings that meant "the person at this keyboard" before identity
 * existed. Every seeded fixture and every comment already on disk uses one of
 * these, so isSelf() has to keep honouring them or existing data changes
 * meaning the day this ships. */
const LEGACY_SELF = new Set(['you', 'me']);

const UNNAMED = 'You';

function readStore(key) {
    try { return globalThis.localStorage ? globalThis.localStorage.getItem(key) : undefined; } catch (e) { return undefined; }
}

function writeStore(key, value) {
    try { if (globalThis.localStorage) { globalThis.localStorage.setItem(key, value); } } catch (e) { /* private mode */ }
}

/*
 * Filename-safe, lowercase, no leading/trailing separators. Two names that
 * differ only in punctuation slug to the same token; that is acceptable for a
 * partition key and is the reason the minted id, not the name, is what gets
 * slugged.
 */
function slug(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
}

function randomToken() {
    if (globalThis.crypto && globalThis.crypto.randomUUID) { return globalThis.crypto.randomUUID().slice(0, 8); }
    return Math.floor(Math.random() * 0xffffffff).toString(36);
}

/* `key` is never authored by hand — it is always derived, so it cannot drift
 * from the id it partitions by. */
function keyForId(id) {
    return slug(String(id).replace(/:/g, '-')) || 'anon';
}

function makeRecord(providerId, localId, name, kind = 'person') {
    const id = providerId + ':' + localId;
    return { id, name: name || UNNAMED, kind, key: keyForId(id) };
}

/*
 * The local provider: a self-chosen name, this machine only.
 *
 * An OIDC provider satisfies the same four members. It supplies `id` 'oidc',
 * builds its record from the token (`sub` -> the local part of the record id,
 * name/email claims -> `name`), reports canSetName: false because the name is
 * the identity provider's to state, and adds a sign-out. Nothing outside this
 * module reads a provider, so adding one is a change here and nowhere else.
 */
const localProvider = {
    id: 'local',
    canSetName: true,

    current() {
        const name = readStore(NAME_KEY);
        const record = makeRecord('local', this.localId(), name || UNNAMED, 'person');
        if (!name) { record.unnamed = true; }
        return record;
    },

    setName(name) {
        const trimmed = String(name || '').trim().slice(0, 60);
        if (!trimmed) {
            try { globalThis.localStorage && globalThis.localStorage.removeItem(NAME_KEY); } catch (e) { /* ignore */ }
            return;
        }
        const before = readStore(MINTED_ID_KEY);
        writeStore(NAME_KEY, trimmed);
        /* Naming yourself over a SEALED placeholder: retire it and seal a
         * readable id in its place, once. Every later rename leaves the id
         * alone. Nothing is sealed here if nothing was sealed before — see
         * localId. */
        if (before && PLACEHOLDER.test(before) && slug(trimmed)) {
            retire(before);
            writeStore(MINTED_ID_KEY, uniqueLocalId(slug(trimmed)));
        }
    },

    /*
     * The id, sealed once and then frozen (see the header for the single
     * exception). Seeded from the name so a committed log file is named after a
     * person rather than a random token; a placeholder when there is no name,
     * because an unnamed user can still write a comment.
     *
     * UNTIL IT IS SEALED THIS IS PROVISIONAL, and that matters. The name field
     * commits on every `input` event — it must, or a user who types a name and
     * immediately comments would still be writing as "You". Sealing on those
     * events instead would freeze the id on the FIRST KEYSTROKE: typing "Roma"
     * sealed `r`, and every log file this user ever committed would have been
     * named local-r.jsonl. Measured, by collaboration-regression.
     *
     * So the seal happens at the first WRITE (comment-log.append calls seal()),
     * by which point the name is whatever the user actually meant.
     */
    localId() {
        const sealed = readStore(MINTED_ID_KEY);
        if (sealed) { return sealed; }
        const named = slug(readStore(NAME_KEY));
        if (named) { return uniqueLocalId(named); }
        /* Held in memory so two writes in one unnamed session land in one file
         * rather than two; persisted only by seal(). */
        if (!this.provisionalAnon) { this.provisionalAnon = 'anon-' + randomToken(); }
        return this.provisionalAnon;
    },

    /* Freeze the current provisional id. Idempotent, and called immediately
     * before anything is written under it. */
    seal() {
        const sealed = readStore(MINTED_ID_KEY);
        if (sealed) { return sealed; }
        const minted = this.localId();
        writeStore(MINTED_ID_KEY, minted);
        return minted;
    },

    superseded() { return retiredIds(); }
};

/* Ids retired by the one permitted re-mint. */
function retiredIds() {
    return String(readStore(SUPERSEDED_KEY) || '').split('\n').filter(Boolean);
}

function retire(localId) {
    const all = retiredIds();
    if (all.includes(localId)) { return; }
    all.push(localId);
    writeStore(SUPERSEDED_KEY, all.join('\n'));
}

/* A name-derived id must not collide with one this machine already retired, or
 * a re-mint could land back on a log file written by the earlier identity. */
function uniqueLocalId(base) {
    const taken = new Set(retiredIds());
    if (!taken.has(base)) { return base; }
    return base + '-' + randomToken();
}

/*
 * The portal provider: the identity the embedding portal has already verified.
 *
 * This is the OIDC case the header promised, arriving the only way it can. The
 * IDE runs inside the portal's iframe and has no login of its own, so the side
 * that did authenticate the person states who they are over the bridge —
 * `studio.init` and `studio.token` carry a `viewer`, see
 * `studio/src/browser/portal-bridge-contribution.ts`.
 *
 * `sub` is the identity provider's subject, and it rather than the name is the
 * local part of the id for the reason the local provider seals its own id: a
 * person who changes their display name must keep everything they have ever
 * written, and two people who happen to share a display name are still two
 * identities.
 *
 * NOT SETTABLE. The name is the identity provider's to state, so `canSetName`
 * is false and the Project page's name field goes read-only rather than writing
 * a claim the next silent renew would overwrite.
 *
 * `superseded()` is EMPTY ON PURPOSE. It is tempting to hand back this
 * machine's retired local ids so that signing in inherits what was written
 * before — but myIds() prefixes each one with the CURRENT provider, which would
 * mint `oidc:<a local id>`: an id nobody has ever written under. Claiming that
 * earlier work is isSelf()'s job instead, where the display name can be
 * required to match as well (see localMintedIds).
 */
function portalProvider(sub, name, kind) {
    return {
        id: 'oidc',
        canSetName: false,
        /* Tells init() not to put the local provider back over a verified one,
         * and lets a surface say "verified" where it says "self-declared". */
        verified: true,
        sub,

        current() {
            const record = makeRecord('oidc', sub, name || UNNAMED, kind || 'person');
            if (!name) { record.unnamed = true; }
            return record;
        },

        /* The identity provider states the name; nothing here may. */
        setName() { /* no-op */ },

        /* Nothing to freeze: the subject was already an identifier when it
         * arrived. Present because callers seal before every write. */
        seal() { return sub; },

        superseded() { return []; }
    };
}

/*
 * Ids this browser profile wrote under while nobody was signed in: the sealed
 * one, and every placeholder it retired.
 *
 * Used by isSelf to claim earlier work after a sign-in — but only together with
 * a matching display name. The id on its own is not enough: this browser
 * profile may have been somebody else's unauthenticated session, and adopting
 * their threads would offer the current user edit and retract over words that
 * are not theirs.
 */
function localMintedIds() {
    const ids = new Set();
    const sealed = readStore(MINTED_ID_KEY);
    if (sealed) { ids.add('local:' + sealed); }
    retiredIds().forEach(local => ids.add('local:' + local));
    return ids;
}

class Identity {

    constructor() {
        this.provider_ = localProvider;
        this.listeners = [];
    }

    /* Present for symmetry with fileTypeSettings.init(); the local provider
     * needs no services. The portal provider needs none either — it is handed
     * a viewer rather than fetching one (see adopt).
     *
     * NOT A RESET. The portal's handshake does not wait for this call, and the
     * order the two frontend contributions start in is the container's to
     * decide, so putting the local provider back unconditionally would be a
     * race that signs the user out on roughly half of all startups. */
    init(_services) {
        if (!this.provider_.verified) { this.provider_ = localProvider; }
        return this.current();
    }

    /*
     * The portal states who is signed in.
     *
     * Idempotent, and it has to be: every silent token renew re-posts the same
     * viewer, and firing onChanged for it would re-render every open comment
     * thread a few times an hour for no reason.
     *
     * A viewer without a `sub` is ignored rather than adopted as anonymous — a
     * portal that has not signed anybody in should leave the IDE on the local
     * provider, which is honest about being self-declared.
     */
    adopt(viewer) {
        const sub = viewer && String(viewer.sub || '').trim();
        if (!sub) { return this.current(); }
        const name = String((viewer && viewer.name) || '').trim();
        const kind = (viewer && viewer.kind) || 'person';
        const before = this.current();
        this.provider_ = portalProvider(sub, name, kind);
        const after = this.current();
        if (before.id !== after.id || before.name !== after.name) { this.fireChanged(); }
        return after;
    }

    provider() { return this.provider_; }

    current() { return this.provider_.current(); }

    displayName() { return this.current().name; }

    /* True while the user has never said who they are, so a surface can prompt
     * instead of silently attributing writes to "You". */
    isUnnamed() { return !!this.current().unnamed; }

    /* Freeze the identity that is about to author something. Called by
     * comment-log.append, because the log file is named after the id and an id
     * that could still change is not a filename. */
    seal() { return this.provider_.seal ? this.provider_.seal() : undefined; }

    setDisplayName(name) {
        if (!this.provider_.canSetName) { return this.current(); }
        const before = this.current();
        this.provider_.setName(name);
        const after = this.current();
        if (before.name !== after.name || before.unnamed !== after.unnamed) { this.fireChanged(); }
        return after;
    }

    onChanged(fn) { this.listeners.push(fn); }
    fireChanged() { this.listeners.forEach(f => { try { f(); } catch (e) { console.error(e); } }); }
}

const identity = new Identity();

/*
 * Normalise anything that has ever been stored as an author into a record.
 *
 * Accepts: a record (returned as-is once `key` is filled in), a legacy author
 * string, or nothing. Legacy strings are resolved in a fixed order — the
 * historical self tokens, then the known agents, then a plain person whose id
 * is marked `legacy:` so a folded log never claims a bare string was a
 * provider-verified identity.
 */
function authorRecord(value) {
    if (value && typeof value === 'object') {
        const id = value.id || ('legacy:' + slug(value.name) || 'legacy:anon');
        return {
            id,
            name: value.name || UNNAMED,
            kind: value.kind || 'person',
            key: value.key || keyForId(id)
        };
    }
    const raw = String(value == null ? '' : value).trim();
    const token = raw.toLowerCase();
    if (!raw || LEGACY_SELF.has(token)) { return identity.current(); }
    if (AGENT_AUTHORS.has(token)) { return { ...AGENT_AUTHORS.get(token) }; }
    return makeRecord('legacy', slug(raw) || 'anon', raw, 'person');
}

/*
 * Is this author me?
 *
 * Checked in this order, and the order is the point:
 *  1. structured id equality, including any placeholder id this machine
 *     retired — the only answer that is actually reliable;
 *  2. a legacy author string equal to my display name, case-insensitively,
 *     which is what makes comments written before identity existed appear as
 *     mine rather than as a stranger's;
 *  3. the historical {you, me} tokens, so seeded fixtures keep their meaning.
 *
 * An agent is never me, whatever it is called.
 */
function myIds() {
    const me = identity.current();
    const provider = identity.provider();
    const retired = provider.superseded ? provider.superseded() : [];
    return new Set([me.id, ...retired.map(local => provider.id + ':' + local)]);
}

function isSelf(value) {
    if (!value) { return false; }
    const me = identity.current();
    const sameName = name => !!name && !me.unnamed && String(name).trim().toLowerCase() === me.name.toLowerCase();
    if (typeof value === 'object') {
        if (value.kind === 'agent') { return false; }
        if (value.id) {
            if (myIds().has(value.id)) { return true; }
            /*
             * A `legacy:` id is not an identity — it is a bare author string that
             * authorRecord had to put somewhere. Comments written before identity
             * existed all fold to one, and comment-ui prefers the structured
             * record over the display string, so WITHOUT this fallback the
             * name-matching rule below became unreachable for exactly the
             * messages it was written for: the fixture thread authored "roma"
             * rendered as a stranger's again, which is the original defect.
             *
             * A `local:` id this machine minted is the same problem one sign-in
             * later: everything written before the portal verified anybody
             * carries an id the portal provider can never equal. Both are
             * claimed only when the display name matches too, which is what
             * keeps a machine's previous unauthenticated user out.
             */
            return (value.id.startsWith('legacy:') || localMintedIds().has(value.id)) && sameName(value.name);
        }
        return sameName(value.name);
    }
    const token = String(value).trim().toLowerCase();
    if (!token) { return false; }
    if (AGENT_AUTHORS.has(token)) { return false; }
    if (LEGACY_SELF.has(token)) { return true; }
    return !me.unnamed && token === me.name.toLowerCase();
}

/* An author that is neither me nor a person: used for the dashed disc. */
function isAgent(value) {
    if (!value) { return false; }
    if (typeof value === 'object') { return value.kind === 'agent'; }
    return AGENT_AUTHORS.has(String(value).trim().toLowerCase());
}

module.exports = {
    identity, authorRecord, isSelf, isAgent, myIds, slug, keyForId,
    AGENT_AUTHORS, LEGACY_SELF, NAME_KEY, MINTED_ID_KEY, SUPERSEDED_KEY, UNNAMED
};
