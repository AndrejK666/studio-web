import { describe, expect, it } from "vitest";
import type { ProjectImage } from "../api/types";
import type { IdeBuild } from "./builds";
import { imageRows, parseImageRef, shortVersion } from "./image-rows";

const build = (patch: Partial<IdeBuild>): IdeBuild => ({
  id: "b",
  buildId: "b",
  where: "research",
  action: "build",
  status: "passed",
  product: "shop",
  profile: null,
  commit: null,
  shortSha: null,
  descriptionRevision: null,
  branch: null,
  by: null,
  startedAt: "2026-11-24T09:00:00Z",
  finishedAt: "2026-11-24T09:20:00Z",
  durationMs: null,
  failure: null,
  failureStep: null,
  outputs: [],
  chartRef: null,
  chartVersion: null,
  images: [],
  step: null,
  url: null,
  ...patch,
});

describe("an image reference", () => {
  it("reads a Research image as its name and Research's id", () => {
    expect(parseImageRef("research-image/studioweb/api-gateway:7f3a9c2e-1b4d-4e8a-9c3f-0a1b2c3d4e5f")).toEqual({
      name: "api-gateway",
      version: "7f3a9c2e-1b4d-4e8a-9c3f-0a1b2c3d4e5f",
      host: null,
      research: true,
    });
  });

  it("reads a registry image's host, path and tag or digest, a port not taken for a tag", () => {
    expect(parseImageRef("ghcr.io/acme/studioweb/ui:0.1.0")).toMatchObject({ host: "ghcr.io", name: "acme/studioweb/ui", version: "0.1.0" });
    expect(parseImageRef("registry.local:5000/shop/api@sha256:0123456789abcdef")).toMatchObject({
      host: "registry.local:5000",
      name: "shop/api",
      version: "sha256:0123456789abcdef",
    });
    expect(parseImageRef("registry.local:5000/shop/api")).toMatchObject({ host: "registry.local:5000", version: "" });
    expect(parseImageRef("postgres:16")).toMatchObject({ host: null, name: "postgres", version: "16" });
  });

  it("shortens a digest and a long id for a cell", () => {
    expect(shortVersion("sha256:0123456789abcdef0123")).toBe("sha256:0123456789ab");
    expect(shortVersion("7f3a9c2e-1b4d-4e8a-9c3f-0a1b2c3d4e5f")).toBe("7f3a9c2e-1b4…");
    expect(shortVersion("0.1.0")).toBe("0.1.0");
  });
});

describe("a build's image rows", () => {
  const images = [
    { app: "api-gateway", image: "research-image/studioweb/api-gateway:a1" },
    { app: "studio-database-postgres", image: "research-image/studioweb/postgres:a3" },
  ];

  it("are ready once the build passed, built when it ended, in Research", () => {
    const rows = imageRows(build({ images }), []);
    expect(rows.map((r) => [r.app, r.name, r.version, r.place, r.status, r.builtAt])).toEqual([
      ["api-gateway", "api-gateway", "a1", "research", "ready", "2026-11-24T09:20:00Z"],
      ["studio-database-postgres", "postgres", "a3", "research", "ready", "2026-11-24T09:20:00Z"],
    ]);
  });

  it("are building while it runs, and unconfirmed when a Research build ended after asking for them", () => {
    expect(imageRows(build({ images, status: "running", finishedAt: null }), [])[0]).toMatchObject({ status: "building", builtAt: null });
    expect(imageRows(build({ images, status: "failed" }), [])[0].status).toBe("unconfirmed");
    expect(imageRows(build({ images, status: "failed", where: "studio" }), [])[0].status).toBe("failed");
  });

  it("take when and whether from the registry's record where there is one", () => {
    const record = {
      id: "i1",
      reference: "ghcr.io/acme/shop/api:0.2.0",
      app: "api",
      build_id: "b",
      kind: "image",
      state: "deleted",
      digest: "sha256:abc",
      registry_host: "ghcr.io",
      pushed_at: "2026-11-20T10:00:00Z",
    } as ProjectImage;
    const rows = imageRows(build({ where: "studio", images: [{ app: "api", image: "ghcr.io/acme/shop/api:0.2.0" }] }), [record]);
    expect(rows[0]).toMatchObject({ place: "registry", host: "ghcr.io", status: "gone", builtAt: "2026-11-20T10:00:00Z", versionShort: "0.2.0" });
  });
});
