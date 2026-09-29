// Constructor Studio: what the IDE's machine can do to build and run a
// generated product -- cargo, the MSVC linker on Windows, docker for a local
// Postgres -- and the two things done on disk for Run: Studio's copy of the
// configuration with a database section, and a local Postgres with one
// database per gear. See `common/run-product.ts` for the rules.
//
// Everything here runs on the IDE backend, which is where the terminal's
// commands run too: on the desktop that is the member's machine, in a portal
// session it is the session container (whose image has no Rust, so Build and
// Run say so there).

import { execFile } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";

import {
  LOCAL_POSTGRES_PASSWORD,
  POSTGRES_IMAGE,
  dbNameOf,
  withPostgres,
  type BuildToolchain,
  type PostgresTarget,
} from "../common/run-product";

export interface ExecResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export type Exec = (file: string, args: readonly string[], timeoutMs?: number) => Promise<ExecResult>;

/** `execFile`, answering instead of throwing: a missing program is `ok: false`. */
export const exec: Exec = (file, args, timeoutMs = 15000) =>
  new Promise((resolve) => {
    execFile(file, [...args], { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: error === null, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });

/** cargo, the linker cargo will need, docker, and whether the password variable is set. */
export async function buildToolchain(
  run: Exec = exec,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BuildToolchain> {
  const cargo = await run("cargo", ["--version"]);
  const docker = await run("docker", ["version", "--format", "{{.Server.Version}}"]);
  let msvcLinker: BuildToolchain["msvcLinker"] = "n/a";
  if (cargo.ok && platform === "win32") {
    const rustc = await run("rustc", ["-vV"]);
    const host = /^host:\s*(\S+)/m.exec(rustc.stdout)?.[1] ?? "";
    if (host === "" || host.includes("msvc")) {
      msvcLinker = (await hasMsvcBuildTools(run, env)) ? "found" : "missing";
    }
  }
  return {
    cargo: cargo.ok ? cargo.stdout.trim() : undefined,
    msvcLinker,
    docker: docker.ok,
    pgPasswordSet: (env.GEARS_PG_PASSWORD ?? "") !== "",
  };
}

/**
 * Whether the Visual C++ build tools are installed, the way rustc's own lookup
 * finds them: `vswhere` naming an installation with the x64 tools, or an MSVC
 * `link.exe` on the PATH (a Developer prompt). Git's coreutils `link.exe` is
 * not one, which is why the path is checked for `MSVC`.
 */
async function hasMsvcBuildTools(run: Exec, env: NodeJS.ProcessEnv): Promise<boolean> {
  const programFiles = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const vswhere = path.win32.join(programFiles, "Microsoft Visual Studio", "Installer", "vswhere.exe");
  const found = await run(vswhere, [
    "-latest", "-products", "*",
    "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "-property", "installationPath",
  ]);
  if (found.ok && found.stdout.trim() !== "") return true;
  const where = await run("where.exe", ["link.exe"]);
  return where.ok && where.stdout.split(/\r?\n/).some((line) => /\\MSVC\\/i.test(line));
}

/** Whether something accepts a TCP connection at host:port within `timeoutMs`. */
export function portAnswers(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (answer: boolean): void => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * Write `config/<app>.local.yaml` beside the generated configuration, with a
 * Postgres server and one database per gear in `dbGears`, and return its path
 * relative to the output root. Rewritten from the generated file every time, so
 * it follows the last Generate. Without a database to add, the generated file
 * is the one to use and its path is returned.
 */
export async function writeRunConfig(
  outRoot: string,
  app: string,
  dbGears: readonly string[],
  pg: PostgresTarget,
): Promise<{ config: string; missing: string[] }> {
  const generated = `config/${app}.yaml`;
  if (dbGears.length === 0) return { config: generated, missing: [] };
  const text = await fs.promises.readFile(path.join(outRoot, generated), "utf8");
  const local = `config/${app}.local.yaml`;
  const added = withPostgres(text, dbGears, pg);
  const header =
    `# Written by Constructor Studio from ${generated}, for Run: the same configuration plus the\n` +
    `# database section generate leaves out (https://github.com/MikeFalcon77/gearbox/issues/4).\n` +
    `# Rewritten on every Run; edit ${generated}'s product instead.\n`;
  await fs.promises.writeFile(path.join(outRoot, local), header + (added?.text ?? text), "utf8");
  return { config: local, missing: added?.missing ?? [] };
}

export interface LocalPostgresRequest {
  readonly container: string;
  readonly port: number;
  readonly databases: readonly string[];
}

/**
 * Start (or reuse) a local Postgres container for a product and create its
 * databases. Explicit, asked for by a button: nothing starts a database on its
 * own. The container keeps its data between runs; only a missing database is
 * created.
 */
export async function startLocalPostgres(request: LocalPostgresRequest, run: Exec = exec): Promise<{ ok: boolean; message: string }> {
  const { container, port } = request;
  const state = await run("docker", ["inspect", "-f", "{{.State.Running}}", container]);
  if (!state.ok) {
    const started = await run(
      "docker",
      ["run", "-d", "--name", container, "-p", `127.0.0.1:${port}:5432`, "-e", `POSTGRES_PASSWORD=${LOCAL_POSTGRES_PASSWORD}`, POSTGRES_IMAGE],
      180000,
    );
    if (!started.ok) {
      return { ok: false, message: `docker could not start ${POSTGRES_IMAGE} as ${container}: ${firstLine(started.stderr)}` };
    }
  } else if (state.stdout.trim() !== "true") {
    const started = await run("docker", ["start", container]);
    if (!started.ok) return { ok: false, message: `docker could not start ${container}: ${firstLine(started.stderr)}` };
  }

  let ready = false;
  for (let attempt = 0; attempt < 30 && !ready; attempt++) {
    ready = (await run("docker", ["exec", container, "pg_isready", "-U", "postgres", "-h", "127.0.0.1"])).ok;
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!ready) return { ok: false, message: `${container} did not accept connections within 30 seconds` };

  const created: string[] = [];
  for (const database of request.databases.map(dbNameOf)) {
    const exists = await run("docker", ["exec", container, "psql", "-U", "postgres", "-tAc", `SELECT 1 FROM pg_database WHERE datname = '${database}'`]);
    if (exists.stdout.trim() === "1") continue;
    const made = await run("docker", ["exec", container, "createdb", "-U", "postgres", database]);
    if (!made.ok) return { ok: false, message: `could not create database ${database}: ${firstLine(made.stderr)}` };
    created.push(database);
  }
  return {
    ok: true,
    message:
      `Postgres is up in ${container} on 127.0.0.1:${port}` +
      (created.length > 0 ? `; created ${created.join(", ")}` : "; its databases were already there"),
  };
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim() !== "")?.trim() ?? "no reason given";
}
