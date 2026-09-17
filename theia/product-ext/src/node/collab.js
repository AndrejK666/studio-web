/*
 * Who else is in this document, and who wrote it last.
 *
 * WHY THE NODE BACKEND IS THE RIGHT PLACE, and the only one. The product
 * already had a duplicate-session detector (`browser/session-lock.js`) built on
 * BroadcastChannel, which is same-origin and same-browser-profile: it sees one
 * person's second TAB and nothing else. Two colleagues are two browsers, so it
 * cannot see them, and it says so.
 *
 * What it could not know is that the server side of that problem is already
 * solved by the deployment. `studio-session` derives a session id from the
 * workspace (`session_id_for(workspace_id)`, a UUIDv5) and admits one live
 * session per workspace, so everybody who opens a workspace is served by ONE
 * container and therefore by one Theia node process, over one shared checkout.
 * That process is a place both browsers can see. No new service, no database,
 * no CRDT: a map in the process that already holds the files they are editing.
 *
 * WHAT IT DELIBERATELY IS NOT. This is not a synchronisation engine. Two people
 * typing into the same paragraph at the same moment still resolve the way they
 * did before — through the file, at save time, with the conflict state the
 * editor already has. What this adds is the two things the product could not
 * do at all: SAY who else is here, and TELL APART a colleague's save from an
 * agent's write. The second is the one with teeth, because the editor's answer
 * to an unattributed write is to hold the document for review, and doing that
 * to a person's ordinary save is requirement 14's explicit "remote human edits
 * are not AI suggestions".
 *
 * LIFETIME. Entries expire (PARTY_TTL_MS) rather than being deleted on
 * disconnect. A closed tab gets no chance to say goodbye, and a container whose
 * users have all gone home should not be holding a timer to notice — so the
 * sweep runs inside the calls, and a registry nobody is calling costs nothing.
 */

const crypto = require('crypto');
const { ContainerModule } = require('inversify');
const { ConnectionContainerModule } = require('@theia/core/lib/node/messaging/connection-container-module');
const { COLLAB_PATH } = require('../common/collab-protocol');
const { CollabRegistry } = require('./collab-registry');

/**
 * The per-connection face of the registry.
 *
 * One of these per browser, so the connection id never has to be sent over the
 * wire and one browser cannot announce itself as another.
 */
class CollabService {

    constructor(registry) {
        this.registry = registry;
        this.partyId = crypto.randomUUID();
    }

    async announce(request) {
        const req = request || {};
        return { others: this.registry.announce(this.partyId, req.doc, req.author, req.typing) };
    }

    async depart(request) {
        this.registry.depart(this.partyId, (request || {}).doc);
    }

    /*
     * Includes ME. The document roster excludes the caller because a person
     * reading one file does not need to be told they are in it; a project
     * roster that left the caller out would say "nobody is here" to somebody
     * who plainly is, and the panel would have to add itself back guessing at
     * which entry was theirs.
     */
    async everyone(request) {
        return { parties: this.registry.everyone((request || {}).prefix) };
    }

    async claimWrite(request) {
        const req = request || {};
        this.registry.claimWrite(req.doc, req.author, req.digest);
    }

    async lastWriter(request) {
        const req = request || {};
        return this.registry.lastWriter(req.doc, req.digest) || undefined;
    }
}

const connectionModule = ConnectionContainerModule.create(({ bind, bindBackendService }) => {
    // No decorators: this package is plain CommonJS with no build step, so
    // inversify is given a factory rather than asked to construct the class.
    // `ctx.container` is the connection's child container, so the registry
    // resolves up to the one bound process-wide below.
    bind(CollabService).toDynamicValue(ctx =>
        new CollabService(ctx.container.get(CollabRegistry))).inSingletonScope();
    bindBackendService(COLLAB_PATH, CollabService);
});

const mod = new ContainerModule(bind => {
    bind(CollabRegistry).toDynamicValue(() => new CollabRegistry()).inSingletonScope();
    bind(ConnectionContainerModule).toConstantValue(connectionModule);
});

module.exports = mod;
module.exports.default = mod;
module.exports.CollabRegistry = CollabRegistry;
module.exports.CollabService = CollabService;
module.exports.COLLAB_PATH = COLLAB_PATH;
