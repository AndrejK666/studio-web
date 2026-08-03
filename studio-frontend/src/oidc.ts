// Minimal OIDC Authorization Code + PKCE client (no dependencies).
// Defaults target the dev Keycloak from docker-compose; override via
// VITE_OIDC_ISSUER / VITE_OIDC_CLIENT_ID for an external IdP.
//
// Requirements for ANY IdP (see README "OIDC login"): a public client with
// PKCE (S256), UUID `sub`, and a `tenant_id` claim carrying the user's home
// tenant UUID (validated server-side by the oidc-authn-plugin gear).

const ISSUER: string =
  (import.meta.env.VITE_OIDC_ISSUER as string | undefined) ??
  "https://localhost:8443/realms/studio";
const CLIENT_ID: string =
  (import.meta.env.VITE_OIDC_CLIENT_ID as string | undefined) ?? "studio-portal";

const VERIFIER_KEY = "studio.oidc.verifier";

function b64url(bytes: Uint8Array): string {
  let s = "";
  bytes.forEach((b) => {
    s += String.fromCharCode(b);
  });
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Redirect to the IdP's authorization endpoint (never returns). */
export async function startSsoLogin(): Promise<void> {
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
  window.location.href = `${ISSUER}/protocol/openid-connect/auth?${params.toString()}`;
}

/**
 * If the current URL is an OIDC redirect (?code=...), exchange the code for
 * an access token and clean the URL. Returns null when not a redirect.
 */
export async function completeSsoLogin(): Promise<string | null> {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!code || !verifier) return null;
  sessionStorage.removeItem(VERIFIER_KEY);
  for (const p of ["code", "state", "session_state", "iss"]) url.searchParams.delete(p);
  window.history.replaceState({}, "", url.pathname + (url.search || ""));

  const res = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
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
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("SSO token exchange: no access_token in response");
  return body.access_token;
}
