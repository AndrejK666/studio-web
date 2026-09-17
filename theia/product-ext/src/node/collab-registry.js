/*
 * The registry itself: plain data structures, no Theia and no inversify.
 *
 * Split out of `collab.js` for `viewer-credentials-env.js`'s reason — the
 * part with the rules in it is the part worth testing, and a test that has to
 * boot a dependency-injection container to reach a Map is a test nobody runs.
 * `collab.js` keeps the wiring and nothing else.
 *
 * See `../common/collab-protocol.js` for why a write claim carries a digest.
 */

const { PARTY_TTL_MS, WRITE_CLAIM_TTL_MS } = require('../common/collab-protocol');

/** Shape an author record into what a roster may carry. Input from a frontend:
 *  nothing is trusted past its type, and nothing but these four fields is kept
 *  — a roster is broadcast to every other browser in the workspace. */
function authorOf(value) {
    if (!value || typeof value !== 'object') { return undefined; }
    const id = typeof value.id === 'string' ? value.id.slice(0, 200) : '';
    if (!id) { return undefined; }
    return {
        id,
        name: typeof value.name === 'string' ? value.name.slice(0, 120) : '',
        kind: value.kind === 'agent' || value.kind === 'product' ? value.kind : 'person',
        key: typeof value.key === 'string' ? value.key.slice(0, 200) : ''
    };
}

function documentKey(value) {
    return typeof value === 'string' ? value.slice(0, 2000) : '';
}

/**
 * Process-wide: one per container, shared by every browser connection.
 *
 * Bound in the plain ContainerModule rather than the connection-scoped one for
 * exactly that reason — a per-connection singleton would give each browser a
 * registry of one, which is the state the product was already in.
 */
class CollabRegistry {

    constructor(now = () => Date.now()) {
        this.now = now;
        /** doc -> partyId -> { author, typing, at } */
        this.parties = new Map();
        /** doc -> { author, digest, at } */
        this.claims = new Map();
    }

    /**
     * Record that a party is in a document, and answer with everybody else.
     *
     * @param partyId  the connection; stable for one browser session
     * @param doc      the document uri, as a string
     */
    announce(partyId, doc, author, typing) {
        const key = documentKey(doc);
        const who = authorOf(author);
        if (!key || !partyId) { return []; }
        this.sweep();
        if (!this.parties.has(key)) { this.parties.set(key, new Map()); }
        this.parties.get(key).set(partyId, { author: who, typing: !!typing, at: this.now() });
        return this.roster(key, partyId, who);
    }

    /** Leave one document, or — with no document — every one of them. */
    depart(partyId, doc) {
        const key = documentKey(doc);
        if (key) {
            const inDoc = this.parties.get(key);
            if (inDoc) { inDoc.delete(partyId); }
            if (inDoc && inDoc.size === 0) { this.parties.delete(key); }
            return;
        }
        for (const [docKey, inDoc] of this.parties) {
            inDoc.delete(partyId);
            if (inDoc.size === 0) { this.parties.delete(docKey); }
        }
    }

    /*
     * Everybody in the document who is not me.
     *
     * "Not me" is by AUTHOR, not by connection: my own second tab is still me,
     * and listing it would reintroduce the duplicate-session warning as a
     * phantom colleague. Two anonymous parties that have not identified
     * themselves fall back to the connection, which is the most that can
     * honestly be said about them.
     */
    roster(doc, partyId, me) {
        const inDoc = this.parties.get(documentKey(doc));
        if (!inDoc) { return []; }
        const mine = me && me.id;
        const others = [];
        for (const [id, entry] of inDoc) {
            if (id === partyId) { continue; }
            if (mine && entry.author && entry.author.id === mine) { continue; }
            others.push({ author: entry.author, typing: entry.typing, at: entry.at });
        }
        return others;
    }

    /**
     * Everybody in a whole project, rather than in one document.
     *
     * The collaboration panel's question — who is in this project and what do
     * they have open — is not a roster of one document, and answering it by
     * asking per document would mean the panel knowing which documents to ask
     * about, which is exactly what it is trying to find out.
     *
     * `prefix` is the project root's uri. Filtering here rather than returning
     * everything keeps one workspace's other projects out of a panel scoped to
     * this one; an empty prefix means the whole container, which is what a
     * caller with no project resolved would want.
     */
    everyone(prefix) {
        this.sweep();
        const under = String(prefix || '');
        const parties = [];
        for (const [doc, inDoc] of this.parties) {
            if (under && !doc.startsWith(under)) { continue; }
            for (const entry of inDoc.values()) {
                parties.push({ doc, author: entry.author, typing: entry.typing, at: entry.at });
            }
        }
        return parties;
    }

    /**
     * "I am about to write exactly these bytes."
     *
     * One claim per document: a second write supersedes the first, because a
     * reader can only ever be looking at the newest content.
     */
    claimWrite(doc, author, digest) {
        const key = documentKey(doc);
        const who = authorOf(author);
        if (!key || !who || !digest) { return; }
        this.sweep();
        this.claims.set(key, { author: who, digest: String(digest).slice(0, 80), at: this.now() });
    }

    /**
     * Who wrote this exact content, if anybody said so.
     *
     * The digest must match. An agent writing through the filesystem claims
     * nothing, so it answers `undefined` and the caller falls back to holding
     * the write for review — which is the safe direction and the behaviour
     * every write had before this existed.
     */
    lastWriter(doc, digest) {
        this.sweep();
        const claim = this.claims.get(documentKey(doc));
        if (!claim || !digest || claim.digest !== String(digest)) { return undefined; }
        return { author: claim.author, at: claim.at };
    }

    /** Drop what has expired. Called by every operation; there is no timer. */
    sweep() {
        const now = this.now();
        for (const [key, inDoc] of this.parties) {
            for (const [id, entry] of inDoc) {
                if (now - entry.at > PARTY_TTL_MS) { inDoc.delete(id); }
            }
            if (inDoc.size === 0) { this.parties.delete(key); }
        }
        for (const [key, claim] of this.claims) {
            if (now - claim.at > WRITE_CLAIM_TTL_MS) { this.claims.delete(key); }
        }
    }
}

module.exports = { CollabRegistry, authorOf, documentKey };
