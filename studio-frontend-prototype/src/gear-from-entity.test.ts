// A gap in the Domain model becomes the request for a gear: these pin the
// name (and that the Domain model then sees the gear as the entity's keeper),
// the description, and what the PRD says about fields and relations.
import { describe, expect, it } from "vitest";

import { entityGears, gearRefs } from "./entity-gears";
import { gearDraftFrom, gearNameFor, gearProblemFrom, nameWarning } from "./gear-from-entity";
import { entitiesOf, subjectKey, type SpecModelFact } from "./spec-model";

const fact = (subject: string, kind: SpecModelFact["kind"], extra: Partial<SpecModelFact> = {}): SpecModelFact => ({
  kind,
  subject,
  aspect: "",
  value: "",
  text: `${subject} ${kind}`,
  status: "active",
  status_because: "",
  source: { path: "docs/prd/x.md", line_start: 1 },
  ...extra,
});
const attr = (subject: string, aspect: string) => fact(subject, "attribute", { aspect, value: `its ${aspect}` });
const rel = (subject: string, verb: string, target: string) =>
  fact(subject, "relation", { aspect: verb, value: target, text: `${subject} ${verb} ${target}` });
const named = (name: string) => ({ key: subjectKey(name), name });

describe("the gear's name", () => {
  it("is the entity's words in kebab-case, the last one plural", () => {
    expect(gearNameFor(named("Invoice line"))).toBe("invoice-lines");
    expect(gearNameFor(named("Customer"))).toBe("customers");
    expect(gearNameFor(named("Invoices"))).toBe("invoices");
  });

  it("stays singular when the plural would not fold back to the entity", () => {
    // "entries" folds to "entrie", "addresses" to "addresse".
    expect(gearNameFor(named("Ledger entry"))).toBe("ledger-entry");
    expect(gearNameFor(named("Address"))).toBe("address");
  });

  it("is matched back to the entity once the project declares the gear", () => {
    for (const name of ["Invoice line", "Customer", "Ledger entry", "Address", "Studio session", "Tag"]) {
      const e = { ...named(name), keys: [subjectKey(name)] };
      const draft = gearNameFor(e);
      for (const declared of [draft, `cf-gears-${draft}`]) {
        const keeper = entityGears([e], gearRefs(null, [{ name: declared, origin: "project" }])).byEntity.get(e.key);
        expect(keeper?.gear, `${name} → ${declared}`).toMatchObject({ id: declared, origin: "project" });
        expect(keeper?.score).toBe(4);
      }
    }
  });

  it("warns when a typed-in name would lose the entity", () => {
    expect(nameWarning("invoice line", "Invoice line", "invoice-lines")).toBeNull();
    expect(nameWarning("invoice line", "Invoice line", "Invoice Line")).toBeNull();
    expect(nameWarning("invoice line", "Invoice line", "billing")).toMatch(/invoice-lines/);
    expect(nameWarning("invoice line", "Invoice line", " ")).toMatch(/needs a name/);
  });
});

describe("the draft", () => {
  const facts = [
    attr("Invoice", "number"),
    attr("Invoice", "total"),
    rel("Invoice", "belongs to", "Customer"),
    fact("Customer", "entity", { text: "A Customer buys things." }),
    attr("Customer", "email"),
    fact("Refund", "requirement", { text: "A refund must be approved by a manager." }),
  ];
  const byName = (n: string) => entitiesOf(facts).find((e) => e.name === n)!;

  it("says what the entity is: the documents' definition when they give one", () => {
    expect(gearDraftFrom(byName("Customer")).description).toBe("A Customer buys things.");
  });

  it("else puts the sentence together from what it holds and how it relates", () => {
    const d = gearDraftFrom(byName("Invoice"));
    expect(d).toMatchObject({ entityKey: "invoice", entityName: "Invoice", name: "invoices" });
    expect(d.description).toBe("An Invoice holds number and total and belongs to Customer.");
    expect(d.fields.map((f) => f.name)).toEqual(["number", "total"]);
    expect(d.relations).toEqual([{ verb: "belongs to", target: "Customer" }]);
    expect(d.origin).toMatch(/Domain model entity “Invoice”/);
  });

  it("else quotes the first thing asked of it", () => {
    expect(gearDraftFrom(byName("Refund")).description).toBe("A Refund: A refund must be approved by a manager.");
  });

  it("spells out fields and relations in the PRD's problem", () => {
    expect(gearProblemFrom(gearDraftFrom(byName("Invoice")))).toBe(
      "An Invoice holds number and total and belongs to Customer. It stores each Invoice's number and total. An Invoice belongs to Customer.",
    );
    expect(gearProblemFrom(gearDraftFrom(byName("Customer")))).toBe("A Customer buys things. It stores each Customer's email.");
  });
});
