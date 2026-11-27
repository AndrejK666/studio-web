/**
 * The shell knows no kit (ADR-0068, ADR-0079): a ratchet on the places where
 * it still does.
 *
 * The shell is `app/**` and the host side of the MFE contract
 * (`mfe_packages/shared/src/host/**`). Its code (tests and comments aside) may
 * not name, as a whole string literal:
 *
 * - a built-in kit's slug (`studio-backend/src/kit_registry/builtin/*.kit.json`);
 * - a micro-frontend package that draws a kit's screen (an `mfe.json` with a
 *   `presentation.kit`);
 * - a kit screen's route (`/space`), or its token, the route's first segment
 *   (`space`), unless a shell screen shares that segment or it is one of the
 *   shell's own words (`platform`, `product`: a level and a placement);
 * - a type a kit's model brings, as its id (`pull-request`) or in camelCase
 *   (`pullRequest`).
 *
 * A match fails unless `KNOWN_LEAKS` lists it, and a listed leak the code no
 * longer has fails too, so the list only shrinks. `UNSEEN_LEAKS` are leaks the
 * matcher cannot tell from words (a message type, a translation): pinned by
 * hand, they fail when they go, so their line goes with them.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_APP = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const BUILTIN_KITS = path.resolve(
  SRC_APP,
  "../../studio-backend/src/kit_registry/builtin",
);
const MFE_PACKAGES = path.join(SRC_APP, "mfe_packages");
const SHELL_DIRS = ["app", "mfe_packages/shared/src/host"];

/** The shell's own words a kit route may start with: levels and placements. */
const SHELL_WORDS = new Set([
  "platform",
  "organization",
  "workspace",
  "project",
  "product",
  "main",
  "settings",
  "hidden",
]);

interface Leak {
  /** Relative to `src-app/`, with `/`. */
  file: string;
  literal: string;
  why: string;
}

/** Matches of the rules above that are still in the shell. Only remove lines. */
const KNOWN_LEAKS: Leak[] = [];

/** Leaks the matcher cannot see, pinned by hand (a substring of the file). */
const UNSEEN_LEAKS: Leak[] = [
  {
    file: "app/mfe/editorBridge.ts",
    literal: "'studio.openDocument'",
    why: "the IDE bridge opens a project-specs document (documentId)",
  },
  {
    file: "app/mfe/editorBridge.ts",
    literal: "'studio.openComponent'",
    why: "the IDE asks the shell to open a components-kit component",
  },
  {
    file: "app/i18n/en.json",
    literal: '"editor_component_unavailable"',
    why: "the shell says the components kit's catalogue is missing",
  },
  {
    file: "app/i18n/ru.json",
    literal: '"editor_component_unavailable"',
    why: "the shell says the components kit's catalogue is missing",
  },
];

interface KitJson {
  slug: string;
  screens?: { route?: string; mfe?: string }[];
  model?: { types?: { id?: string; name?: string }[] };
}

interface MfeJson {
  extensions?: { presentation?: { kit?: string; route?: string } }[];
}

const readJson = <T>(file: string): T =>
  JSON.parse(fs.readFileSync(file, "utf8")) as T;

