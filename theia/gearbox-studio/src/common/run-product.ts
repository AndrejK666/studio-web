// Constructor Studio: building and running a generated product -- the rules,
// shared by the Generate view (browser) and the IDE backend (node).
//
// Generate writes a Cargo workspace under `.gearbox/<product>/<profile>/`: one
// binary per host application (`bin_name`, e.g. `gbx-shop`) and its runtime
// configuration at `config/<application>.yaml`. The binary takes the
// configuration as a flag before its subcommand -- `gbx-shop --config
// config/shop.yaml run` (the generated `main.rs`: `--config` is a top-level
// option and `run` the default subcommand). Workers are spawned by their host,
// so only `run_server` applications are run from here.
//
// **What generate leaves out, and this adds.** The engine knows which gears need
// a database -- each declares the `db` runtime capability, and an application
// with one is `needs_db` -- but `config/<application>.yaml` carries no
// `database` section, so such a product stops at once: "Database is not
// configured for gear 'resource-group'" (reported upstream,
// https://github.com/MikeFalcon77/gearbox/issues/4). Studio writes a copy,
// `config/<application>.local.yaml`, with a Postgres server and one database
// per gear that needs one -- Postgres, as the cluster runs -- and Run uses the
// copy. The generated file stays the engine's; the copy is Studio's.

import type { ResolvedApplication } from "./generated/ResolvedApplication";
import type { ResolvedProduct } from "./generated/ResolvedProduct";

/** Where a local product's Postgres is, unless the member says otherwise. */
export interface PostgresTarget {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  /** The environment variable the password is read from; the config says `${VAR}`. */
  readonly passwordEnv: string;
}

export const LOCAL_POSTGRES: PostgresTarget = {
  host: "127.0.0.1",
  port: 5432,
  user: "postgres",
  passwordEnv: "GEARS_PG_PASSWORD",
};

/**
 * The password of the Postgres container Studio starts, and the value the Run
 * terminal gets for `GEARS_PG_PASSWORD` when the IDE's environment has none.
 * A local development database on 127.0.0.1, never a deployment's.
 */
export const LOCAL_POSTGRES_PASSWORD = "gears";

export const POSTGRES_IMAGE = "postgres:18-alpine";

/** One host application of a generated product, as Build and Run see it. */
export interface RunTarget {
  readonly app: string;
  readonly bin: string;
  /** The generated configuration, relative to the output root. */
  readonly config: string;
  /** Studio's copy with the database section, relative to the output root. */
  readonly localConfig: string;
  /** Gears in this application that need a database, in the resolution's order. */
  readonly dbGears: readonly string[];
  /** The REST address the product answers on, when it has a REST host. */
  readonly address: string | undefined;
}

/**
 * The applications Run can start: the `run_server` hosts. `hasDb` says whether
 * a gear declares the `db` runtime capability (from the catalogue).
 */
export function runTargetsOf(product: ResolvedProduct, hasDb: (gear: string) => boolean): RunTarget[] {
  return product.applications
    .filter((app) => app.entrypoint === "run_server")
    .map((app) => ({
      app: app.name,
      bin: app.bin_name,
      config: `config/${app.name}.yaml`,
      localConfig: `config/${app.name}.local.yaml`,
      dbGears: app.needs_db ? app.gears.filter(hasDb) : [],
      address: restAddressOf(app),
    }));
}

/** The address of the application's REST host endpoint, else its first endpoint. */
function restAddressOf(app: ResolvedApplication): string | undefined {
  const listens = app.listens ?? [];
  const rest = listens.find((endpoint) => app.rest_host != null && endpoint.gear === app.rest_host);
  return (rest ?? listens.find((endpoint) => endpoint.name === "rest"))?.address;
}

/** A browser URL for a bind address: a wildcard bind is reached on loopback. */
export function urlOf(address: string): string {
  const match = /^(.*):(\d+)$/.exec(address.trim());
  if (match === null) return `http://${address.trim()}`;
  const host = match[1] === "0.0.0.0" || match[1] === "[::]" || match[1] === "" ? "127.0.0.1" : match[1];
  return `http://${host}:${match[2]}`;
}

/** The database a gear gets: its id, as a Postgres identifier. */
export function dbNameOf(gear: string): string {
  return gear.replace(/[^A-Za-z0-9_]/g, "_").toLowerCase();
}

export function buildCommand(target: RunTarget): string {
  return `cargo build --bin ${target.bin}`;
}

