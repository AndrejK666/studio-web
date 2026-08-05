// Minimal OIDC Authorization Code + PKCE client (no dependencies).
// Defaults target the dev Keycloak from docker-compose; override via
// VITE_OIDC_ISSUER / VITE_OIDC_CLIENT_ID for an external IdP.
//
// Requirements for ANY IdP (see README "OIDC login"): a public client with
// PKCE (S256), UUID `sub`, and a `tenant_id` claim carrying the user's home
// tenant UUID (validated server-side by the oidc-authn-plugin gear).
//
// Session handling: access tokens are short-lived (Keycloak default 1 h), so
// the refresh token is kept in sessionStorage and used to renew silently —
// both on a timer and after a 401. That also survives a page reload.

import { env } from "./env";

const ISSUER: string = env.oidcIssuer ?? "https://localhost:8443/realms/studio";
const CLIENT_ID: string = env.oidcClientId ?? "studio-portal";

const VERIFIER_KEY = "studio.oidc.verifier";
const REFRESH_KEY = "studio.oidc.refresh";
const ID_TOKEN_KEY = "studio.oidc.id";

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
  if (body.refresh_token) sessionStorage.setItem(REFRESH_KEY, body.refresh_token);
  // Kept for RP-initiated logout (id_token_hint) — lets Sign out end the
  // IdP session too, so the next login shows the account form instead of
  // silently reusing the Keycloak SSO cookie.
  if (body.id_token) sessionStorage.setItem(ID_TOKEN_KEY, body.id_token);
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
    redirect_uri: `${window.location.origin}/`,
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
      redirect_uri: `${window.location.origin}/`,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`SSO token exchange failed: HTTP ${res.status}`);
  return storeSession(await res.json());
}

/**
 * Renew the access token with the stored refresh token. Returns null when no
 * refresh token is stored or the IdP declines (then a full login is needed).
 */
export async function refreshSsoSession(): Promise<SsoSession | null> {
  const refreshToken = sessionStorage.getItem(REFRESH_KEY);
  if (!refreshToken) return null;
  const res = await fetch(tokenEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    sessionStorage.removeItem(REFRESH_KEY);
    return null;
  }
  try {
    return storeSession(await res.json());
  } catch {
    sessionStorage.removeItem(REFRESH_KEY);
    return null;
  }
}

export function hasSsoSession(): boolean {
  return Boolean(sessionStorage.getItem(REFRESH_KEY));
}

export function clearSsoSession(): void {
  sessionStorage.removeItem(REFRESH_KEY);
  sessionStorage.removeItem(ID_TOKEN_KEY);
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
  const idToken = sessionStorage.getItem(ID_TOKEN_KEY);
  const hadSso = hasSsoSession() || Boolean(idToken);
  clearSsoSession();
  if (!hadSso) return false;
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    post_logout_redirect_uri: `${window.location.origin}/`,
  });
  // With the hint Keycloak logs out and redirects straight back; without it
  // (e.g. storage was wiped) it shows its own logout confirmation page.
  if (idToken) params.set("id_token_hint", idToken);
  window.location.href = `${ISSUER}/protocol/openid-connect/logout?${params.toString()}`;
  return true;
}
