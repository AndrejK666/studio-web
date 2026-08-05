// Runtime environment for cluster deployments.
//
// The image is built once; per-environment values (IdP issuer, client id,
// links) can't be baked into the bundle. `public/env.js` — regenerated at
// container start by docker/10-runtime-env.sh from STUDIO_* env vars — sets
// `window.__STUDIO_ENV__` before the bundle loads. Build-time `VITE_*` vars
// remain the dev fallback, so `npm run dev` needs no extra setup.

export interface StudioRuntimeEnv {
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  DISCORD_URL?: string;
}

declare global {
  interface Window {
    __STUDIO_ENV__?: StudioRuntimeEnv;
  }
}

const runtime: StudioRuntimeEnv =
  (typeof window !== "undefined" && window.__STUDIO_ENV__) || {};

/** Runtime value beats build-time; both may be absent (callers keep defaults). */
export const env = {
  oidcIssuer:
    runtime.OIDC_ISSUER || (import.meta.env.VITE_OIDC_ISSUER as string | undefined),
  oidcClientId:
    runtime.OIDC_CLIENT_ID || (import.meta.env.VITE_OIDC_CLIENT_ID as string | undefined),
  discordUrl:
    runtime.DISCORD_URL || (import.meta.env.VITE_DISCORD_URL as string | undefined),
};
