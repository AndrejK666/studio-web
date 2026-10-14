// An organization's logo, read once and shared: the path bar, the
// organization switcher and the organization's overview all show it, and a
// new one set on the overview appears in the other two at once.

import { useEffect, useSyncExternalStore } from "react";

import { api, type OrganizationLogo } from "./api";

/** A logo is a small mark: what the backend keeps at most. */
export const MAX_LOGO_BYTES = 256 * 1024;
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** The image as an `<img>` source. */
export function logoSrc(logo: Pick<OrganizationLogo, "content_type" | "data">): string {
  return `data:${logo.content_type};base64,${logo.data}`;
}

/** Why a picked file cannot be a logo, or null when it can. */
export function logoFileProblem(file: Pick<File, "type" | "size">): string | null {
  if (!LOGO_TYPES.includes(file.type)) return "Pick a PNG, JPEG, WebP or GIF image.";
  if (file.size > MAX_LOGO_BYTES)
    return `The logo is ${Math.ceil(file.size / 1024)} KiB; at most ${MAX_LOGO_BYTES / 1024} KiB is kept.`;
  return null;
}

/** Each organization's logo as an `<img>` source; null when it has none. A
 *  key that is absent has not been read yet. */
const logos = new Map<string, string | null>();
const reading = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version++;
  for (const l of listeners) l();
}

/** Put a logo in place, or none: after a person set or removed it. */
export function rememberLogo(orgId: string, src: string | null) {
  logos.set(orgId, src);
  changed();
}

function read(token: string, orgId: string) {
  if (logos.has(orgId) || reading.has(orgId)) return;
  reading.add(orgId);
  api
    .organizationLogo(token, orgId)
    .then((logo) => rememberLogo(orgId, logoSrc(logo)))
    // None (404), or not readable here: the initial is shown either way, and
    // it is not asked again on every render.
    .catch(() => rememberLogo(orgId, null))
    .finally(() => reading.delete(orgId));
}

/** The organization's logo as an `<img>` source, or null: read on first use. */
export function useOrgLogo(token: string, orgId: string | null | undefined): string | null {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
  useEffect(() => {
    if (orgId) read(token, orgId);
  }, [token, orgId]);
  return orgId ? (logos.get(orgId) ?? null) : null;
}
