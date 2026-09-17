import 'reflect-metadata';

import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { MessageService } from '@theia/core/lib/common/message-service';
import { PortalPresenceContribution, describeSession } from './portal-presence-contribution';
import { StudioApi } from './studio-api';

/**
 * Reporting an IDE session into the portal's presence gear.
 *
 * The rule worth a test is the gate: a session may call a gear on a token
 * alone, but it may only claim to BE somebody when the portal has said who
 * that is. An administrator's list of who is in Studio is read as a list of
 * people, and the product extension's identity is a display name typed into a
 * text field — reporting that would put an unverified claim in front of
 * somebody making decisions from it.
 */
describe('portal presence', () => {
    const shellWith = (label?: string) =>
        ({ currentWidget: label === undefined ? undefined : { title: { label } } } as unknown as ApplicationShell);

    afterEach(() => {
        StudioApi.token = '';
        StudioApi.viewer = undefined;
        jest.restoreAllMocks();
    });

    function contribution(): PortalPresenceContribution {
        const it = new PortalPresenceContribution();
        (it as unknown as { shell: ApplicationShell }).shell = shellWith('PRD.md');
        (it as unknown as { messages: MessageService }).messages = {
            info: jest.fn()
        } as unknown as MessageService;
        return it;
    }

    it('says where the person is, from the widget they are looking at', () => {
        expect(describeSession(shellWith('PRD.md'))).toEqual({ place: 'ide', detail: 'PRD.md' });
    });

    it('reports no detail rather than an empty one', () => {
        // A blank title and no title are the same fact, and sending "" would
        // give the admin column two ways to render nothing.
        expect(describeSession(shellWith('   '))).toEqual({ place: 'ide', detail: undefined });
        expect(describeSession(shellWith(undefined))).toEqual({ place: 'ide', detail: undefined });
        expect(describeSession(undefined)).toEqual({ place: 'ide', detail: undefined });
    });

    it('does not report a session whose identity the portal has not verified', async () => {
        const fetch = jest.spyOn(StudioApi, 'fetch');
        StudioApi.token = 'a-token';
        StudioApi.viewer = { name: 'Roma' }; // self-declared: no `sub`

        await (contribution() as unknown as { beat(): Promise<void> }).beat();

        expect(fetch).not.toHaveBeenCalled();
    });

    it('does not report before the portal handshake has brought a token', async () => {
        const fetch = jest.spyOn(StudioApi, 'fetch');
        StudioApi.viewer = { sub: 'abc', name: 'Roma' };

        await (contribution() as unknown as { beat(): Promise<void> }).beat();

        expect(fetch).not.toHaveBeenCalled();
    });

    it('reports a verified viewer, and says what they are looking at', async () => {
        const fetch = jest
            .spyOn(StudioApi, 'fetch')
            .mockResolvedValue({ ok: true, json: async () => ({ messages: [] }) } as unknown as Response);
        StudioApi.token = 'a-token';
        StudioApi.viewer = { sub: 'abc', name: 'Roma' };

        await (contribution() as unknown as { beat(): Promise<void> }).beat();

        expect(fetch).toHaveBeenCalledTimes(1);
        const [path, init] = fetch.mock.calls[0];
        expect(path).toBe('/studio-presence/v1/me');
        expect(JSON.parse(String((init as RequestInit).body))).toEqual({
            display_name: 'Roma',
            place: 'ide',
            detail: 'PRD.md'
        });
    });

    it('shows the notes that come back', async () => {
        jest.spyOn(StudioApi, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => ({
                messages: [{ id: 'm1', from_user_id: 'u2', from_display_name: 'Ann', text: 'ping' }]
            })
        } as unknown as Response);
        StudioApi.token = 'a-token';
        StudioApi.viewer = { sub: 'abc', name: 'Roma' };
        const it = contribution();

        await (it as unknown as { beat(): Promise<void> }).beat();

        const messages = (it as unknown as { messages: MessageService }).messages;
        expect(messages.info).toHaveBeenCalledWith('Ann: ping');
    });

    it('stays silent when the gear is not there', async () => {
        // A deployment whose backend predates the gear answers 404, and an IDE
        // that put a banner up every thirty seconds over a courtesy feature
        // would be worse than one that simply does not appear in a list.
        jest.spyOn(StudioApi, 'fetch').mockRejectedValue(new Error('no route'));
        StudioApi.token = 'a-token';
        StudioApi.viewer = { sub: 'abc', name: 'Roma' };
        const it = contribution();

        await expect(
            (it as unknown as { beat(): Promise<void> }).beat()
        ).resolves.toBeUndefined();
        expect((it as unknown as { messages: MessageService }).messages.info).not.toHaveBeenCalled();
    });
});
