import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearSsoSession, hasSsoSession, refreshSsoSession } from "./oidc";

/** A minimal Storage that behaves like the real one, including surviving a
 *  reload — which is the whole reason the refresh token lives in one. */
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, value),
  } as Storage;
}

const REFRESH_KEY = "studio.oidc.refresh";

describe("SSO session renewal", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function tokenResponse(body: Record<string, unknown>, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("exchanges the token once when several callers ask at the same time", async () => {
    // The portal fires many calls at once, so a burst of 401s starts a renewal
    // each. With a rotating refresh token the first exchange spends it and the
    // rest are refused — and each refusal used to delete the session that had
    // just been renewed, throwing a signed-in person back to the login screen.
    storage.setItem(REFRESH_KEY, "refresh-1");
    let resolve!: (r: Response) => void;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    vi.stubGlobal("fetch", fetchMock);

    const all = Promise.all([refreshSsoSession(), refreshSsoSession(), refreshSsoSession()]);
    resolve(tokenResponse({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 300 }));
    const sessions = await all;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sessions.map((s) => s?.accessToken)).toEqual(["access-2", "access-2", "access-2"]);
    expect(storage.getItem(REFRESH_KEY)).toBe("refresh-2");
    expect(hasSsoSession()).toBe(true);
  });

  it("starts a new exchange once the previous one has settled", async () => {
    storage.setItem(REFRESH_KEY, "refresh-1");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(tokenResponse({ access_token: "a", refresh_token: "b", expires_in: 300 }));
    vi.stubGlobal("fetch", fetchMock);

    await refreshSsoSession();
    await refreshSsoSession();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ends the session when the IdP refuses the token it was given", async () => {
    storage.setItem(REFRESH_KEY, "refresh-1");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(tokenResponse({}, 400)));

    await expect(refreshSsoSession()).resolves.toBeNull();
    expect(hasSsoSession()).toBe(false);
  });

  it("keeps a session another tab has already renewed", async () => {
    // Two tabs share the storage and rotate the same token. A refusal can
    // therefore arrive for a token that a good one has already replaced —
    // forgetting the session then signs out a tab that is perfectly fine.
    storage.setItem(REFRESH_KEY, "refresh-1");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async () => {
        storage.setItem(REFRESH_KEY, "refresh-from-the-other-tab");
        return tokenResponse({}, 400);
      }),
    );

    await expect(refreshSsoSession()).resolves.toBeNull();
    expect(storage.getItem(REFRESH_KEY)).toBe("refresh-from-the-other-tab");
  });

  it("keeps the session when the IdP is unreachable", async () => {
    // A network blip is not a verdict on the session. Signing out here means
    // losing your place because the wifi dropped for a second.
    storage.setItem(REFRESH_KEY, "refresh-1");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline")));

    await expect(refreshSsoSession()).resolves.toBeNull();
    expect(hasSsoSession()).toBe(true);
  });

  it("has nothing to renew after signing out", async () => {
    storage.setItem(REFRESH_KEY, "refresh-1");
    clearSsoSession();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshSsoSession()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
