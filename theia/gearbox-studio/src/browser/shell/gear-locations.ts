// Constructor Studio: where a project's gears are, and where a new one goes.
//
// A Studio session's workspace root holds one checkout per source. A gear
// project has its own repository there, and -- because a plugin's `gear.gdl`
// names its SDK as `../gears-rust/...` -- the gear corpus beside it. The corpus
// is the catalogue's, not the project's, so neither "the project's gear" nor
// "where New Gear writes" may land in it.
//
// Pure, for the same reason `create/paths.ts` is: the widget and the command
// that use it cannot be constructed outside a browser.

/** The corpus checkout's directory: the session names a source's directory
 *  after its id, and the corpus source's id is `gears-rust`. */
export const CORPUS_CHECKOUT = "gears-rust";

/** Directories a walk for `gear.gdl` never enters. */
const SKIP = new Set(["node_modules", "target", "dist", "lib"]);

/** How far below a workspace root a gear is looked for:
 *  `<checkout>/gears/<family>/<gear>/gear.gdl` is four directories down. */
export const GEAR_SEARCH_DEPTH = 4;

/** Whether a walk looking for gears should enter `name`, `depth` directories
 *  below the workspace root (a checkout is depth 1). */
export function walkInto(name: string, depth: number): boolean {
  if (depth > GEAR_SEARCH_DEPTH) return false;
  if (name.startsWith(".") || SKIP.has(name)) return false;
  return !(depth === 1 && name === CORPUS_CHECKOUT);
}

/** The gear directories among `gdlFiles`, a project's own first: the order a
 *  person reads them in when there is more than one to pick from. */
export function gearRoots(gdlFiles: readonly string[]): string[] {
  return gdlFiles
    .map((f) => f.replace(/\\/g, "/"))
    .filter((f) => f.endsWith("/gear.gdl"))
    .map((f) => f.slice(0, -"/gear.gdl".length))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Where New Gear should put a gear by default.
 *
 * Beside the project's existing gears when it has some (their family
 * directory: a gear store groups them, and the project's first gear was
 * scaffolded where the portal was told to put it); else `gears/` in the
 * project's checkout; else `gears/` at the root, which is what a workspace that
 * is itself one repository wants.
 */
export function newGearDestination(root: string, checkouts: readonly string[], gears: readonly string[]): string {
  const clean = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const first = gears[0];
  if (first !== undefined) {
    const at = clean(first).lastIndexOf("/");
    if (at > 0) return clean(first).slice(0, at);
  }
  const own = checkouts.map(clean).find((c) => !c.endsWith(`/${CORPUS_CHECKOUT}`));
  if (own !== undefined) return `${own}/gears`;
  return root === "" ? "" : `${clean(root)}/gears`;
}
