/*
 * The browser half of co-editing: announce this document while it is open, and
 * ask who wrote a change that arrived from outside.
 *
 * DEGRADES TO SILENCE, NEVER TO A GUESS. Every call is wrapped, and a failure
 * — a build composed without the backend module, a connection that has not
 * come up yet, a container running standalone — answers "nobody is here" and
 * "nobody claimed that write". Both are the product's behaviour before this
 * existed: no roster, and an unattributed write held for review. The one thing
 * that must never happen is the opposite failure, a write attributed to a
 * person who did not make it, and there is no path here that can produce one:
 * an answer only ever comes from a claim the writer made themselves.
 *
 * See `../common/collab-protocol.js` for why a claim carries a digest, and
 * `../node/collab.js` for why the node backend can answer this at all.
 */

const { RemoteConnectionProvider } =
    require('@theia/core/lib/browser/messaging/service-connection-provider');
const { COLLAB_PATH, HEARTBEAT_MS, bodyDigest } = require('../common/collab-protocol');
const { identity } = require('./identity');

class CollabClient {

    /** @param container the frontend inversify container */
    init(container) {
        try {
            const provider = container.get(RemoteConnectionProvider);
            this.service = provider.createProxy(COLLAB_PATH);
        } catch (error) {
            console.warn('[studio] co-editing unavailable; this session will not see colleagues', error);
            this.service = undefined;
        }
        return this;
    }

    available() { return !!this.service; }

    /**
     * Follow one document for as long as it is open.
     *
     * @param uri            the document
     * @param onRoster       called with everybody else in it, after every beat
     * @returns a handle: `setTyping(bool)` and `dispose()`
     */
    join(uri, onRoster) {
        const doc = uri.toString();
        let typing = false;
        let disposed = false;

        const beat = async () => {
            if (disposed || !this.service) { return; }
            try {
                const answer = await this.service.announce({
                    doc,
                    author: identity.current(),
                    typing
                });
                if (!disposed && onRoster) { onRoster((answer && answer.others) || []); }
            } catch (error) {
                // A dropped beat is not worth a message: the next one is four
                // seconds away, and the roster is decoration.
            }
        };

        void beat();
        const timer = setInterval(beat, HEARTBEAT_MS);

        return {
            /* Typing is reported on the NEXT beat rather than immediately: it
             * changes on every keystroke, and a call per keystroke would be a
             * round trip per keystroke for a dot beside somebody's name. */
            setTyping(next) { typing = !!next; },

            /* Announced eagerly, unlike the arrival — a colleague who leaves
             * should not linger in the roster for three heartbeats when the
             * browser is right there and able to say so. */
            dispose: () => {
                if (disposed) { return; }
                disposed = true;
                clearInterval(timer);
                if (this.service) {
                    Promise.resolve(this.service.depart({ doc })).catch(() => { /* leaving anyway */ });
                }
            }
        };
    }

    /**
     * Everybody in a project, for the collaboration panel.
     *
     * Answers an empty list rather than throwing when the service is not there,
     * so a panel in a standalone build shows "just you" instead of an error —
     * which is both true and the whole state of that deployment.
     */
    async everyone(rootUri) {
        if (!this.service) { return []; }
        try {
            const answer = await this.service.everyone({ prefix: rootUri ? rootUri.toString() : '' });
            return (answer && answer.parties) || [];
        } catch (error) {
            return [];
        }
    }

    /** "The bytes I am writing now are mine." Called from the one write path. */
    async claimWrite(uri, full) {
        if (!this.service) { return; }
        try {
            await this.service.claimWrite({
                doc: uri.toString(),
                author: identity.current(),
                digest: bodyDigest(full)
            });
        } catch (error) {
            /* The claim is what lets a colleague apply this save directly. If
             * it is lost they review it instead — slower, never wrong. */
        }
    }

    /** Who claimed exactly this content, if anybody. */
    async lastWriter(uri, full) {
        if (!this.service) { return undefined; }
        try {
            const answer = await this.service.lastWriter({
                doc: uri.toString(),
                digest: bodyDigest(full)
            });
            return answer && answer.author ? answer : undefined;
        } catch (error) {
            return undefined;
        }
    }
}

const collab = new CollabClient();

module.exports = { collab, CollabClient };
