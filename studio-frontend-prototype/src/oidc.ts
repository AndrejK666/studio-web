// Minimal OIDC Authorization Code + PKCE client (no dependencies).
// Defaults target the dev Keycloak from docker-compose; override via
// VITE_OIDC_ISSUER / VITE_OIDC_CLIENT_ID for an external IdP.
//
// Requirements for ANY IdP (see README "OIDC login"): a public client with
// PKCE (S256), UUID `sub`, and a `tenant_id` claim carrying the user's home
// tenant UUID (validated server-side by the oidc-authn-plugin gear).
//
// Session handling: access tokens are short-lived (Keycloak default 1 h), so
// the refresh token is kept in storage and used to renew silently — both on a
// timer and after a 401.
//
// It lives in localStorage, not sessionStorage, so the session survives a
// reload AND a second tab. That is a deliberate trade: a refresh token in
// localStorage is readable by any script that gets into the page, and it
// outlives the tab. The alternative was signing people out every time they
// opened the portal beside the one they were already using, which is what
// sessionStorage does. The PKCE verifier stays per-tab, where it belongs — it
// is one login attempt, not a session.

import { env } from "./env";

const ISSUER: string = env.oidcIssuer ?? "https://localhost:8443/realms/studio";
const CLIENT_ID: string = env.oidcClientId ?? "studio-portal";

// Vite's relative base (`./`) lets one image run at `/` on the dedicated POC
// host and at a legacy nested mount. Resolve it against the current document
// so the OIDC callback and post-logout redirect return to the same mount point.
function applicationUrl(): string {
  return new URL(import.meta.env.BASE_URL, window.location.href).toString();
}

const VERIFIER_KEY = "studio.oidc.verifier";
const REFRESH_KEY = "studio.oidc.refresh";
const ID_TOKEN_KEY = "studio.oidc.id";

/** Session storage that degrades instead of throwing.
 *
 *  Private mode and blocked site data make every access throw, and an
 *  exception here would take down sign-in itself rather than the convenience
 *  it provides. A session that cannot be stored simply does not survive a
 *  reload. */
const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* nothing to do — the session lives only in memory */
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      /* already gone as far as anyone can tell */
    }
  },
};

export interface SsoSession {
  accessToken: string;
  /** Seconds until the access token expires (per the IdP). */
  expiresIn: number;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  bytes.forEach((b) => {
    s += String.fromCharCode(b);
  });
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function tokenEndpoint(): string {
  return `${ISSUER}/protocol/openid-connect/token`;
}

function storeSession(body: {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}): SsoSession {
  if (!body.access_token) throw new Error("SSO: no access_token in the token response");
  if (body.refresh_token) store.set(REFRESH_KEY, body.refresh_token);
  // Kept for RP-initiated logout (id_token_hint) — lets Sign out end the
  // IdP session too, so the next login shows the account form instead of
  // silently reusing the Keycloak SSO cookie.
  if (body.id_token) store.set(ID_TOKEN_KEY, body.id_token);
  return { accessToken: body.access_token, expiresIn: body.expires_in ?? 300 };
}

/**
 * Redirect to the IdP's authorization endpoint (never returns).
 * `idpHint` (Keycloak `kc_idp_hint`) jumps straight to a federated identity
 * provider — google / github / microsoft — when one is configured in the
 * realm (Identity Providers section); otherwise Keycloak shows its own form.
 */
export async function startSsoLogin(idpHint?: string): Promise<void> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: applicationUrl(),
    response_type: "code",
    scope: "openid",
    code_challenge: b64url(new Uint8Array(digest)),
    code_challenge_method: "S256",
  });
  if (idpHint) params.set("kc_idp_hint", idpHint);
  window.location.href = `${ISSUER}/protocol/openid-connect/auth?${params.toString()}`;
}

/**
 * If the current URL is an OIDC redirect (?code=...), exchange the code for
 * tokens and clean the URL. Returns null when not a redirect.
 */
export async function completeSsoLogin(): Promise<SsoSession | null> {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!code || !verifier) return null;
  sessionStorage.removeItem(VERIFIER_KEY);
  for (const p of ["code", "state", "session_state", "iss"]) url.searchParams.delete(p);
  window.history.replaceState({}, "", url.pathname + (url.search || ""));

  const res = await fetch(tokenEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: applicationUrl(),
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`SSO token exchange failed: HTTP ${res.status}`);
  return storeSession(await res.json());
}

/** The renewal currently in flight, if any — see [`refreshSsoSession`]. */
let inFlight: Promise<SsoSession | null> | null = null;

/**
 * Renew the access token with the stored refresh token. Returns null when no
 * refresh token is stored or the IdP declines (then a full login is needed).
 *
 * **Single-flight, and that is the point.** A refresh token is single-use when
 * the realm rotates them: the first exchange invalidates it. The portal fires
 * many calls at once, so a burst of 401s used to start a renewal each — one
 * won, the rest were told their token was already spent, and each of those
 * deleted the session that had just been renewed. A signed-in user was thrown
 * back to the login screen seconds after arriving. Everyone now waits on the
 * same exchange.
 */
export function refreshSsoSession(): Promise<SsoSession | null> {
  if (!inFlight) {
    inFlight = exchangeRefreshToken().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function exchangeRefreshToken(): Promise<SsoSession | null> {
  const refreshToken = store.get(REFRESH_KEY);
  if (!refreshToken) return null;
  let res: Response;
  try {
    res = await fetch(tokenEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: refreshToken,
      }),
    });
  } catch {
    // The IdP was unreachable — a network blip, not a verdict on the session.
    // Keep the token; the next 401 or the renewal timer tries again.
    return null;
  }
  if (!res.ok) {
    discardIfStillOurs(refreshToken);
    return null;
  }
  try {
    return storeSession(await res.json());
  } catch {
    discardIfStillOurs(refreshToken);
    return null;
  }
}

/** Forget the session only if nobody has replaced it meanwhile.
 *
 *  Another TAB shares this storage and rotates the same token, so a refusal
 *  can arrive for a token that has already been succeeded by a good one. This
 *  is the cross-tab half of the race the single-flight above closes within
 *  one tab. */
function discardIfStillOurs(attempted: string): void {
  if (store.get(REFRESH_KEY) === attempted) {
    store.remove(REFRESH_KEY);
  }
}

export function hasSsoSession(): boolean {
  return Boolean(store.get(REFRESH_KEY));
}

export function clearSsoSession(): void {
  store.remove(REFRESH_KEY);
  store.remove(ID_TOKEN_KEY);
}

/**
 * RP-initiated logout: clear local state AND end the IdP session, so the
 * next "Sign in with SSO" asks for credentials instead of silently reusing
 * the Keycloak SSO cookie (the "can't switch user" trap).
 *
 * Returns true when a redirect to the IdP was issued (the page navigates
 * away); false when there was no SSO session — static-token logins just
 * clear locally.
 */
export function endSsoSession(): boolean {
  const idToken = store.get(ID_TOKEN_KEY);
  const hadSso = hasSsoSession() || Boolean(idToken);
  clearSsoSession();
  if (!hadSso) return false;
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    post_logout_redirect_uri: applicationUrl(),
  });
  // With the hint Keycloak logs out and redirects straight back; without it
  // (e.g. storage was wiped) it shows its own logout confirmation page.
  if (idToken) params.set("id_token_hint", idToken);
  window.location.href = `${ISSUER}/protocol/openid-connect/logout?${params.toString()}`;
  return true;
}
