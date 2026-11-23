import { describe, expect, it } from "vitest";
import type { DeployEnvironment } from "../api/types";
import type { IdeBuild } from "./builds";
import {
  byTargetKind,
  environmentTarget,
  noProduct,
  recordedProgress,
  researchBuildsOf,
  researchProjectsWithHardware,
  shortId,
  targetKindOf,
} from "./environment-targets";

const env = (patch: Partial<DeployEnvironment>): DeployEnvironment => ({
  id: "e-dev",
  name: "dev",
  description: "",
  kind: "kubernetes",
  connection_id: "c-k8s",
  registry: "",
  namespace_pattern: "{project}-{environment}",
  database: "none",
  protected: false,
  updated_by: "u1",
  updated_at: "2026-11-01T00:00:00Z",
  ...patch,
});

const research = env({
  id: "e-r",
  name: "research-ml",
  kind: "research",
  connection_id: "c-research",
  research_project: "7eef49216ba24803a6d2e5e86ccda92b",
  research_hardware: "gpu",
});

const names = {
  connections: [
    { id: "c-k8s", label: "webstudio (deployer)", account: "Kubernetes v1.35" },
    { id: "c-research", label: "Constructor Research DEV", account: "dd3a" },
  ],
  researchProjects: [{ id: "7eef49216ba24803a6d2e5e86ccda92b", name: "ML team" }],
  hardware: new Map([["7eef49216ba24803a6d2e5e86ccda92b", [{ id: "gpu", name: "A100" }]]]),
};

const build = (patch: Partial<IdeBuild>): IdeBuild => ({
  id: "n1",
  buildId: "b1",
  where: "studio",
  action: "build",
  status: "passed",
  product: null,
  profile: null,
  commit: null,
  shortSha: null,
  descriptionRevision: null,
  branch: null,
  by: null,
  startedAt: null,
  finishedAt: null,
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

describe("environment targets", () => {
  it("an environment without a kind is a cluster's", () => {
    expect(targetKindOf({})).toBe("kubernetes");
    expect(targetKindOf({ kind: "research" })).toBe("research");
  });

  it("a Kubernetes environment runs in a namespace of its cluster", () => {
    expect(environmentTarget(env({}), "shop-dev", names)).toEqual({
      kind: "kubernetes",
      cluster: "webstudio (deployer)",
      namespace: "shop-dev",
    });
    expect(environmentTarget(env({ connection_id: "gone" }), "shop-dev", names)).toMatchObject({ cluster: null });
  });

  it("a Research environment names its project, hardware and account", () => {
    expect(environmentTarget(research, "shop-research-ml", names)).toEqual({
      kind: "research",
      project: "ML team",
      projectNamed: true,
      hardware: "A100",
      account: "Constructor Research DEV",
    });
  });

  it("a Research project the sign-in does not list shows its short id", () => {
    const t = environmentTarget(research, "ns");
    expect(t).toMatchObject({ project: "7eef4921…", projectNamed: false, hardware: "gpu", account: null });
    expect(shortId("abc")).toBe("abc");
  });

  it("asks for the hardware of the Research projects that name one", () => {
    expect(researchProjectsWithHardware([env({}), research, { ...research, id: "e-2" }])).toEqual([
      "7eef49216ba24803a6d2e5e86ccda92b",
    ]);
  });

  it("splits by place, keeping the order", () => {
    const groups = byTargetKind([research, env({}), env({ id: "e-p", name: "prod" })], (e) => e);
    expect(groups.kubernetes.map((e) => e.name)).toEqual(["dev", "prod"]);
    expect(groups.research.map((e) => e.name)).toEqual(["research-ml"]);
  });

  it("no product while the path's product step is not done", () => {
    expect(noProduct(null)).toBe(false);
    expect(noProduct({ steps: [{ id: "product", state: "next" }] })).toBe(true);
    expect(noProduct({ steps: [{ id: "product", state: "done" }] })).toBe(false);
  });

  it("lists the builds that ran in Research, by where or by their environment", () => {
    const builds = [
      build({ buildId: "r1", where: "research" }),
      build({ buildId: "s1", where: "studio" }),
      build({ buildId: "s2", where: "studio", place: { environmentId: "e-r" } as IdeBuild["place"] }),
    ];
    expect(researchBuildsOf(builds, [env({}), research]).map((b) => b.buildId)).toEqual(["r1", "s2"]);
  });

  it("a running build shows the step it reported, an unknown one as prepare", () => {
    expect(recordedProgress(build({ status: "running", step: "images" }))).toEqual({ step: "images" });
    expect(recordedProgress(build({ status: "running", step: "clone" }))).toEqual({ step: "prepare" });
    expect(recordedProgress(build({ status: "failed", step: "images" }))).toBeNull();
  });
});
