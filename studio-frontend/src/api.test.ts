import { afterEach, describe, expect, it } from "vitest";
import { ApiError, alignSessionHost, apiUrl } from "./api";

describe("apiUrl", () => {
  it("prefixes paths with /cf", () => {
    expect(apiUrl("/account-management/v1/me")).toBe("/cf/account-management/v1/me");
  });
  it("normalizes a missing leading slash", () => {
    expect(apiUrl("account-management/v1/me")).toBe("/cf/account-management/v1/me");
  });
});

describe("ApiError", () => {
  it("carries status and body", () => {
    const e = new ApiError(400, { title: "Failed Precondition" });
    expect(e.status).toBe(400);
    expect(e.message).toContain("400");
  });
});

describe("alignSessionHost", () => {
  // The tests run in vitest's default node environment, so `window` has to be
  // faked. Only `location.hostname` is read.
  const at = (hostname: string) => {
    (globalThis as { window?: unknown }).window = { location: { hostname } };
  };
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("moves a localhost session onto the host the portal is served from", () => {
    at("127.0.0.1");
    // Why this matters: the IDE's gate cookie is SameSite=Lax, and
    // 127.0.0.1 vs localhost are different sites — the cookie would be
    // dropped inside the iframe and the IDE would answer 403.
    expect(alignSessionHost("http://localhost:41000/")).toBe("http://127.0.0.1:41000/");
  });

  it("keeps the port and the token query intact", () => {
    at("127.0.0.1");
    expect(alignSessionHost("http://localhost:41007/?token=abc")).toBe(
      "http://127.0.0.1:41007/?token=abc",
    );
  });

  it("leaves a session already on the portal's host alone", () => {
    at("localhost");
    expect(alignSessionHost("http://localhost:41000/")).toBe("http://localhost:41000/");
  });

  it("never rewrites a real hostname — that is deliberate configuration", () => {
    at("127.0.0.1");
    expect(alignSessionHost("http://studio.example.com:41000/")).toBe(
      "http://studio.example.com:41000/",
    );
  });

  it("does not drag a remotely-served portal onto loopback", () => {
    at("studio.example.com");
    expect(alignSessionHost("http://localhost:41000/")).toBe("http://localhost:41000/");
  });

  it("hands back anything that is not a URL", () => {
    at("127.0.0.1");
    expect(alignSessionHost("")).toBe("");
  });
});
