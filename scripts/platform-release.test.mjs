// node --test scripts/platform-release.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { apply, parseRelease, releaseProblems } from "./platform-release.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const real = () => parseRelease(readFileSync(resolve(repo, "platform-release.toml"), "utf8"));

test("the repository's pins agree with its release file", () => {
  const release = real();
  assert.deepEqual(releaseProblems(release), []);
  assert.deepEqual(apply(release), []);
});

test("a branch is refused where a commit is pinned", () => {
  const release = real();
  release.gears_rust.commit = "feature/gearbox";
  assert.match(releaseProblems(release).join("\n"), /\[gears_rust\] commit must be a full 40-character commit/);
});

test("an empty desktop hash fails, naming the desktop", () => {
  const release = real();
  release.gearbox.sha256_darwin_arm64 = "";
  assert.match(releaseProblems(release).join("\n"), /sha256_darwin_arm64 is empty.*desktop/);
});

test("a drifted pin is reported, and --write rewrites a derived one but not Cargo.lock", () => {
  const release = real();
  const files = new Map();
  const read = (f) => files.get(f) ?? readFileSync(resolve(repo, f), "utf8");
  const compose = read("docker-compose.yml").replace(release.gears_rust.commit, "feature/gearbox");
  files.set("docker-compose.yml", compose);
  const lock = read("studio-backend/Cargo.lock").replace(
    /(name = "cf-gears-toolkit"\r?\nversion = ")[^"]*/,
    "$10.0.1",
  );
  files.set("studio-backend/Cargo.lock", lock);

  const found = apply(release, { read });
  assert.equal(found.length, 2, found.join("\n"));
  assert.match(found[0], /docker-compose.yml: STUDIO_GEARBOX_CORPUS_REF is "feature\/gearbox"/);
  assert.match(found[1], /Cargo.lock: cf-gears-toolkit is "0.0.1".*cargo update/);

  const saved = new Map();
  const left = apply(release, { read, write: true, save: (f, body) => saved.set(f, body) });
  assert.equal(left.length, 1, left.join("\n"));
  assert.ok(saved.get("docker-compose.yml").includes(`STUDIO_GEARBOX_CORPUS_REF:-${release.gears_rust.commit}}`));
  assert.ok(!saved.has("studio-backend/Cargo.lock"));
});
