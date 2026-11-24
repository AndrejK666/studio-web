import { describe, expect, it } from "vitest";
import type { Deployment, DeployEnvironment } from "../api/types";
import type { IdeBuild } from "./builds";
import { ladderSteps } from "./releases";
import {
  attentionStage,
  deployCause,
  fitGap,
  imagesBuild,
  imagesFit,
  imagesPlace,
  readReleaseAddress,
  releaseMap,
  writeReleaseAddress,
} from "./release-map";

const env = (patch: Partial<DeployEnvironment>): DeployEnvironment => ({
  id: "e-dev",
  name: "dev",
  description: "",
  kind: "kubernetes",
  connection_id: "c",
  registry: "ghcr.io/acme",
  namespace_pattern: "",
  database: "none",
  protected: false,
  updated_by: "u",
  updated_at: "2026-11-01T00:00:00Z",
  ...patch,
});

const build = (patch: Partial<IdeBuild>): IdeBuild => ({
  id: patch.buildId ?? "b",
  buildId: "b",
  where: "studio",
  action: "build",
  status: "passed",
  product: "shop",
  profile: null,
  commit: null,
  shortSha: null,
  descriptionRevision: null,
  branch: null,
  by: null,
  startedAt: "2026-11-20T10:00:00Z",
  finishedAt: "2026-11-20T10:10:00Z",
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

const deploy = (patch: Partial<Deployment>): Deployment => ({
  id: "d1",
  project_id: "p",
  project_name: "Shop",
  environment_id: "e-dev",
  environment_name: "dev",
  profile: "prod",
  product: "shop",
  images: [],
  namespace: "shop-dev",
  chart_sha256: "",
  state: "succeeded",
  requested_by: "u",
  requested_by_name: "Ann",
  requested_at: "2026-11-20T11:00:00Z",
  ...patch,
});

const dev = env({});
const research = env({ id: "e-r", name: "hyp3099", kind: "research", research_project: "rp" });
const targets = [
  { environment: dev, namespace: "shop-dev" },
  { environment: research, namespace: "shop" },
];
const three = [
  { app: "api-gateway", image: "research-image://1" },
  { app: "ui", image: "research-image://2" },
  { app: "database", image: "research-image://3" },
];
const charted = build({
  buildId: "studio-2",
  images: [{ app: "api", image: "ghcr.io/acme/shop/api:0.2.0" }],
  chartRef: "oci://ghcr.io/acme/charts/shop",
  chartVersion: "0.2.0",
});
const researched = build({ buildId: "research-1", where: "research", images: three, finishedAt: "2026-11-21T10:00:00Z" });

describe("which images go where", () => {
  it("a Research environment takes only images Research built, a failed build's too once it asked for them", () => {
    expect(imagesFit(researched, research)).toBe(true);
    expect(imagesFit({ ...researched, status: "failed" }, research)).toBe(true);
    expect(imagesFit({ ...researched, status: "running" }, research)).toBe(false);
    expect(imagesFit({ ...researched, images: [] }, research)).toBe(false);
    expect(imagesFit(charted, research)).toBe(false);
  });

  it("a cluster takes a passed build with a published chart", () => {
    expect(imagesFit(charted, dev)).toBe(true);
    expect(imagesFit({ ...charted, chartVersion: null }, dev)).toBe(false);
    expect(imagesFit({ ...charted, status: "failed" }, dev)).toBe(false);
    expect(imagesFit(researched, dev)).toBe(false);
  });

  it("says where images live", () => {
    expect(imagesPlace(researched)).toEqual({ kind: "research" });
    expect(imagesPlace(charted)).toEqual({ kind: "registry", host: "ghcr.io" });
    expect(imagesPlace(build({ chartRef: "oci://registry.local:5000/charts/x" }))).toEqual({ kind: "registry", host: "registry.local:5000" });
    expect(imagesPlace(build({}))).toBeNull();
  });

  it("says why images cannot go to an environment", () => {
    expect(fitGap(charted, research, []).gap).toBe("research_only");
    expect(fitGap(researched, dev, []).gap).toBe("chart_only");
    const prod = env({ id: "e-prod", name: "prod", promote_from: "e-dev" });
    expect(fitGap(charted, prod, []).gap).toBe("promotion");
    expect(fitGap(charted, prod, [deploy({ build: "studio-2" })]).gap).toBeNull();
  });

  it("opens Images on the chosen build, else the newest passed one some environment takes", () => {
    const running = build({ buildId: "research-2", where: "research", status: "running", startedAt: "2026-11-22T10:00:00Z", finishedAt: null });
    expect(imagesBuild([running, researched, charted])?.buildId).toBe("research-1");
    expect(imagesBuild([running, researched, charted], "studio-2")?.buildId).toBe("studio-2");
    expect(imagesBuild([running, researched], "gone")?.buildId).toBe("research-1");
    expect(imagesBuild([running])?.buildId).toBe("research-2");
    expect(imagesBuild([])).toBeNull();
  });
});

describe("the release map", () => {
  it("reads build passed, images 3/3 in Research, the environment deployed to last, and its failed deploy with the cause", () => {
    const failed = deploy({
      id: "d2",
      environment_id: "e-r",
      environment_name: "hyp3099",
      state: "failed",
      build: "research-1",
      requested_at: "2026-11-21T11:00:00Z",
      outcome: "Research refused the application\nmore",
    });
    const deployments = [failed, deploy({ build: "studio-2" })];
    const map = releaseMap({ builds: [researched, charted], steps: ladderSteps(targets, deployments, [researched, charted]), deployments });
    expect(map.build.state).toBe("done");
    expect(map.build.current?.buildId).toBe("research-1");
    expect(map.images).toMatchObject({ state: "done", count: 3, place: { kind: "research" } });
    expect(map.images.fits.map((e) => e.id)).toEqual(["e-r"]);
    expect(map.environment.step?.environment.id).toBe("e-r");
    expect(map.environment).toMatchObject({ state: "done", kind: "research", gap: null });
    expect(map.deploy).toMatchObject({ state: "failed", cause: "Research refused the application", url: null });
    expect(attentionStage(map)).toBe("deploy");
  });

  it("opens on a running build first", () => {
    const running = build({ buildId: "research-2", where: "research", status: "running", step: "images", startedAt: "2026-11-23T10:00:00Z", finishedAt: null });
    const map = releaseMap({ builds: [running, researched], steps: ladderSteps(targets, [], []), deployments: [] });
    expect(map.build.state).toBe("running");
    expect(map.images.build?.buildId).toBe("research-1");
    expect(attentionStage(map)).toBe("build");
  });

  it("marks the environment blocked when the chosen images cannot go there, and a succeeded deploy done with its address", () => {
    const ok = deploy({ environment_id: "e-dev", public_url: "https://shop.example" });
    const map = releaseMap({
      builds: [researched],
      steps: ladderSteps(targets, [ok], [researched]),
      deployments: [ok],
    });
    expect(map.environment.step?.environment.id).toBe("e-dev");
    expect(map.environment).toMatchObject({ state: "blocked", gap: "chart_only" });
    expect(map.deploy).toMatchObject({ state: "done", url: "https://shop.example" });
    expect(attentionStage(map)).toBe("deploy");
  });

  it("takes the environment from the address", () => {
    const map = releaseMap({ builds: [researched], steps: ladderSteps(targets, [], []), deployments: [], environment: "e-r" });
    expect(map.environment.step?.environment.id).toBe("e-r");
    expect(map.deploy.state).toBe("todo");
  });

  it("without a product the first two stages are blocked; without builds there is nothing to deploy", () => {
    const map = releaseMap({ builds: [], steps: ladderSteps(targets, [], []), deployments: [], productMissing: true });
    expect(map.build.state).toBe("blocked");
    expect(map.images.state).toBe("blocked");
    expect(map.environment.state).toBe("todo");
    expect(attentionStage(map)).toBe("deploy");
  });

  it("a failed build with no images fails the Images stage too", () => {
    const failed = build({ buildId: "b9", status: "failed", failure: "boom" });
    const map = releaseMap({ builds: [failed], steps: ladderSteps(targets, [], []), deployments: [] });
    expect(map.build.state).toBe("failed");
    expect(map.images.state).toBe("failed");
    expect(attentionStage(map)).toBe("build");
  });

  it("a deploy's cause is its cause's summary first", () => {
    expect(deployCause(deploy({ state: "failed", cause: { code: "X", summary: "Sign in again.", lines: [], actions: [] }, outcome: "x" }))).toBe("Sign in again.");
    expect(deployCause(deploy({ state: "declined", reason: "not now" }))).toBe("not now");
  });
});

describe("the release's address", () => {
  it("keeps the shell's entry byte for byte and writes only what is chosen", () => {
    const shell = "?screen=releases;org=o;project=p&ent.q=x";
    const written = writeReleaseAddress(shell, { stage: "images", build: "research-1", env: null });
    expect(written).toBe("?screen=releases;org=o;project=p&ent.q=x&rel.stage=images&rel.build=research-1");
    expect(readReleaseAddress(written)).toEqual({ stage: "images", build: "research-1", env: null });
    expect(writeReleaseAddress(written, { stage: null, build: null, env: null })).toBe(shell);
  });

  it("ignores a stage it does not know", () => {
    expect(readReleaseAddress("?rel.stage=nope").stage).toBeNull();
  });
});
