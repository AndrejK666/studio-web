import { useState } from "react";
import { api, ApiError, type Me, type Tenant } from "./api";

// Walking-skeleton UI: token -> /me -> children of the home tenant.
// Proves the full chain frontend -> gateway -> authn -> account-management.
export function App() {
  const [token, setToken] = useState("studio-admin-token");
  const [me, setMe] = useState<Me | null>(null);
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function connect() {
    setBusy(true);
    setError(null);
    setMe(null);
    setTenants(null);
    try {
      const who = await api.me(token);
      setMe(who);
      const page = await api.tenantChildren(token, who.subject_tenant_id);
      setTenants(page.items ?? []);
    } catch (e) {
      setError(e instanceof ApiError ? `HTTP ${e.status}: ${JSON.stringify(e.body)}` : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ fontFamily: "system-ui", maxWidth: 720, margin: "3rem auto", padding: "0 1rem" }}>
      <h1>Constructor Studio</h1>
      <p>Backend: <code>/cf</code> (proxied) · OpenAPI: <a href="/cf/docs">/cf/docs</a></p>

      <label>
        Bearer token{" "}
        <input value={token} onChange={(e) => setToken(e.target.value)} size={30} />
      </label>{" "}
      <button onClick={connect} disabled={busy}>
        {busy ? "Connecting…" : "Connect"}
      </button>

      {error && <p style={{ color: "crimson" }}>{error}</p>}

      {me && (
        <section>
          <h2>Me</h2>
          <pre>{JSON.stringify(me, null, 2)}</pre>
        </section>
      )}

      {tenants && (
        <section>
          <h2>Tenants under my home tenant</h2>
          {tenants.length === 0 ? (
            <p>none</p>
          ) : (
            <ul>
              {tenants.map((t) => (
                <li key={t.id}>
                  <strong>{t.name}</strong> — {t.tenant_type.split("~").at(-2) ?? t.tenant_type}
                  {t.self_managed ? " · self-managed" : ""}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
