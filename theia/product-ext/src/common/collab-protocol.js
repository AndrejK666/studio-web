/*
 * What both halves of co-editing have to agree on: one service path, three
 * durations, and the digest that decides who wrote a file.
 *
 * NAMED FOR CO-EDITING, not for presence. The portal has a gear called
 * studio-presence that answers a different question — who is signed into
 * Studio at all, across the assembly, on a 30-second heartbeat. This is who
 * has THIS DOCUMENT open in THIS session container, on a four-second one, plus
 * the attribution of writes. Two things sharing a word is how a reader ends up
 * looking for one of them in the other's code.
 *
 * Kept here for `quality-protocol.js`'s reason — a literal spelled twice fails
 * silently at runtime rather than loudly at load — and with one addition: the
 * digest function is shared because both parties to a hand-off are BROWSERS.
 * The writer digests what it wrote and the reader digests what it read, and if
 * those two ever disagreed about how to hash a string the reader would decide a
 * colleague's save was an unattributed write and hold it for review.
 *
 * WHY THERE IS A DIGEST AT ALL. The question co-editing has to answer is not
 * "who was here recently" but "who produced exactly these bytes". Within one
 * session container a person's save, an agent's write through the MCP server
 * and a `git checkout` all arrive at an open editor as the same filesystem
 * event, and only one of the three may be applied without review. A claim tied
 * to time alone would let an agent's write land inside a colleague's window and
 * be applied as theirs — unreviewed, which is the one outcome the review
 * pipeline exists to prevent. Tied to the content, a claim can only ever match
 * the write it was made for.
 */

const COLLAB_PATH = '/services/studio-collab';

/* How often an open document re-announces itself. Slower than the status
 * line's 2s poll: a roster that is four seconds stale reads as current, and
 * this one crosses a JSON-RPC connection per open document. */
const HEARTBEAT_MS = 4000;

/* Three missed heartbeats. A browser that closes a tab has no chance to say
 * goodbye — the connection simply stops — so every entry has to expire on its
 * own, and the cost of expiring too eagerly is a colleague who blinks out of
 * the roster while they are still reading. */
const PARTY_TTL_MS = 12_000;

/* How long a write claim can be redeemed. Long enough to cover a slow watcher
 * and the 2s mtime poll behind it, short enough that a claim cannot be waiting
 * around for a later write to collide with. The digest is what makes a claim
 * specific; this only stops the map growing. */
const WRITE_CLAIM_TTL_MS = 20_000;

/*
 * FNV-1a over the whole text, with the length mixed in.
 *
 * Deliberately not a cryptographic hash: `crypto.subtle.digest` is async and
 * would put an await inside the single write path, and there is nothing to
 * defend against here. The only two strings that can be compared are two
 * versions of one document seconds apart, and the failure a collision would
 * cause is the SAFE direction anyway — a write attributed to a person who
 * really was writing at that moment.
 */
function bodyDigest(text) {
    const value = String(text == null ? '' : text);
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        // The classic 16777619 multiply, in 32-bit shifts: `*` would lose the
        // low bits to a double once the product passes 2^53.
        hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return value.length.toString(36) + '-' + hash.toString(36);
}

module.exports = { COLLAB_PATH, HEARTBEAT_MS, PARTY_TTL_MS, WRITE_CLAIM_TTL_MS, bodyDigest };
