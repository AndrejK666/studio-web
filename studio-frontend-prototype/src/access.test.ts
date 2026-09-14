import { describe, expect, it } from "vitest";

import { PRIVILEGES, defaultRoles, normalizeAccessConfig } from "./access";

// Read through Vite's `?raw` rather than `node:fs`: this project is typed for
// the browser (`types: ["vite/client"]`) and has no `@types/node`, and one
// parity test is not worth a dependency.
import backendSource from "../../studio-backend/src/access_config.rs?raw";

/* ── The catalogue has two implementations and one meaning ────────────────────
 *
 * `PRIVILEGES` and `defaultRoles()` exist here in TypeScript and in
 * `studio-backend/src/access_config.rs` in Rust. The backend seeds the ladder
 * into the stored document; this screen overwrites that document wholesale when
 * somebody saves the Access page. So a disagreement is not cosmetic — it writes
 * roles whose privileges the PDP will never match, and the role silently
 * carries nothing.
 *
 * These tests read the Rust file rather than trusting a copied list, because a
 * copied list is exactly what drifted before (ADR-0019 §2).
 */

/** The `PRIVILEGES` array from the Rust catalogue, in order. */
function backendPrivileges(source: string): string[] {
  const block = /pub const PRIVILEGES: \[&str; (\d+)\] = \[([\s\S]*?)\];/.exec(source);
  if (!block) throw new Error("could not find PRIVILEGES in access_config.rs");
  const ids = [...block[2].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  expect(ids).toHaveLength(Number(block[1]));
  return ids;
}

describe("the privilege catalogue", () => {
  it("is the same list the backend seeds, in the same order", () => {
    expect(PRIVILEGES.map((p) => p.id)).toEqual(backendPrivileges(backendSource));
  });

  it("names nothing the product retired", () => {
    // Projects are account-management tenants (ADR-0010) and `studio-project`
    // — the gear "Works" belonged to — is gone. A privilege for either would
    // have to be granted to everybody in order not to break them.
    for (const { id } of PRIVILEGES) {
      expect(id.startsWith("project."), `${id} names a retired resource`).toBe(false);
      expect(id.startsWith("work."), `${id} names a retired resource`).toBe(false);
    }
  });

  it("gives every privilege a group and a label", () => {
    for (const p of PRIVILEGES) {
      expect(p.group.length, `${p.id} has no group`).toBeGreaterThan(0);
      expect(p.label.length, `${p.id} has no label`).toBeGreaterThan(0);
    }
  });
});

describe("the seeded ladder", () => {
  const roles = defaultRoles();
  const role = (key: string) => {
    const found = roles.find((r) => r.key === key);
    if (!found) throw new Error(`no ${key} role`);
    return found;
  };

  it("is the owner → viewer ladder the backend seeds", () => {
    expect(roles.map((r) => r.key)).toEqual(["owner", "admin", "editor", "viewer"]);
  });

  it("grants an owner the whole catalogue", () => {
    expect(role("owner").privileges).toEqual(PRIVILEGES.map((p) => p.id));
  });

  it("withholds exactly `access.manage` from an admin", () => {
    // Running the organization is an administrator's job; deciding who may run
    // it is the owner's (ADR-0019 §2). One privilege is the whole difference.
    const admin = role("admin").privileges;
    expect(admin).not.toContain("access.manage");
    expect(admin).toContain("people.manage");
    expect(admin).toHaveLength(PRIVILEGES.length - 1);
  });

  it("gives a viewer only reads", () => {
    const viewer = role("viewer").privileges;
    expect(viewer.length).toBeGreaterThan(0);
    for (const id of viewer) expect(id.endsWith(".view")).toBe(true);
  });

  it("names only privileges that exist", () => {
    const known = new Set(PRIVILEGES.map((p) => p.id));
    for (const r of roles) {
      for (const id of r.privileges) {
        expect(known.has(id), `role ${r.key} names unknown privilege ${id}`).toBe(true);
      }
    }
  });
});

describe("normalizing a stored config", () => {
  it("fills a missing ladder in rather than leaving a grant unresolvable", () => {
    const cfg = normalizeAccessConfig({ model: "roles", roles: [], grants: [] });
    expect(cfg.roles.map((r) => r.key)).toEqual(["owner", "admin", "editor", "viewer"]);
  });

  it("treats anything but `roles` as the tenant model", () => {
    expect(normalizeAccessConfig(null).model).toBe("tenant");
    expect(normalizeAccessConfig({ model: "roles" }).model).toBe("roles");
  });
});
