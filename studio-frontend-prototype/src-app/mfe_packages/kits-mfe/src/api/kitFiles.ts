/**
 * A kit's files (studio-kits): its `kit.gdl`, its source manifest and an archive of its
 * contents (`GET /catalog/{slug}/kit.gdl | manifest | archive`).
 *
 * Not through the REST protocol: it reads every answer as text, which mangles a binary
 * archive, and its descriptors take no response type. So these go through `fetch`, with the
 * host's session the way `authShared()` reads it: a bearer token in the header, or the session
 * cookie on the same origin. A 401 asks the host to refresh once, as the shared auth plugin does.
 * (The same shape as reports-mfe's `download.ts`.)
 */

import { readSharedAuthSession } from '@constructor-studio/mfe-shared';
import { KITS_API_BASE_URL } from './KitsApiService';

/** One of a kit's files. */
export type KitFile = 'kit.gdl' | 'manifest' | 'archive';

/** A refused read: its status and the server's own words, when it gave some. */
export class KitFileError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'KitFileError';
  }
}

/** The URL of `slug`'s `file`; an organization's own kit is read in that organization. */
export function kitFileUrl(slug: string, file: KitFile, organizationId?: string | null): string {
  const query = organizationId ? `?organization_id=${encodeURIComponent(organizationId)}` : '';
  return `${KITS_API_BASE_URL}/catalog/${encodeURIComponent(slug)}/${file}${query}`;
}

async function authHeaders(refreshed = false): Promise<Record<string, string>> {
  const accessor = readSharedAuthSession();
  if (!accessor) return {};
  const session = refreshed && accessor.refresh ? await accessor.refresh() : await accessor.getSession();
  return session?.kind === 'bearer' && session.token ? { Authorization: `Bearer ${session.token}` } : {};
}

async function failure(res: Response): Promise<KitFileError> {
  const text = await res.text().catch(() => '');
  let message = text.trim();
  try {
    const body = JSON.parse(text) as { detail?: unknown; title?: unknown; message?: unknown };
    const said = body.detail ?? body.message ?? body.title;
    if (typeof said === 'string' && said) message = said;
  } catch {
    // Not JSON: the text itself.
  }
  return new KitFileError(res.status, message || `${res.status} ${res.statusText}`.trim());
}

async function get(url: string): Promise<Response> {
  let res = await fetch(url, { headers: await authHeaders(), credentials: 'same-origin' });
  if (res.status === 401 && readSharedAuthSession()?.refresh) {
    res = await fetch(url, { headers: await authHeaders(true), credentials: 'same-origin' });
  }
  if (!res.ok) throw await failure(res);
  return res;
}

/** A kit's file as text: its `kit.gdl` or its source manifest. */
export async function fetchKitText(url: string): Promise<string> {
  return (await get(url)).text();
}

/** A kit's file as a blob: its archive. */
export async function fetchKitBlob(url: string): Promise<Blob> {
  return (await get(url)).blob();
}

/** Hand a blob to the browser as a file named `name`. */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
