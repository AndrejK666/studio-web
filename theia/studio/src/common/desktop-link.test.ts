import { desktopLink, environmentFor, isCurrent, parseDesktopLink } from './desktop-link';
import { DesktopEnvironment } from './desktop-environments';

const dev: DesktopEnvironment = {
    id: 'dev',
    label: 'Dev',
    studioUrl: 'https://studio-dev.cfabric.org',
    issuer: 'https://studio-dev.cfabric.org/auth/realms/studio',
};
const local: DesktopEnvironment = {
    id: 'local',
    label: 'Local',
    studioUrl: 'http://127.0.0.1:8090',
    issuer: 'http://127.0.0.1:8088/realms/studio',
};
const PROJECT = 'd5e76267-60e3-4153-8e60-d4d8753ed01e';

describe('the desktop link', () => {
    it('reads what the portal writes', () => {
        const link = { project: PROJECT, name: 'Studioweb', studioUrl: dev.studioUrl, issuer: dev.issuer };
        expect(parseDesktopLink(desktopLink(link))).toEqual(link);
    });

    it('takes the action as the host or as the path', () => {
        expect(parseDesktopLink(`cfstudio://open?project=${PROJECT}`)?.project).toBe(PROJECT);
        expect(parseDesktopLink(`cfstudio:open?project=${PROJECT}`)?.project).toBe(PROJECT);
    });

    it('acts on nothing but its own scheme, action and a project id', () => {
        expect(parseDesktopLink(`https://open?project=${PROJECT}`)).toBeUndefined();
        expect(parseDesktopLink(`cfstudio://delete?project=${PROJECT}`)).toBeUndefined();
        expect(parseDesktopLink('cfstudio://open')).toBeUndefined();
        expect(parseDesktopLink('cfstudio://open?project=../../etc')).toBeUndefined();
        expect(parseDesktopLink('not a url')).toBeUndefined();
    });

    it('drops a Studio address that is not the web', () => {
        const link = parseDesktopLink(`cfstudio://open?project=${PROJECT}&studio=file:///c:/x&issuer=javascript:alert(1)`);
        expect(link).toEqual({ project: PROJECT, name: undefined, studioUrl: undefined, issuer: undefined });
    });

    it('matches the Studio by its realm before its address', () => {
        // The portal a person clicked on is not the address the desktop signs
        // in to; the realm is the same.
        const fromPrototype = { project: PROJECT, studioUrl: 'https://studio-dev-poc.cfabric.org', issuer: `${dev.issuer}/` };
        expect(environmentFor(fromPrototype, [local, dev])).toBe(dev);
        expect(environmentFor({ project: PROJECT, studioUrl: 'http://127.0.0.1:8090/' }, [dev, local])).toBe(local);
        expect(environmentFor({ project: PROJECT, studioUrl: 'https://elsewhere.example' }, [dev, local])).toBeUndefined();
    });

    it('knows when the link is about the Studio in use', () => {
        expect(isCurrent({ project: PROJECT, issuer: dev.issuer }, dev)).toBe(true);
        expect(isCurrent({ project: PROJECT, issuer: dev.issuer }, local)).toBe(false);
        expect(isCurrent({ project: PROJECT }, local)).toBe(true);
        expect(isCurrent({ project: PROJECT }, undefined)).toBe(false);
    });
});
