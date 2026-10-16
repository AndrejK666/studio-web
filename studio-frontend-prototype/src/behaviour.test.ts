// Bounded behaviour coverage: these pin that a question is asked for each
// action in each state, and is answered only by a passage that names both.
import { describe, expect, it } from "vitest";

import { obligations, statesOf } from "./behaviour";
import type { SpecModelFact } from "./spec-model";

const f = (kind: SpecModelFact["kind"], subject: string, aspect: string, value: string, text = ""): SpecModelFact => ({
  kind,
  subject,
  aspect,
  value,
  text,
  status: "active",
  status_because: "",
  source: { path: "docs/prd/x.md", line_start: 1 },
});

describe("behaviour obligations", () => {
  const facts = [
    f("lifecycle", "Request", "states", "draft, submitted and approved"),
    f("action", "Request", "operator", "edit the request"),
  ];

  it("reads the states a lifecycle lists", () => {
    expect(statesOf(facts[0])).toEqual(["draft", "submitted", "approved"]);
  });

  it("asks for each action in each state", () => {
    const o = obligations(facts);
    expect(o.map((x) => x.state)).toEqual(["draft", "submitted", "approved"]);
    expect(o.every((x) => x.answer === null)).toBe(true);
    expect(o[0].key).toMatch(/^ob:[0-9a-f]{16}$/);
  });

  it("counts a passage as an answer only when it names the action and the state", () => {
    const answer = f("constraint", "Request", "who may edit", "", "An approved request can no longer be edited by anyone.");
    const o = obligations([...facts, answer]);
    expect(o.find((x) => x.state === "approved")?.answer).toBe(answer);
    expect(o.find((x) => x.state === "draft")?.answer).toBeNull();
  });

  it("asks nothing of a thing with fewer than two states", () => {
    expect(obligations([f("lifecycle", "Note", "states", "open"), f("action", "Note", "user", "close it")])).toEqual([]);
  });
});
