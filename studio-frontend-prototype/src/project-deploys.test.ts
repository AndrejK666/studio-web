import { describe, expect, it } from "vitest";

import type { Deployment } from "./api";
import { latestByEnvironment, profilesBoundTo } from "./project-deploys";

const dep = (id: string, environment_id: string, state: Deployment["state"]): Deployment => ({
  id,
  project_id: "p1",
  project_name: "Studio Web",
  environment_id,
  environment_name: environment_id,
  profile: "k8s",
  product: "studio-web",
  images: [],
  namespace: `studio-web-${environment_id}`,
  chart_sha256: "",
  state,
  requested_by: "u",
  requested_by_name: "U",
  requested_at: "2026-10-16T10:00:00Z",
});

describe("a project's deploys", () => {
  it("keep the newest deployment in each environment, whatever its state", () => {
    const m = latestByEnvironment([dep("3", "dev", "failed"), dep("2", "dev", "succeeded"), dep("1", "test", "awaiting_approval")]);
    expect(m.get("dev")?.id).toBe("3");
    expect(m.get("test")?.id).toBe("1");
    expect(m.get("prod")).toBeUndefined();
  });

  it("say which profiles go to an environment", () => {
    const b = [
      { profile: "k8s", environment_id: "dev" },
      { profile: "k8s-ha", environment_id: "prod" },
    ];
    expect(profilesBoundTo(b, "dev")).toEqual(["k8s"]);
    expect(profilesBoundTo(b, "test")).toEqual([]);
  });
});
