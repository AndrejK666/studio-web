/**
 * Runtime environment for the portal.
 *
 * Resolution order: `window.__STUDIO_ENV__` (`/env.js`, written at container
 * start by docker/10-runtime-env.sh — the same image runs in every environment
 * without a rebuild — and served by the dev server for the stand it faces,
 * scripts/lib/stands.ts) wins over the build-time `VITE_*` variables, the
 * fallback for a build served without either. Both may be absent — callers
 * own defaults.
 */

export interface StudioRuntimeEnv {
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  DISCORD_URL?: string;
  /**
   * `"true"` where the realm brokers the Constructor IdP (alias
   * `constructor`): the deployment says so, because nothing the browser can
   * ask before sign-in lists a realm's brokers.
   */
  CONSTRUCTOR_SIGN_IN?: string;
  /** `"true"` where the realm brokers GitLab (alias `gitlab`), for the same reason. */
  GITLAB_SIGN_IN?: string;
}

declare global {
  interface Window {
    __STUDIO_ENV__?: StudioRuntimeEnv;
  }
}

function runtime(): StudioRuntimeEnv {
  return typeof window !== 'undefined' ? (window.__STUDIO_ENV__ ?? {}) : {};
}

export const env = {
  get oidcIssuer(): string | undefined {
    return runtime().OIDC_ISSUER || (import.meta.env.VITE_OIDC_ISSUER as string | undefined);
  },
  get oidcClientId(): string | undefined {
    return runtime().OIDC_CLIENT_ID || (import.meta.env.VITE_OIDC_CLIENT_ID as string | undefined);
  },
  get discordUrl(): string | undefined {
    return runtime().DISCORD_URL || (import.meta.env.VITE_DISCORD_URL as string | undefined);
  },
  /** Whether the sign-in screen offers Constructor. Off unless said, never guessed. */
  get constructorSignIn(): boolean {
    const raw =
      runtime().CONSTRUCTOR_SIGN_IN ??
      (import.meta.env.VITE_CONSTRUCTOR_SIGN_IN as string | undefined);
    return raw?.trim().toLowerCase() === 'true';
  },
  /** Whether the sign-in screen offers GitLab. Off unless said, never guessed. */
  get gitlabSignIn(): boolean {
    const raw =
      runtime().GITLAB_SIGN_IN ?? (import.meta.env.VITE_GITLAB_SIGN_IN as string | undefined);
    return raw?.trim().toLowerCase() === 'true';
  },
};
