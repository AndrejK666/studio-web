// The Product view's words for the product as a whole, without a widget.
import type { Diagnostic } from "../../common/generated/Diagnostic";
import {
  gearHealth,
  humanizeFeature,
  inclusionChip,
  nextStepOf,
  plural,
  profileLabel,
} from "./product-summary";

const diagnostic = (severity: Diagnostic["severity"], subject?: string): Diagnostic =>
  ({ code: "GBX0001", severity, message: "m", subject }) as unknown as Diagnostic;

describe("plural", () => {
  it("agrees with its count", () => {
    expect(plural(1, "warning", "warnings")).toBe("1 warning");
    expect(plural(0, "warning", "warnings")).toBe("0 warnings");
    expect(plural(3, "warning", "warnings")).toBe("3 warnings");
  });
});

describe("profileLabel", () => {
  it("adds the portal's words for the kind", () => {
    expect(profileLabel("local", "self_hosted")).toBe("local · processes on one host");
    expect(profileLabel("dev", "embedded")).toBe("dev · one process");
    expect(profileLabel("prod", "kubernetes")).toBe("prod · Kubernetes");
  });

  it("keeps the bare id when the kind is unknown", () => {
    expect(profileLabel("edge", undefined)).toBe("edge");
    expect(profileLabel("edge", "something-new")).toBe("edge");
  });
});

describe("nextStepOf", () => {
  const clean = { status: "ready" as const, stale: false, failed: false, conflicts: 0, pending: 0, gears: 2, canGenerate: true };

  it("offers Generate for a clean product", () => {
    expect(nextStepOf(clean).kind).toBe("generate");
  });

  it("sends conflicts to Checks before unapplied edits to Apply", () => {
    expect(nextStepOf({ ...clean, conflicts: 1, pending: 2 })).toMatchObject({ kind: "checks", title: "Resolve 1 conflict" });
    expect(nextStepOf({ ...clean, pending: 2 })).toMatchObject({ kind: "apply", title: "Apply 2 changes" });
  });

  it("puts a lost engine and a failed check first", () => {
    expect(nextStepOf({ ...clean, stale: true, conflicts: 3 }).kind).toBe("reconnect");
    expect(nextStepOf({ ...clean, failed: true, conflicts: 3 }).kind).toBe("retry");
  });

  it("waits while checking, and asks for a gear in an empty product", () => {
    expect(nextStepOf({ ...clean, status: "resolving" }).kind).toBe("wait");
    expect(nextStepOf({ ...clean, gears: 0 }).kind).toBe("add-gear");
  });
});

describe("humanizeFeature", () => {
  it("reads a Cargo feature name as words", () => {
    expect(humanizeFeature("theia-bridge")).toBe("Theia bridge");
    expect(humanizeFeature("k8s_auth")).toBe("K8s auth");
    expect(humanizeFeature("default")).toBe("Default");
  });
});

describe("gearHealth", () => {
  it("keeps the worst problem per gear, and only gear subjects", () => {
    const health = gearHealth([
      diagnostic("warning", "gear:a"),
      diagnostic("error", "gear:a"),
      diagnostic("warning", "gear:a"),
      diagnostic("warning", "gear:b"),
      diagnostic("error", "binding:a|c"),
      diagnostic("info", "gear:c"),
      diagnostic("error"),
    ]);
    expect([...health.entries()]).toEqual([
      ["a", "error"],
      ["b", "warning"],
    ]);
  });
});

describe("inclusionChip", () => {
  it("names who put the gear here", () => {
    expect(inclusionChip({ reason: "selected" })).toBe("Added by you");
    expect(inclusionChip({ reason: "colocated_by", gear: "api-gateway" })).toBe("Required by api-gateway");
    expect(inclusionChip({ reason: "plugin_of", host: "authn", profile: "local" })).toBe("Plugin of authn");
  });
});
