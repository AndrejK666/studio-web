/**
 * @jest-environment node
 */
import { desktopConfigFrom, folderFor, helperCommand } from './desktop-studio-contribution';

describe('desktop studio contribution', () => {
    it('stays off unless a Studio is named', () => {
        expect(desktopConfigFrom({}, '/here')).toBeUndefined();
    });

    it('derives the realm and the gateway prefix from the Studio address', () => {
        const config = desktopConfigFrom({ STUDIO_DESKTOP_URL: 'https://studio.example.com/' }, '/here')!;
        expect(config.studioUrl).toBe('https://studio.example.com');
        expect(config.issuer).toBe('https://studio.example.com/realms/studio');
        expect(config.gatewayPrefix).toBe('/cf');
        expect(config.clientId).toBe('studio-desktop');
    });

    it('names a workspace folder after the workspace, minus what a file system refuses', () => {
        expect(folderFor('Test Worksoace', 'id-1')).toBe('Test Worksoace');
        expect(folderFor('a/b: c?', 'id-1')).toBe('a-b- c');
        expect(folderFor('  ..  ', 'id-1')).toBe('id-1');
        expect(folderFor(undefined, 'id-1')).toBe('id-1');
    });

    it('runs the credential helper with the app itself, not a Node on PATH', () => {
        expect(helperCommand('C:\\Program Files\\Studio\\Studio.exe', 'C:\\app\\helper.mjs'))
            .toBe('!ELECTRON_RUN_AS_NODE=1 "C:/Program Files/Studio/Studio.exe" "C:/app/helper.mjs"');
    });
});
