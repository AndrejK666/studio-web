import { createGearGuidance } from "./create-gear-guidance";

describe("what New Gear says before Create", () => {
  const base = { kind: "service" as const, addingToProduct: false, gearId: "my-service", destinationDir: "/w/products/p/gears" };

  it("says a new gear is not catalogued until its code carries #[toolkit::gear] (GBX0211)", () => {
    const [note] = createGearGuidance(base);
    expect(note?.id).toBe("uncatalogued");
    expect(note?.text).toMatch(/#\[toolkit::gear\(name = "…"\)\]/);
    expect(note?.text).toMatch(/GBX0211/);
    expect(note?.text).not.toMatch(/GBX0301/);
  });

  it("adds that the product will report GBX0301 when the gear is added to one", () => {
    const [note] = createGearGuidance({ ...base, addingToProduct: true });
    expect(note?.text).toMatch(/the product that names it reports GBX0301/);
  });

  it("says where a corpus host's plugin has to be moved, by path", () => {
    const notes = createGearGuidance({
      ...base,
      kind: "plugin",
      gearId: "my-tr-plugin",
      destinationDir: "/w/products/p/gears/",
      host: { id: "tenant-resolver", dir: "/w/gears-rust/gears/system/tenant-resolver" },
    });
    expect(notes.map((n) => n.id)).toEqual(["corpus-plugin", "uncatalogued"]);
    expect(notes[0]?.target).toBe("/w/gears-rust/gears/system/tenant-resolver/plugins/my-tr-plugin");
    expect(notes[0]?.text).toMatch(/refuses to scaffold inside a source root/);
    expect(notes[0]?.text).toMatch(/GBX0102/);
    expect(notes[0]?.text).toContain("move /w/products/p/gears/my-tr-plugin to /w/gears-rust/gears/system/tenant-resolver/plugins/my-tr-plugin");
  });

  it("still says where, in words, when the catalogue cannot locate the host's folder", () => {
    const [note] = createGearGuidance({ ...base, kind: "plugin", host: { id: "tenant-resolver", dir: undefined } });
    expect(note?.target).toBeUndefined();
    expect(note?.text).toMatch(/into the corpus beside tenant-resolver/);
  });

  it("says nothing about a host until a plugin has one", () => {
    expect(createGearGuidance({ ...base, kind: "plugin" }).map((n) => n.id)).toEqual(["uncatalogued"]);
  });
});