/** Run through cargo, so a missing or stale build is built first and the target folder is cargo's business. */
export function runCommand(target: RunTarget, config: string): string {
  return `cargo run --bin ${target.bin} -- --config ${config} run`;
}

/** The binary's own check: the gears actually linked into it, without starting it. */
export function linkedGearsCommand(target: RunTarget): string {
  return `cargo run --bin ${target.bin} -- --list-registered-gears`;
}

/**
 * A path as a terminal, a file URI and a person can take it: no Windows
 * verbatim prefix, in either slash direction (the engine reports some paths
 * as `//?/C:/...`).
 */
export function plainPath(path: string): string {
  return path.replace(/^\\\\\?\\UNC\\/, "\\\\").replace(/^\\\\\?\\/, "")
    .replace(/^\/\/\?\/UNC\//, "//")
    .replace(/^\/\/\?\//, "");
}

/**
 * The generated configuration with a Postgres server and a database for each
 * gear in `dbGears`, or `undefined` when it already has a `database` section.
 *
 * Text, on the shape the engine writes (serde-saphyr, two-space indentation,
 * `server:` then `gears:` at the top, one key per gear under it), so the rest
 * of the file stays byte for byte what the engine wrote. A gear that is not in
 * the file is left out rather than guessed at; `missing` names it.
 */
export function withPostgres(
  yaml: string,
  dbGears: readonly string[],
  pg: PostgresTarget = LOCAL_POSTGRES,
): { text: string; missing: string[] } | undefined {
  const eol = yaml.includes("\r\n") ? "\r\n" : "\n";
  const lines = yaml.split(/\r?\n/);
  if (lines.some((line) => /^database\s*:/.test(line))) return undefined;
  const gearsAt = lines.findIndex((line) => /^gears\s*:/.test(line));
  if (gearsAt < 0) return undefined;

  const server = [
    "database:",
    "  servers:",
    "    pg:",
    '      engine: "postgres"',
    `      host: "${pg.host}"`,
    `      port: ${pg.port}`,
    `      user: "${pg.user}"`,
    `      password: "\${${pg.passwordEnv}}"`,
    "      params:",
    '        sslmode: "disable"',
  ];

  const missing: string[] = [];
  const out = [...lines];
  // Bottom-up, so earlier indices stay valid as lines are inserted.
  const positions: Array<{ at: number; gear: string }> = [];
  for (const gear of dbGears) {
    const at = out.findIndex((line, index) => index > gearsAt && line === `  ${gear}:`);
    if (at < 0) {
      missing.push(gear);
      continue;
    }
    positions.push({ at, gear });
  }
  positions.sort((a, b) => b.at - a.at);
  for (const { at, gear } of positions) {
    out.splice(at + 1, 0, `    database: { server: "pg", dbname: "${dbNameOf(gear)}" }`);
  }
  out.splice(gearsAt, 0, ...server);
  return { text: out.join(eol), missing };
}

/** What the backend found about building here. */
export interface BuildToolchain {
  /** `cargo --version`, when cargo answers. */
  readonly cargo: string | undefined;
  /** Windows only: whether the MSVC linker was found; `n/a` elsewhere or for a GNU toolchain. */
  readonly msvcLinker: "found" | "missing" | "n/a";
  /** Whether `docker` answers, for the local Postgres. */
  readonly docker: boolean;
  /** Whether the IDE's environment already sets the Postgres password variable. */
  readonly pgPasswordSet: boolean;
}

export interface ToolchainVerdict {
  readonly ready: boolean;
  readonly reason?: string;
  readonly help?: { readonly label: string; readonly url: string };
}

/** Whether Build and Run can be offered, and what to say when they cannot. */
export function toolchainVerdict(found: BuildToolchain): ToolchainVerdict {
  if (found.cargo === undefined) {
    return {
      ready: false,
      reason:
        "Build and Run need Rust's cargo on the machine the IDE runs on, and it is not on the PATH there. " +
        "Install Rust with rustup (on the desktop, or in this session's terminal), then reopen this view.",
      help: { label: "rustup.rs", url: "https://rustup.rs" },
    };
  }
  if (found.msvcLinker === "missing") {
    return {
      ready: false,
      reason:
        "Rust on Windows links with the MSVC linker (link.exe), and no Visual Studio C++ build tools were found. " +
        "Install the Build Tools with the \"Desktop development with C++\" workload, then reopen this view.",
      help: { label: "Visual Studio Build Tools", url: "https://visualstudio.microsoft.com/visual-cpp-build-tools/" },
    };
  }
  return { ready: true };
}