const firstSegment = (route: string): string =>
  route.replace(/^\//, "").split("/")[0] ?? "";

const camel = (id: string): string =>
  id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** What a kit is named by, with why: the needles the shell's literals are held to. */
function kitNames(): Map<string, string> {
  const out = new Map<string, string>();
  const add = (needle: string, why: string) => {
    if (needle && !out.has(needle)) out.set(needle, why);
  };

  const kitTokens = new Map<string, string>();
  const shellTokens = new Set<string>();
  for (const dir of fs.readdirSync(MFE_PACKAGES)) {
    const file = path.join(MFE_PACKAGES, dir, "mfe.json");
    if (!fs.existsSync(file)) continue;
    let drawsAKit = false;
    for (const ext of readJson<MfeJson>(file).extensions ?? []) {
      const { kit, route } = ext.presentation ?? {};
      if (kit) drawsAKit = true;
      if (!route) continue;
      if (kit) {
        add(route, `route of kit ${kit}`);
        kitTokens.set(firstSegment(route), kit);
      } else {
        shellTokens.add(firstSegment(route));
      }
    }
    if (drawsAKit) add(dir, "a kit screen package");
  }
  for (const [token, kit] of kitTokens) {
    if (!shellTokens.has(token) && !SHELL_WORDS.has(token))
      add(token, `screen token of kit ${kit}`);
  }

  for (const file of fs
    .readdirSync(BUILTIN_KITS)
    .filter((f) => f.endsWith(".kit.json"))) {
    const kit = readJson<KitJson>(path.join(BUILTIN_KITS, file));
    add(kit.slug, "kit slug");
    for (const screen of kit.screens ?? []) {
      if (screen.route) add(screen.route, `route of kit ${kit.slug}`);
      if (screen.mfe) add(screen.mfe, `package of kit ${kit.slug}`);
    }
    for (const type of kit.model?.types ?? []) {
      const id = type.id ?? type.name ?? "";
      // A project type derives the core's Project: `project` is the shell's word.
      if (!id || id === "project") continue;
      add(id, `type of kit ${kit.slug}`);
      add(camel(id), `type of kit ${kit.slug}`);
    }
  }
  return out;
}

function shellFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (
        /\.(ts|tsx|json)$/.test(entry.name) &&
        !/\.(test|spec)\.tsx?$/.test(entry.name)
      )
        out.push(full);
    }
  };
  for (const dir of SHELL_DIRS) walk(path.join(SRC_APP, dir));
  return out;
}

const blankOut = (s: string): string => s.replace(/[^\n]/g, " ");

/** The file's string literals (template literals without `${}` only), comments aside. */
function literals(text: string, json: boolean): string[] {
  let code = text;
  if (!json) {
    code = code
      .replace(/\/\*[\s\S]*?\*\//g, blankOut)
      .replace(
        /(^|[^:'"`\\])(\/\/.*)$/gm,
        (_m, before: string, comment: string) => before + blankOut(comment),
      );
  }
  const out: string[] = [];
  const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`([^`$\\]*)`/g;
  for (let m = re.exec(code); m; m = re.exec(code))
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

const key = (file: string, literal: string) => `${file} :: ${literal}`;

describe("the shell names no kit (ADR-0079)", () => {
  const names = kitNames();
  const found = new Map<string, string>();
  for (const file of shellFiles()) {
    const rel = path.relative(SRC_APP, file).split(path.sep).join("/");
    for (const literal of literals(
      fs.readFileSync(file, "utf8"),
      file.endsWith(".json"),
    )) {
      const why = names.get(literal);
      if (why) found.set(key(rel, literal), why);
    }
  }
  const known = new Set(KNOWN_LEAKS.map((l) => key(l.file, l.literal)));

  it("reads the kits and the shell", () => {
    // Guard against an empty reading passing everything below.
    expect(names.get("space")).toBe("screen token of kit ide");
    expect(names.has("project-git")).toBe(true);
    expect(names.has("pullRequest")).toBe(true);
    // And the shell's literals are read: its own route key, and a kit's
    // token in code, but not in a comment.
    expect(
      literals(
        fs.readFileSync(path.join(SRC_APP, "app/routing/route.ts"), "utf8"),
        false,
      ),
    ).toContain("screen");
    expect(literals("const a = 'space'; // 'ide'", false)).toEqual(["space"]);
    expect(shellFiles().length).toBeGreaterThan(0);
  });

  it("finds no kit named in the shell beyond KNOWN_LEAKS", () => {
    const fresh = [...found]
      .filter(([k]) => !known.has(k))
      .map(([k, why]) => `${k} (${why})`);
    expect(
      fresh,
      "The shell names a kit. Bind to a property or a port the kit fills instead (ADR-0079).",
    ).toEqual([]);
  });

  it("lists only leaks the shell still has", () => {
    const gone = [...known].filter((k) => !found.has(k));
    expect(
      gone,
      "Remove these lines from KNOWN_LEAKS: the shell no longer has them.",
    ).toEqual([]);
  });

  it("still has every pinned leak the matcher cannot see", () => {
    const gone = UNSEEN_LEAKS.filter(
      (l) =>
        !fs
          .readFileSync(path.join(SRC_APP, l.file), "utf8")
          .includes(l.literal),
    ).map((l) => key(l.file, l.literal));
    expect(
      gone,
      "Remove these lines from UNSEEN_LEAKS: the shell no longer has them.",
    ).toEqual([]);
  });
});
