import { Endpoint } from '@theia/core/lib/browser/endpoint';
import { STUDIO_SIGNED_OUT, StudioApiError, isSignedOut, studioApiUrl } from './studio-api';

function location(pathname: string): Endpoint.Location {
    return {
        host: 'studio-dev-poc.cfabric.org',
        pathname,
        search: '',
        protocol: 'https:',
    };
}

describe('studioApiUrl', () => {
    it('keeps the Kubernetes IDE session path prefix', () => {
        expect(
            studioApiUrl(
                '/studio-artifact-ingest/v1/nodes?scope=project-1',
                location('/studio/349c7f25-2566-42eb-87a2-4b490bbbaab6/'),
            ),
        ).toBe(
            'https://studio-dev-poc.cfabric.org/studio/349c7f25-2566-42eb-87a2-4b490bbbaab6/' +
            'studio-api/studio-artifact-ingest/v1/nodes?scope=project-1',
        );
    });

    it('keeps the root endpoint for standalone sessions', () => {
        expect(studioApiUrl('/mini-chat/v1/chats', location('/'))).toBe(
            'https://studio-dev-poc.cfabric.org/studio-api/mini-chat/v1/chats',
        );
    });
});

describe('StudioApiError', () => {
    const answer = (status: number, body: unknown) => ({
        status,
        json: async () => {
            if (body === undefined) {
                throw new SyntaxError('Unexpected end of JSON input');
            }
            return body;
        },
    }) as unknown as Response;

    it('tells the desktop being signed out from any other failure', async () => {
        const signedOut = await StudioApiError.from(answer(503, { error: 'not signed in to Constructor Studio', reason: STUDIO_SIGNED_OUT }));
        expect(signedOut).toMatchObject({ status: 503, reason: 'signed-out', message: 'HTTP 503' });
        expect(isSignedOut(signedOut)).toBe(true);

        const outage = await StudioApiError.from(answer(503, { error: 'upstream down' }));
        expect(isSignedOut(outage)).toBe(false);
        expect(isSignedOut(new Error('HTTP 503'))).toBe(false);
    });

    it('keeps the status when the answer has no JSON body', async () => {
        const error = await StudioApiError.from(answer(502, undefined));
        expect(error).toMatchObject({ status: 502, reason: undefined, message: 'HTTP 502' });
    });
});
