import { ContainerModule } from '@theia/core/shared/inversify';
import { ExtensionsSourceContribution } from '@theia/vsx-registry/lib/browser/extensions-source-contribution';
import { StudioKitsSource } from './studio-kits-source';

// Desktop only: electron-app depends on this package, browser-app does not,
// so a session never has the Extensions view this contributes to.
export default new ContainerModule(bind => {
    bind(StudioKitsSource).toSelf().inSingletonScope();
    bind(ExtensionsSourceContribution).toService(StudioKitsSource);
});
