import 'reflect-metadata';
// As in desktop-studio-widget.test.tsx: the real modules pull in Theia's
// browser barrel and the markdown editor, which this jsdom cannot load.
jest.mock('@theia/workspace/lib/browser/workspace-service', () => ({
    WorkspaceService: class {}
}));
jest.mock('./portal-bridge-contribution', () => ({
    IDENTITY_VIEWER_COMMAND_ID: 'studio.identity.viewer'
}));
import { AssistantsStatus } from '../common/desktop-assistants';
import { DesktopAssistantsContribution } from './desktop-assistants-contribution';

const ENGINE = 'constructorfabric.gearbox-engine';

function contribution(statuses: AssistantsStatus[]) {
    const commands: string[] = [];
    const it = new DesktopAssistantsContribution();
    Object.assign(it, {
        commands: { executeCommand: async (id: string) => { commands.push(id); } },
        messages: {
            info: () => undefined,
            error: async () => undefined,
            showProgress: async () => ({ report: () => undefined, cancel: () => undefined }),
        },
        read: async () => statuses.shift(),
        poll: () => undefined,
    });
    const tick = () => (it as unknown as { tick(): Promise<void> }).tick();
    return { commands, tick };
}

const status = (state: 'installing' | 'ready' | 'failed'): AssistantsStatus => ({
    assistants: [{ id: ENGINE, label: 'Gearbox engine', version: '0.1.0-3b64969', state }],
});

describe('desktop assistants contribution', () => {
    it('reloads the gear catalogue once, when the engine arrives while the app runs', async () => {
        const { commands, tick } = contribution([status('installing'), status('ready'), status('ready')]);

        await tick();
        await tick();
        await tick();

        expect(commands).toEqual(['gearbox.catalogue.reload']);
    });

    it('leaves the catalogue alone when the engine was there from the start', async () => {
        const { commands, tick } = contribution([status('ready'), status('ready')]);

        await tick();
        await tick();

        expect(commands).toEqual([]);
    });
});
