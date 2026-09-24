/**
 * The Studios a desktop build can sign in to (ADR-0027). Shared by the IDE
 * backend, which connects to one, and the Studio view, which lets the member
 * choose. Which Studios exist is deployment data: a packaged build carries its
 * list (electron-app/environments.json), and a checkout names one Studio in
 * STUDIO_DESKTOP_URL. Nothing here knows any host.
 */
export interface DesktopEnvironment {
    /** `dev`, `test`, `local`, or `custom` for an address the member typed. */
    readonly id: string;
    readonly label: string;
    /** The Studio's public address; the gateway is under `/cf`. */
    readonly studioUrl: string;
    /** The Keycloak realm to sign in to, i.e. the OIDC issuer's endpoints. */
    readonly issuer: string;
}

/** What the Studio view is told about the choice; never a token. */
export interface DesktopEnvironmentChoice {
    readonly environments: readonly DesktopEnvironment[];
    readonly current?: DesktopEnvironment;
    /** False when STUDIO_DESKTOP_URL pins one Studio for a developer's run. */
    readonly switchable: boolean;
}

/**
 * A Studio address the member typed. The realm is where Studio's own
 * deployments put it (`/auth/realms/studio`), unless they give one.
 */
export function customEnvironment(studioUrl: string, issuer?: string): DesktopEnvironment {
    const url = studioUrl.trim().replace(/\/+$/, '');
    return {
        id: 'custom',
        label: url.replace(/^https?:\/\//, ''),
        studioUrl: url,
        issuer: issuer?.trim().replace(/\/+$/, '') || `${url}/auth/realms/studio`,
    };
}

/** Parse a list of environments, dropping any entry that cannot be used. */
export function parseEnvironments(raw: unknown): DesktopEnvironment[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw.flatMap(entry => {
        const { id, label, studioUrl, issuer } = (entry ?? {}) as Partial<DesktopEnvironment>;
        if (typeof id !== 'string' || typeof studioUrl !== 'string' || !/^https?:\/\//.test(studioUrl)) {
            return [];
        }
        const url = studioUrl.replace(/\/+$/, '');
        return [{
            id,
            label: typeof label === 'string' && label ? label : id,
            studioUrl: url,
            issuer: typeof issuer === 'string' && issuer ? issuer.replace(/\/+$/, '') : `${url}/auth/realms/studio`,
        }];
    });
}
