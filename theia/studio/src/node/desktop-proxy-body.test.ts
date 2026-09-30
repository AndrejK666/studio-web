/**
 * @jest-environment node
 */
// The body the desktop's /studio-api proxy forwards: bytes that can be sent,
// whether a parser read the request first or not.
import { PassThrough } from 'stream';
import { requestBody } from './desktop-studio-contribution';

function request(options: { body?: unknown; ended?: boolean; chunks?: string[] }): never {
    const stream = new PassThrough();
    for (const chunk of options.chunks ?? []) {
        stream.write(chunk);
    }
    stream.end();
    if (options.ended) {
        stream.resume();
    }
    Object.defineProperty(stream, 'body', { value: options.body });
    Object.defineProperty(stream, 'readableEnded', { get: () => options.ended ?? false });
    return stream as never;
}

describe('the body the desktop proxy forwards', () => {
    it('serialises a body @theia/filesystem\'s global json() parser already read', async () => {
        const body = await requestBody(request({ body: { binding_ids: ['a'] }, ended: true }));
        expect(body?.toString()).toBe('{"binding_ids":["a"]}');
    });

    it('reads a stream nobody read to its end', async () => {
        const body = await requestBody(request({ chunks: ['{"a":', '1}'] }));
        expect(body?.toString()).toBe('{"a":1}');
    });

    it('sends nothing for an empty body', async () => {
        expect(await requestBody(request({}))).toBeUndefined();
    });

    it('passes bytes a raw parser left as they are', async () => {
        const raw = Buffer.from('x=1');
        expect(await requestBody(request({ body: raw, ended: true }))).toBe(raw);
    });
});
