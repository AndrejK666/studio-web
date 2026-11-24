#!/usr/bin/env node
// Every pin of gears-rust and the Gearbox engine, derived from the one
// platform-release.toml at the repository's root (ADR-0075).
//
//   node scripts/platform-release.mjs                 # check: exit 1 when a pin disagrees
//   node scripts/platform-release.mjs --write         # rewrite the derived pins
//   node scripts/platform-release.mjs --fetch-sha256  # first fill the engine's archive
//                                                     # hashes from its release's SHA256SUMS
//
// `scripts/check-platform-release.mjs` is the check alone, for CI. Some pins
// are only checked, never written: Cargo.lock (cargo writes it), the matcher's
// fixture (a snapshot of the catalogue at its commits, regenerated with it) and
// the archive hashes (a release has them or it does not; --fetch-sha256
// reads them from its SHA256SUMS).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_FILE = "platform-release.toml";

/** The flat subset of TOML the release file uses: `[section]` and `key = "string"`. */
export function parseRelease(text) {
  const out = {};
  let section = null;
  for (const [n, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const head = /^\[([A-Za-z0-9_]+)\]$/.exec(line);
    if (head) {
      section = out[head[1]] = {};
      continue;
    }
    const kv = /^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"$/.exec(line);
    if (!kv || !section) throw new Error(`${RELEASE_FILE}:${n + 1}: not a [section] or key = "string": ${raw}`);
    section[kv[1]] = kv[2];
  }
  return out;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One pin: a value in a file found by a regex whose group 2 is the value
 * (group 1 is what comes before it, kept on write). `all` makes every match a
 * pin (an ARG and an ENV of the same name). `writable: false` only checks.
 */
function pin(file, what, re, expected, { all = false, writable = true } = {}) {
  return { file, what, re, expected, all, writable };
}

/** One `ARG`/`ENV` value of an image, every occurrence of it. */
function arg(file, name, value) {
  return pin(file, name, new RegExp(`^(\\s*(?:ARG|ENV)\\s+${esc(name)}=)(\\S*)`, "gm"), value, { all: true });
}

/** The engine ARGs of an image that carries the engine. */
function engineArgs(file, gearbox) {
  return [
    arg(file, "STUDIO_GEARBOX_REPO", gearbox.repo),
    arg(file, "STUDIO_GEARBOX_RELEASE", gearbox.release),
    arg(file, "STUDIO_GEARBOX_VERSION", gearbox.version),
    arg(file, "STUDIO_GEARBOX_REF", gearbox.ref),
    arg(file, "STUDIO_GEARBOX_SHA256", gearbox.sha256_linux_x64),
  ];
}

/** The desktop's engine, which theia/Dockerfile carries for gearbox-engine.yml. */
function desktopArgs(file, desktop) {
  return [
    arg(file, "STUDIO_GEARBOX_DESKTOP_REPO", desktop.repo),
    arg(file, "STUDIO_GEARBOX_DESKTOP_RELEASE", desktop.release),
    arg(file, "STUDIO_GEARBOX_DESKTOP_VERSION", desktop.version),
    arg(file, "STUDIO_GEARBOX_DESKTOP_REF", desktop.ref),
    arg(file, "STUDIO_GEARBOX_SHA256_WIN32_X64", desktop.sha256_win32_x64),
    arg(file, "STUDIO_GEARBOX_SHA256_DARWIN_ARM64", desktop.sha256_darwin_arm64),
  ];
}

export function pins(release) {
  const { gears_rust: corpus, gearbox, gearbox_desktop: desktop, toolkit, gears_matcher: matcher } = release;
  return [
    ...engineArgs("studio-backend/Dockerfile", gearbox),
    ...engineArgs("studio-backend/Dockerfile.src", gearbox),
    ...engineArgs("theia/Dockerfile", gearbox),
    ...desktopArgs("theia/Dockerfile", desktop),
    pin("product.gdl", "gears-rust source url",
      /(source\(id = "gears-rust", at = git\(url = ")([^"]*)/g, corpus.repo),
    pin("product.gdl", "gears-rust source rev",
      /(source\(id = "gears-rust", at = git\(url = "[^"]*", rev = ")([^"]*)/g, corpus.commit),
    pin("docker-compose.yml", "STUDIO_GEARBOX_CORPUS_URL",
      /(STUDIO_GEARBOX_CORPUS_URL: \$\{STUDIO_GEARBOX_CORPUS_URL:-)([^}]*)/g, corpus.repo),
    pin("docker-compose.yml", "STUDIO_GEARBOX_CORPUS_REF",
      /(STUDIO_GEARBOX_CORPUS_REF: \$\{STUDIO_GEARBOX_CORPUS_REF:-)([^}]*)/g, corpus.commit),
    pin("deploy/helm/values-dev.example.yaml", "gearbox.corpusUrl", /^(\s*corpusUrl: ")([^"]*)/gm, corpus.repo),
    pin("deploy/helm/values-dev.example.yaml", "gearbox.corpusRef", /^(\s*corpusRef: ")([^"]*)/gm, corpus.commit),
    pin("studio-backend/Cargo.toml", "cf-gears-toolkit",
      /^(toolkit = \{ package = "cf-gears-toolkit", version = "=)([^"]*)/gm, toolkit.version),
    pin("studio-backend/Cargo.lock", "cf-gears-toolkit",
      /^(name = "cf-gears-toolkit"\r?\nversion = ")([^"]*)/gm, toolkit.version, { writable: false }),
    pin("studio-backend/src/gears_matcher/fixtures/gear-directories.json", "gears_md_commit",
      /("gears_md_commit": ")([^"]*)/g, matcher.gears_md_commit, { writable: false }),
    pin("studio-backend/src/gears_matcher/fixtures/gear-directories.json", "gear_gdl_commit",
      /("gear_gdl_commit": ")([^"]*)/g, matcher.gear_gdl_commit, { writable: false }),
  ];
}

/** The archive each engine section pins, by its hash key. */
export const ARCHIVES = {
  sha256_linux_x64: "x86_64-unknown-linux-gnu.tar.gz",
  sha256_win32_x64: "x86_64-pc-windows-msvc.zip",
  sha256_darwin_arm64: "aarch64-apple-darwin.tar.gz",
};
const ENGINES = {
  gearbox: ["sha256_linux_x64"],
  gearbox_desktop: ["sha256_win32_x64", "sha256_darwin_arm64"],
};

/** What the release file itself must say before anything is derived from it. */
export function releaseProblems(release) {
  const problems = [];
  const need = {
    gears_rust: ["repo", "commit"],
    gearbox: ["repo", "release", "version", "ref", ...ENGINES.gearbox],
    gearbox_desktop: ["repo", "release", "version", "ref", ...ENGINES.gearbox_desktop],
    toolkit: ["version"],
    gears_matcher: ["repo", "gears_md_commit", "gear_gdl_commit"],
  };
  for (const [section, keys] of Object.entries(need)) {
    for (const key of keys) {
      if (!release[section]?.[key]) {
        const desktop = section === "gearbox_desktop" && key.startsWith("sha256_");
        problems.push(
          `${RELEASE_FILE}: [${section}] ${key} is empty or missing` +
            (desktop ? ": the desktop would get no engine for that platform (run --fetch-sha256, or pick a release that publishes it)" : ""),
        );
      }
    }
  }
  const sha = /^[0-9a-f]{40}$/;
  for (const [where, value] of [
    ["[gears_rust] commit", release.gears_rust?.commit],
    ["[gearbox] ref", release.gearbox?.ref],
    ["[gearbox_desktop] ref", release.gearbox_desktop?.ref],
    ["[gears_matcher] gears_md_commit", release.gears_matcher?.gears_md_commit],
    ["[gears_matcher] gear_gdl_commit", release.gears_matcher?.gear_gdl_commit],
  ]) {
    if (value && !sha.test(value)) problems.push(`${RELEASE_FILE}: ${where} must be a full 40-character commit, not a branch or a short id (${value})`);
  }
  for (const [section, keys] of Object.entries(ENGINES)) {
    const g = release[section] ?? {};
    for (const key of keys) {
      if (g[key] && !/^[0-9a-f]{64}$/.test(g[key])) problems.push(`${RELEASE_FILE}: [${section}] ${key} is not a SHA-256 (${g[key]})`);
    }
    if (g.ref && g.version && g.version.includes("-") && !g.version.endsWith(g.ref.slice(0, 7)))
      problems.push(`${RELEASE_FILE}: [${section}] version ${g.version} does not name ref ${g.ref.slice(0, 7)}`);
  }
  return problems;
}

/** Check, or with `write` rewrite, every pin. Returns the problems left. */
export function apply(release, { write = false, read = (f) => readFileSync(resolve(repo, f), "utf8"), save } = {}) {
  const problems = [];
  const texts = new Map();
  const text = (f) => {
    if (!texts.has(f)) texts.set(f, read(f));
    return texts.get(f);
  };
  for (const p of pins(release)) {
    let body;
    try {
      body = text(p.file);
    } catch {
      problems.push(`${p.file}: missing (pins ${p.what})`);
      continue;
    }
    const found = [...body.matchAll(p.re)];
    if (found.length === 0 || (!p.all && found.length > 1)) {
      problems.push(`${p.file}: ${found.length === 0 ? "no" : "more than one"} ${p.what} where the pin is expected; update scripts/platform-release.mjs with the file`);
      continue;
    }
    const wrong = found.filter((m) => m[2] !== p.expected);
    if (!wrong.length) continue;
    if (write && p.writable) {
      texts.set(p.file, body.replace(p.re, (_, before) => `${before}${p.expected}`));
      continue;
    }
    for (const m of wrong) {
      problems.push(
        `${p.file}: ${p.what} is "${m[2]}", ${RELEASE_FILE} says "${p.expected}"` +
          (p.writable ? "" : p.file.endsWith("Cargo.lock")
            ? " (cargo update -p cf-gears-toolkit after the Cargo.toml pin)"
            : " (a snapshot: regenerate it at the release's commits)"),
      );
    }
  }
  if (write) {
    for (const [f, body] of texts) {
      if (body !== read(f)) (save ?? ((file, b) => writeFileSync(resolve(repo, file), b)))(f, body);
    }
  }
  return problems;
}

async function fetchSha256(release) {
  let file = readFileSync(resolve(repo, RELEASE_FILE), "utf8");
  for (const [section, keys] of Object.entries(ENGINES)) {
    const g = release[section];
    const url = `${g.repo}/releases/download/${g.release}/SHA256SUMS`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}; is the release published?`);
    const sums = new Map(
      (await res.text())
        .split(/\r?\n/)
        .map((l) => /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(l.trim()))
        .filter(Boolean)
        .map(([, sum, name]) => [name, sum]),
    );
    // The key line inside this section only: both sections end in hashes.
    const start = file.indexOf(`[${section}]`);
    const next = file.indexOf("\n[", start + 1);
    const end = next < 0 ? file.length : next;
    let body = file.slice(start, end);
    for (const key of keys) {
      const archive = `gearbox-${g.version}-${ARCHIVES[key]}`;
      const sum = sums.get(archive) ?? "";
      if (!sum) console.error(`${g.release} publishes no ${archive}; [${section}] ${key} stays empty and the check fails`);
      body = body.replace(new RegExp(`^(${key} = ")[^"]*`, "m"), `$1${sum}`);
      g[key] = sum;
    }
    file = file.slice(0, start) + body + file.slice(end);
  }
  writeFileSync(resolve(repo, RELEASE_FILE), file);
}

export async function main(argv) {
  const write = argv.includes("--write");
  const release = parseRelease(readFileSync(resolve(repo, RELEASE_FILE), "utf8"));
  if (argv.includes("--fetch-sha256")) await fetchSha256(release);
  const problems = [...releaseProblems(release), ...apply(release, { write })];
  if (problems.length) {
    console.error(`platform release: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    if (!write) console.error(`\nnode scripts/platform-release.mjs --write rewrites the pins it can.`);
    return 1;
  }
  console.log(
    `platform release: every pin agrees (gears-rust ${release.gears_rust.commit.slice(0, 8)}, ` +
      `gearbox ${release.gearbox.release}, desktop ${release.gearbox_desktop.release}, toolkit ${release.toolkit.version})`,
  );
  return 0;
}

if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? "")) {
  process.exitCode = await main(process.argv.slice(2));
}
