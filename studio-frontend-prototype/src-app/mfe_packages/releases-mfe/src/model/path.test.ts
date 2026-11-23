import { describe, expect, it } from "vitest";
import type { DeployEnvironment, ProjectPath } from "../api/types";
import {
  deploymentFromSearch,
  intentOf,
  pathSteps,
  researchEnvironmentFor,
  researchEnvironmentInput,
  researchEnvironmentName,
  researchEnvironmentStale,
  pickableResearchProjects,
  specsStep,
} from "./path";

const path: ProjectPath = {
  organization_id: "org",
  current: "product",
  steps: [{ id: "product", state: "next", reason: "No product", checklist: [], action: { kind: "open_product", label: "" } }],
  running_in: [],
  research_kit: false,
};

describe("the path's Specs step", () => {
  it("is next when the documents name no capability, done when they do, and never blocks", () => {
    expect(specsStep({ count: 0 }).state).toBe("next");
    expect(specsStep({ count: 0 }).action?.kind).toBe("open_specs");
    expect(specsStep({ count: 3 }).state).toBe("done");
    expect(specsStep("unavailable").state).toBe("later");
    expect(pathSteps(path, { count: 2 }).map((s) => s.id)).toEqual(["specs", "product"]);
  });
});

describe("what a step's action does", () => {
  it("opens the screen, tab, dialog or deploy it names", () => {
    expect(intentOf({ kind: "open_sources" })).toEqual({ kind: "screen", route: "/projects/sources" });
    expect(intentOf({ kind: "open_product" })).toEqual({ kind: "screen", route: "/product" });
    expect(intentOf({ kind: "open_gear", gear: "billing" })).toEqual({ kind: "screen", route: "/product" });
    expect(intentOf({ kind: "build" })).toEqual({ kind: "tab", tab: "build" });
    expect(intentOf({ kind: "deploy", environment_id: "e1" })).toEqual({ kind: "deploy", environmentId: "e1", research: false });
    expect(intentOf({ kind: "choose_hardware" })).toEqual({ kind: "deploy", environmentId: null, research: true });
    expect(intentOf({ kind: "provide_secret", key: "SMTP_PASSWORD" })).toEqual({ kind: "tab", tab: "deploy" });
    expect(intentOf({ kind: "sign_in" })).toEqual({ kind: "screen", route: "/connections" });
    expect(intentOf({ kind: "open_log" }, "d1")).toEqual({ kind: "deployment", id: "d1" });
    expect(intentOf({ kind: "open_app", url: "https://shop.example" })).toEqual({ kind: "url", url: "https://shop.example" });
    expect(intentOf({ kind: "something_new" })).toEqual({ kind: "none" });
  });
});

describe("the deploy the address names", () => {
  it("is read from the Inbox's link, and nothing else is taken for one", () => {
    const id = "0b1f5c2a-6f0e-4d7e-9a43-2f5e8c1d9b10";
    expect(deploymentFromSearch(`?screen=releases;org=o;project=p&deployment=${id}`)).toBe(id);
    expect(deploymentFromSearch("?screen=releases;org=o;project=p")).toBeNull();
    expect(deploymentFromSearch("?deployment=<script>")).toBeNull();
  });
});

describe("the Research target", () => {
  const env = (over: Partial<DeployEnvironment>): DeployEnvironment => ({
    id: "e",
    name: "Research",
    description: "",
    kind: "research",
    connection_id: "c",
    registry: "",
    namespace_pattern: "",
    database: "none",
    protected: false,
    ...over,
  } as DeployEnvironment);

  it("reuses the one environment of a Research project, whatever its hardware or name", () => {
    const envs = [
      env({ id: "org", research_project: "rp" }),
      env({ id: "a", name: "research-ml-team-71c6fd", research_project: "rp", research_hardware: "gpu", project_id: "p1" }),
      env({ id: "b", research_project: "other", project_id: "p1" }),
    ];
    expect(researchEnvironmentFor(envs, "rp")?.id).toBe("a");
    expect(researchEnvironmentFor(envs, "other")?.id).toBe("b");
    expect(researchEnvironmentFor([envs[0]], "rp")?.id).toBe("org");
    expect(researchEnvironmentFor(envs, "none")).toBeUndefined();
  });

  it("is changed, not forked, for another hardware or sign-in", () => {
    const own = env({ id: "a", research_project: "rp", research_hardware: "gpu", connection_id: "c1", project_id: "p1" });
    expect(researchEnvironmentStale(own, "c1", "gpu")).toBe(false);
    expect(researchEnvironmentStale(own, "c1", null)).toBe(true);
    expect(researchEnvironmentStale(own, "c2", "gpu")).toBe(true);
    // The organization's is not the project's to change.
    expect(researchEnvironmentStale({ ...own, project_id: null }, "c2", null)).toBe(false);
  });

  it("makes one on the caller's own sign-in otherwise", () => {
    const input = researchEnvironmentInput("conn", { id: "rp", name: "ML team" }, "");
    expect(input).toMatchObject({ kind: "research", connection_id: "conn", research_project: "rp", research_hardware: null, name: "research-ml-team" });
  });

  it("names it as the server takes an environment name, without the hardware", () => {
    const dns = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
    expect(researchEnvironmentName({ id: "8fae8371", name: "Example project" })).toBe("research-example-project");
    expect(researchEnvironmentName({ id: "8fae8371", name: "Example project" }, ["research-example-project"])).toBe(
      "research-example-project-8fae83",
    );
    expect(researchEnvironmentName({ id: "8FAE8371", name: "" })).toBe("research-8fae8371");
    expect(researchEnvironmentName({ id: "x", name: "Проект" })).toBe("research-x");
    const long = researchEnvironmentName({ id: "abcdef12", name: "a".repeat(80) }, ["research-" + "a".repeat(54)]);
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(dns);
  });

  it("lists the Research projects whose Deployment is on first", () => {
    const projects = [
      { id: "off", deployment_enabled: false },
      { id: "on", deployment_enabled: true },
      { id: "unknown" },
    ];
    expect(pickableResearchProjects(projects).map((p) => p.id)).toEqual(["on", "unknown", "off"]);
  });
});
