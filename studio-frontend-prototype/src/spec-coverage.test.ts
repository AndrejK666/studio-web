import { describe, expect, it } from "vitest";

import type { Candidate, PlanRow } from "./api";
import {
  candidateReasons,
  candidateStrength,
  coverageSummary,
  gearProblem,
  lookingFor,
  picksBeyondShortlist,
  rowCoverage,
  specReasons,
} from "./spec-coverage";

const cand = (name: string, extra: Partial<Candidate> = {}): Candidate => ({
  name,
  kind: "gear",
  step: "evidence",
  score: 1,
  why: ["login"],
  built: "built",
  composable: "runs",
  ...extra,
});

const row = (capability: string, extra: Partial<PlanRow> = {}): PlanRow => ({
  capability,
  candidates: [],
  gap: false,
  unbuilt: false,
  ...extra,
});

describe("coverage against the product", () => {
  const auth = row("auth", {
    candidates: [cand("wordy")],
    providers: [
      { name: "wordy", strong: false },
      { name: "resolver", strong: true },
    ],
  });

  it("is closed only by a strong provider in the product", () => {
    expect(rowCoverage(auth, ["resolver"])).toEqual({ cover: "covered", strong: ["resolver"], weak: [] });
    expect(rowCoverage(auth, ["wordy"])).toEqual({ cover: "weak", strong: [], weak: ["wordy"] });
    expect(rowCoverage(auth, ["other"]).cover).toBe("open");
  });

  it("counts a pick beyond the shortlist, and names it", () => {
    expect(picksBeyondShortlist(auth, ["resolver", "wordy"])).toEqual([{ name: "resolver", strong: true }]);
  });

  it("leaves profile capabilities out of the count", () => {
    const plan = [auth, row("deploy", { nonfunctional: true }), row("billing")];
    expect(coverageSummary(plan, ["wordy"])).toEqual({ total: 2, covered: 0, weak: 1, open: 1 });
  });

  it("falls back to the shortlist from a server without providers", () => {
    const old = row("auth", {
      candidates: [
        cand("declares", { declared: true, why: ["declared"] }),
        cand("rejected", { decision: { decision: "rejected", needs_review: false } }),
      ],
    });
    expect(rowCoverage(old, ["declares"]).cover).toBe("covered");
    expect(rowCoverage(old, ["rejected"]).cover).toBe("open");
  });
});

describe("why a gear is offered", () => {
  it("is strong for a contract, a declaration or a confirmation, weak for words", () => {
    expect(candidateStrength(cand("a", { step: "contract" }))).toBe("strong");
    expect(candidateStrength(cand("a", { declared: true }))).toBe("strong");
    expect(candidateStrength(cand("a", { decision: { decision: "confirmed", needs_review: false } }))).toBe("strong");
    expect(candidateStrength(cand("a", { decision: { decision: "confirmed", needs_review: true } }))).toBe("weak");
    expect(candidateStrength(cand("a"))).toBe("weak");
  });

  it("says which words matched where, and that words alone prove little", () => {
    const lines = candidateReasons(cand("a", { why: ["login", "token"], passage: "handles login tokens" }), "auth");
    expect(lines).toContain("Its catalogue description uses “login”, “token”.");
    expect(lines).toContain("“…handles login tokens…”");
    expect(lines.some((l) => l.startsWith("Found by its words only"))).toBe(true);
  });

  it("says when the gear is the project's own", () => {
    expect(candidateReasons(cand("studio-documents", { origin: "project", path: "studio-backend/src/documents" }), "storage")[0]).toBe(
      "Declared in this project's own repository, at studio-backend/src/documents: you already have it.",
    );
  });

  it("names the contract and what blocks the engine", () => {
    const lines = candidateReasons(
      cand("a", { step: "contract", contracts: ["authn/Api@v1"], composable: "blocked", composable_why: "needs a plugin" }),
      "auth",
    );
    expect(lines[0]).toBe("Provides authn/Api@v1: a contract “auth” is satisfied by.");
    expect(lines).toContain("The Gearbox engine cannot run it: needs a plugin.");
    expect(lines.some((l) => l.startsWith("Found by its words only"))).toBe(false);
  });
});

describe("why the specs ask", () => {
  it("names the requirements and the words they use", () => {
    const [entry] = specReasons(
      row("auth", {
        sources: [
          {
            kind: "file",
            id: "1",
            label: "docs/PRD.md",
            inferred: true,
            because: ["5.1 Login", "5.2 Tokens"],
            requirements: 4,
            terms: ["login"],
            confirmed: false,
          },
        ],
      }),
    );
    expect(entry.document).toBe("docs/PRD.md");
    expect(entry.lines).toEqual([
      "Implied by 4 functional requirements: “5.1 Login”, “5.2 Tokens” and 2 more.",
      "They use the words “login”.",
      "The file is not confirmed as a spec on the Specs tab yet.",
    ]);
  });

  it("says what a gear is looked for with", () => {
    expect(lookingFor(row("auth", { terms: ["login"], contracts: ["authn/Api"] }))).toBe(
      "Gears are matched by contracts authn/Api, then by words “login”.",
    );
    expect(lookingFor(row("auth"))).toBe("Gears are matched by words “auth”.");
  });
});

describe("a gear made for what nothing closes", () => {
  it("starts its PRD from the specs that ask for it", () => {
    expect(
      gearProblem(
        row("audit", {
          label: "Audit log",
          sources: [
            { kind: "file", id: "1", label: "docs/PRD.md", inferred: true, because: ["5.4 Audit trail"] },
            { kind: "document", id: "2", label: "Security", inferred: false },
          ],
        }),
      ),
    ).toBe(
      "The project needs Audit log (audit), and no gear in the catalogue closes it. The specs that ask for it: docs/PRD.md: “5.4 Audit trail”; Security.",
    );
  });
});
