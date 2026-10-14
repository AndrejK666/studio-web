import { describe, expect, it } from "vitest";
import {
  addReviewer,
  canDecide,
  currentRequest,
  isStale,
  reviewRequestBody,
  reviewState,
  type ReviewRequest,
} from "./review-requests";

const request = (over: Partial<ReviewRequest> = {}): ReviewRequest => ({
  id: "r1",
  project_id: "p",
  subject_kind: "binding",
  subject_id: "b1",
  type_key: "prd",
  title: "prd.md",
  version: "sha-1",
  requested_by: "me",
  reviewers: [
    { person: "ann", name: "Ann", required: true },
    { person: "bob", name: "Bob", required: false },
  ],
  state: "open",
  overdue: false,
  outstanding: ["Ann"],
  created_at: "2026-10-13T10:00:00Z",
  verdicts: [],
  ...over,
});

describe("review requests", () => {
  it("builds the request body with the due day at its end", () => {
    const body = reviewRequestBody(
      "p",
      { kind: "binding", id: "b1", title: "prd.md", typeKey: "prd", version: "sha-1" },
      [{ person: "ann", name: "Ann", required: true }],
      "2026-10-20",
    );
    expect(body.due_at).toBe("2026-10-20T23:59:59Z");
    expect(body.reviewers).toEqual([{ person: "ann", name: "Ann", required: true }]);
    expect(reviewRequestBody("p", { kind: "document", id: "d", title: "t", version: "v" }, [], null).due_at).toBeNull();
  });

  it("says whom it waits for, and when it is late", () => {
    expect(reviewState(request()).label).toBe("Waiting for Ann");
    expect(reviewState(request({ overdue: true })).tone).toBe("late");
    expect(reviewState(request({ state: "approved", outstanding: [] })).label).toBe("Approved");
  });

  it("lets only a named reviewer decide an open request", () => {
    expect(canDecide(request(), "bob")).toBe(true);
    expect(canDecide(request(), "eve")).toBe(false);
    expect(canDecide(request({ state: "withdrawn" }), "ann")).toBe(false);
    expect(canDecide(request(), null)).toBe(false);
  });

  it("finds the request the document stands on and whether it is about an older version", () => {
    const list = [request({ id: "new", state: "withdrawn" }), request({ id: "old", state: "approved" })];
    expect(currentRequest(list)?.id).toBe("old");
    expect(currentRequest([request({ id: "x", state: "superseded" })])?.id).toBe("x");
    expect(currentRequest([])).toBeNull();
    expect(isStale(request(), "sha-2")).toBe(true);
  });

  it("adds a reviewer once", () => {
    const one = addReviewer([], { person: "ann", required: true });
    expect(addReviewer(one, { person: "ann", required: false })).toBe(one);
    expect(addReviewer(one, { person: "bob", required: false })).toHaveLength(2);
  });
});
