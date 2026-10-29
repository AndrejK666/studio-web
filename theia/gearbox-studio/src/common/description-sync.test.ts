import { afterSave, isChange, onConflict, onOpen } from "./description-sync";

const latest = { revision: 4, text: "product shop { b }" };

describe("a product.gdl in step with the revision Studio keeps (ADR-0053)", () => {
  it("takes Studio's latest into the checkout on open, and nothing when they agree", () => {
    expect(onOpen("product shop { a }", latest)).toEqual({ write: latest.text, inStep: { revision: 4, text: latest.text } });
    expect(onOpen(latest.text, latest)).toEqual({ write: undefined, inStep: { revision: 4, text: latest.text } });
    expect(onOpen("local", undefined)).toEqual({ write: undefined, inStep: { revision: undefined, text: "local" } });
  });

  it("hands a changed file to Studio, and keeps what it saved as the new step", () => {
    const step = { revision: 4, text: latest.text };
    expect(isChange(latest.text, step)).toBe(false);
    expect(isChange("  ", step)).toBe(false);
    expect(isChange("product shop { c }", step)).toBe(true);
    expect(afterSave("product shop { c }", { kind: "saved", revision: 5 }, step)).toEqual({ revision: 5, text: "product shop { c }" });
    expect(afterSave("x", { kind: "none" }, step)).toBe(step);
  });

  it("lets the person settle a conflict: keep theirs, take Studio's, or decide later", () => {
    const step = { revision: 4, text: latest.text };
    const newer = { revision: 6, text: "product shop { z }" };
    expect(onConflict("mine", newer, step)).toEqual({ saveAgainst: 6, write: undefined, inStep: step });
    expect(onConflict("theirs", newer, step)).toEqual({ saveAgainst: undefined, write: newer.text, inStep: { revision: 6, text: newer.text } });
    expect(onConflict("later", newer, step)).toEqual({ saveAgainst: undefined, write: undefined, inStep: step });
  });
});
