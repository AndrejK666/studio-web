import { describe, expect, it } from "vitest";

import type { Connection, DeployEnvironment, Deployment } from "./api";
import {
  awaitingDecision,
  clusterConnections,
  emptyEnvironment,
  environmentProblem,
  namespaceFor,
  runningNow,
  slug,
} from "./environments";

const env = (over: Partial<DeployEnvironment> = {}): DeployEnvironment => ({
  id: "e1",
  name: "prod",
  description: "",
  connection_id: "c1",
  registry: "ghcr.io/acme",
  namespace_pattern: "{project}-{environment}",
  database: "none",
  protected: true,
  projects: null,
  updated_by: "",
  updated_at: "",
  ...over,
});

const deployment = (over: Partial<Deployment>): Deployment => ({
  id: "d",
  project_id: "p1",
  project_name: "Studio Web",
  environment_id: "e1",
  environment_name: "prod",
  profile: "prod",
  product: "studio-web",
  images: [],
  namespace: "studio-web-prod",
  chart_sha256: "",
  state: "succeeded",
  requested_by: "",
  requested_by_name: "",
  requested_at: "",
  ...over,
});

describe("namespaces", () => {
  it("are made of the project and environment names, as the server makes them", () => {
    expect(slug("Studio Web 2")).toBe("studio-web-2");
    expect(namespaceFor("{project}-{environment}", "Studio Web", "prod")).toBe("studio-web-prod");
    expect(namespaceFor("", "Studio Web", "prod")).toBe("studio-web-prod");
  });
});

describe("an environment form", () => {
  const ready = { ...emptyEnvironment(), name: "stage", connection_id: "c1" };

  it("is fine when named, with a cluster and the default pattern", () => {
    expect(environmentProblem(ready, [env()])).toBeNull();
  });

  it("says what is wrong", () => {
    expect(environmentProblem({ ...ready, name: "Stage" }, [])).toMatch(/lowercase/);
    expect(environmentProblem({ ...ready, name: "prod" }, [env()])).toMatch(/already has/);
    expect(environmentProblem({ ...ready, name: "prod" }, [env()], "e1")).toBeNull();
    expect(environmentProblem({ ...ready, connection_id: "" }, [])).toMatch(/cluster/);
    expect(environmentProblem({ ...ready, namespace_pattern: "{environment}" }, [])).toMatch(/\{project\}/);
    expect(environmentProblem({ ...ready, registry: "https://ghcr.io/acme" }, [])).toMatch(/scheme/);
    expect(environmentProblem({ ...ready, projects: [] }, [])).toMatch(/at least one project/);
  });
});

describe("clusters an environment can name", () => {
  it("are the organization's Kubernetes connections, not personal ones", () => {
    const c = (provider: string, scope: string): Connection => ({
      id: `${provider}-${scope}`,
      owner_tenant_id: "o",
      provider,
      label: "",
      account: "",
      base_url: "",
      scope,
      secret_ref: "",
      created_at_epoch_secs: 0,
    });
    expect(
      clusterConnections([c("kubernetes", "organization"), c("kubernetes", "personal"), c("github", "organization")]).map((x) => x.id),
    ).toEqual(["kubernetes-organization"]);
  });
});

describe("what runs where", () => {
  it("is the newest succeeded deployment per project and environment", () => {
    const list = [
      deployment({ id: "new-failed", state: "failed" }),
      deployment({ id: "new" }),
      deployment({ id: "old" }),
      deployment({ id: "other-env", environment_id: "e2" }),
      deployment({ id: "waiting", state: "awaiting_approval" }),
    ];
    expect(runningNow(list).map((d) => d.id)).toEqual(["new", "other-env"]);
    expect(awaitingDecision(list).map((d) => d.id)).toEqual(["waiting"]);
  });
});
