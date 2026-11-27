'use strict';
// Events from a VS Code session to Studio (ADR-0080 §4): the same ingress the
// Theia node posts to, with the v2 header, so the backend republishes them as
// `ide.<kind>`. Best effort: an event that cannot be delivered is logged and
// dropped; the backend's reads are what is authoritative.
const { CONTROL_V2, EVENT_KINDS } = require('./protocol');

function ingressUrl(env) {
    const explicit = (env.STUDIO_IDE_EVENT_INGRESS_URL || '').trim();
    if (explicit) return explicit;
    const gateway = (env.STUDIO_GATEWAY_URL || '').trim().replace(/\/+$/, '');
    return gateway ? `${gateway}/studio-theia/v1/events` : '';
}

/** The envelope the ingress reads; the payload goes in `event`, as Theia's forwarder sends it. */
function envelope(env, kind, payload, sequence) {
    const body = {
        session: { workspaceId: env.STUDIO_WORKSPACE_ID || '' },
        kind,
        event: payload === undefined ? null : payload,
    };
    if (env.STUDIO_SESSION_ID) body.session.sessionId = env.STUDIO_SESSION_ID;
    if (typeof sequence === 'number') body.sequence = sequence;
    return body;
}

function createEventSender(env, fetchImpl = globalThis.fetch, log = console) {
    const url = ingressUrl(env);
    const token = (env[CONTROL_V2.tokenEnv] || '').trim();
    return async function send(kind, payload, sequence) {
        if (!EVENT_KINDS.includes(kind)) {
            log.warn(`[studio-bridge] not sent: ${kind} is not an event kind of the protocol`);
            return false;
        }
        if (!url || !token) {
            return false;
        }
        try {
            const response = await fetchImpl(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'X-CFS-Ide-Token': token },
                body: JSON.stringify(envelope(env, kind, payload, sequence)),
            });
            if (!response.ok) {
                log.warn(`[studio-bridge] event ${kind} answered HTTP ${response.status}`);
            }
            return response.ok;
        } catch (error) {
            log.warn(`[studio-bridge] event ${kind} not delivered: ${error && error.message}`);
            return false;
        }
    };
}

module.exports = { createEventSender, envelope, ingressUrl };
