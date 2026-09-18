import 'reflect-metadata';

/*
 * The opener service is mocked because WHICH function is called is the whole
 * assertion. `EditorManager.open` and `open(openerService, …)` both open the
 * file and both look right in a screenshot of a `.rs` file; they differ only
 * for the types this product has a document surface for, and that difference
 * is what this pins.
 */
jest.mock('@theia/core/lib/browser/opener-service', () => ({
    OpenerService: Symbol('OpenerService'),
    open: jest.fn(async () => undefined)
}));

/*
 * These two are injection tokens here and nothing else — the controller holds
 * them, never constructs them. Importing the real modules pulls the workspace
 * service, the editor and the markdown editor's whole widget tree behind them,
 * and the barrel dies on `FrontendApplicationConfigProvider#set` before a
 * single test runs. portal-bridge-contribution.test.ts mocks its collaborators
 * for the same reason and says so.
 */
jest.mock('@theia/workspace/lib/browser/workspace-service', () => ({
    WorkspaceService: class WorkspaceService {}
}));
jest.mock('@theia/filesystem/lib/browser/file-service', () => ({
    FileService: class FileService {}
}));

import URI from '@theia/core/lib/common/uri';
import { open } from '@theia/core/lib/browser/opener-service';
import { OpenInEditorFrontendController } from './open-in-editor-controller';

describe('opening a file the portal asked for', () => {

    function controllerWith(files: readonly string[], roots: readonly string[] = ['file:///workspace']) {
        const controller = new OpenInEditorFrontendController();
        const present = new Set(files);
        Object.assign(controller, {
            openerService: { getOpener: jest.fn() },
            workspaceService: {
                get roots() {
                    return Promise.resolve(roots.map(r => ({ resource: new URI(r) })));
                }
            },
            fileService: {
                exists: jest.fn(async (uri: URI) => present.has(uri.toString())),
                resolve: jest.fn(async () => ({ children: [] }))
            },
            messageService: { warn: jest.fn(), error: jest.fn() },
            logger: { warn: jest.fn() }
        });
        return controller;
    }

    beforeEach(() => (open as jest.Mock).mockClear());

    /*
     * The defect this exists for: the portal opened every document through
     * `EditorManager`, which IS Monaco. Monaco claims every file at priority
     * 100 and the product's document surfaces claim `.md`, `.html` and
     * delimited data at 500 — but calling the editor manager directly skips
     * the contest, so a Markdown document opened from the portal arrived as
     * its own source, line numbers and `#` characters and all.
     */
    it('goes through the opener service, so a document surface can win', async () => {
        const controller = controllerWith(['file:///workspace/docs/prd.md']);

        await controller.onOpenInEditor({ relativePath: 'docs/prd.md' } as never);

        expect(open).toHaveBeenCalledTimes(1);
        const [, uri] = (open as jest.Mock).mock.calls[0];
        expect(uri.toString()).toBe('file:///workspace/docs/prd.md');
    });

    it('passes the request through, so a preview stays a preview where that means something', async () => {
        const controller = controllerWith(['file:///workspace/src/main.rs']);

        await controller.onOpenInEditor({ relativePath: 'src/main.rs', preview: true } as never);

        const [, , options] = (open as jest.Mock).mock.calls[0];
        expect(options).toMatchObject({ mode: 'activate', preview: true });
    });

    it('opens nothing, and says so, when the file is not in the checkout', async () => {
        // Not silence: the usual cause is a source this session never cloned,
        // and a message is the only way that is diagnosable from the IDE.
        const controller = controllerWith([]);

        await controller.onOpenInEditor({ relativePath: 'docs/missing.md' } as never);

        expect(open).not.toHaveBeenCalled();
        expect((controller as never as { messageService: { warn: jest.Mock } }).messageService.warn)
            .toHaveBeenCalled();
    });

    it('ignores a request with no path at all', async () => {
        const controller = controllerWith(['file:///workspace/docs/prd.md']);

        await controller.onOpenInEditor({ relativePath: '' } as never);

        expect(open).not.toHaveBeenCalled();
    });
});
