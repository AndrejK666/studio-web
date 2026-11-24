import { describe, expect, it } from "vitest";
import type { Deployment, DeployEnvironment } from "../api/types";
import type { IdeBuild } from "./builds";
import { deployTargets } from "./deploy-targets";

const env = (id: string, kind: "kubernetes" | "research" = "research", description = ""): DeployEnvironment =>
  ({ id, name: id, description, kind, connection_id: "c", registry: "", namespace_pattern: "", database: "none", protected: false }) as DeployEnvironment;

const build = (over: Partial<IdeBuild>): IdeBuild => ({ buildId: "b", status: "passed", where: "research", ...over }) as IdeBuild;

const ran = (environment_id: string): Deployment => ({ id: `d-${environment_id}`, environment_id, state: "succeeded" }) as Deployment;

describe("the deploy dialog's environments", () => {
  const envs = [env("research-test"), env("dev", "kubernetes"), env("research-graph-gear-v3"), env("stage", "kubernetes", "shared stage")];

  it("lists where a build can go, and folds the rest into one line", () => {
    const t = deployTargets(envs, [build({ where: "research" })], [], null);
    expect(t.open.map((r) => r.env.id)).toEqual(["research-graph-gear-v3", "research-test"]);
    expect(t.folded.map((r) => r.env.id)).toEqual(["dev", "stage"]);
    expect(t.open[0].newest?.buildId).toBe("b");
  });

  it("puts the one it was opened on first, then those running something", () => {
    const t = deployTargets(envs, [build({})], [ran("research-test")], "dev");
    expect(t.open.map((r) => r.env.id)).toEqual(["dev", "research-test", "research-graph-gear-v3"]);
    expect(t.open[1].latest?.id).toBe("d-research-test");
    expect(t.folded.map((r) => r.env.id)).toEqual(["stage"]);
  });

  it("narrows both to what was typed, by name or description", () => {
    const t = deployTargets(envs, [build({})], [], null, "STAGE");
    expect(t.open).toEqual([]);
    expect(t.folded.map((r) => r.env.id)).toEqual(["stage"]);
    expect(deployTargets(envs, [], [], null, "graph").folded.map((r) => r.env.id)).toEqual(["research-graph-gear-v3"]);
  });
});
