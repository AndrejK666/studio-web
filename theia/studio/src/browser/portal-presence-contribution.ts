// Reporting an IDE session into the portal's presence registry.
//
// The portal's System page lists who is in Studio right now and lets an
// administrator write to them. Until this, somebody who had opened the IDE and
// left the portal tab behind was invisible there — which is the worst case for
// that list, because it is exactly the person who IS working.
//
// This is NOT the co-editing roster. `product-ext`'s `collab-*` modules answer
// "who has this document open in this container", on a four-second heartbeat,
// inside one session. This answers "this person is in Studio, in the IDE" to a
// gear that spans the assembly, on the portal's own thirty-second cadence. Two
// questions, two mechanisms, and the only thing they share is the subject id.
//
// WHY IT ALSO COLLECTS MESSAGES. Reporting alone would make the portal promise
// something it could not keep: an administrator would see the person listed as
// online and write to them, and the note would sit in a queue they never poll.
// The heartbeat hands notes back in the same response, so appearing in the list
// and being reachable arrive together or not at all.

import { inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { MessageService } from '@theia/core/lib/common/message-service';
import { StudioApi } from './studio-api';

/** The portal's own interval. Deliberately not the collab roster's four
 *  seconds: that one is a local JSON-RPC call whose answer paints a status
 *  line, this one crosses the session gate to a gear whose window is ninety
 *  seconds wide. Beating faster would cost requests and change no answer. */
export const PORTAL_HEARTBEAT_MS = 30_000;

/** One note, as `studio-presence` hands it over. */
interface PresenceNote {
    id: string;
    from_user_id: string;
    from_display_name?: string | null;
    text: string;
    sent_ms: number;
}

interface HeartbeatReply {
    messages?: PresenceNote[];
}

/**
 * What the IDE reports as its location, and what it says it is doing there.
 *
 * `place` is the same vocabulary the portal's own screens use — a short label
 * an administrator reads in a column — and `ide` is the honest one here. The
 * detail is the current widget's own title, which is what the person is
 * looking at and costs nothing to ask for.
 */
export function describeSession(shell: ApplicationShell | undefined): { place: string; detail?: string } {
    const label = shell?.currentWidget?.title?.label;
    return { place: 'ide', detail: typeof label === 'string' && label.trim() ? label.trim() : undefined };
}

@injectable()
export class PortalPresenceContribution implements FrontendApplicationContribution {

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    @inject(MessageService)
    protected readonly messages: MessageService;

    protected timer?: ReturnType<typeof setInterval>;

    onStart(): void {
        // Started unconditionally and gated per beat instead: the token and the
        // viewer arrive over the portal handshake, which has not happened yet
        // at onStart and may happen again later when the person changes under a
        // reused session.
        void this.beat();
        this.timer = setInterval(() => void this.beat(), PORTAL_HEARTBEAT_MS);
    }

    onStop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        // Say goodbye, so the list does not hold somebody for a minute and a
        // half after they closed the session. Best-effort: a killed tab never
        // runs this, which is why the gear expires entries as well.
        void this.leave();
    }

    /**
     * Report once, and show anything that came back.
     *
     * Silent on every failure. A deployment whose backend predates the
     * presence gear answers 404, and an IDE that put an error banner up every
     * thirty seconds over a courtesy feature would be worse than one that
     * simply does not appear in a list.
     */
    protected async beat(): Promise<void> {
        if (!this.reportable()) {
            return;
        }
        const { place, detail } = describeSession(this.shell);
        try {
            const response = await StudioApi.fetch('/studio-presence/v1/me', {
                method: 'POST',
                body: JSON.stringify({
                    display_name: StudioApi.viewer?.name || undefined,
                    place,
                    detail,
                }),
            });
            if (!response.ok) {
                return;
            }
            const reply = (await response.json()) as HeartbeatReply;
            for (const note of reply.messages ?? []) {
                this.show(note);
            }
        } catch {
            // Offline, or the gate is not there. Nothing to say about it.
        }
    }

    protected async leave(): Promise<void> {
        if (!this.reportable()) {
            return;
        }
        try {
            await StudioApi.fetch('/studio-presence/v1/me', { method: 'DELETE' });
        } catch {
            // The gear's own timeout is the backstop.
        }
    }

    /**
     * Whether this session may claim to be a person.
     *
     * Two conditions, and the second is the one that matters. A session with no
     * token cannot call the gear at all. A session whose identity is
     * self-declared — `product-ext`'s `local:<name>`, typed into a text field —
     * MUST NOT be reported: an administrator's list of who is in Studio is
     * read as a list of people, and an unverified name in it would be a claim
     * the product cannot stand behind. Only a viewer the portal authenticated
     * is reported, and the gear keys the record on the token's subject anyway.
     */
    protected reportable(): boolean {
        return Boolean(StudioApi.token && StudioApi.viewer?.sub);
    }

    /**
     * A note, shown where a person working in the IDE will see it.
     *
     * `info`, not a notification that dismisses itself: the note is not stored
     * anywhere — the gear hands each one over exactly once — so a toast that
     * faded while somebody was in another window would be the only copy of it
     * disappearing.
     */
    protected show(note: PresenceNote): void {
        const from = note.from_display_name || note.from_user_id;
        this.messages.info(`${from}: ${note.text}`);
    }
}
