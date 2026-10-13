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
import * as os from "os";
import * as path from "path";

import { withLocalDefaults } from "../common/local-run-defaults";
import {
  LOCAL_POSTGRES_PASSWORD,
  POSTGRES_IMAGE,
  PROTOC_VERSION,
  dbNameOf,
  protocAsset,
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

/** Where Studio keeps tools it fetched itself (protoc), per machine. */
export function studioToolsDir(home: string = os.homedir()): string {
  return path.join(home, "ConstructorStudio", "tools");
}

function protocExe(platform: NodeJS.Platform): string {
  return platform === "win32" ? "protoc.exe" : "protoc";
}

/** Studio's own copy of protoc, where "Get protoc" puts it. */
export function studioProtoc(home: string = os.homedir(), platform: NodeJS.Platform = process.platform): string {
  return path.join(studioToolsDir(home), `protoc-${PROTOC_VERSION}`, "bin", protocExe(platform));
}

export interface ToolchainHost {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly exists: (file: string) => boolean;
}

const HOST: ToolchainHost = { platform: process.platform, env: process.env, home: os.homedir(), exists: (file) => fs.existsSync(file) };

/**
 * cargo, the linker cargo will need, cmake and protoc, docker, whether the
 * password variable is set -- and the environment Build and Run get.
 */
export async function buildToolchain(run: Exec = exec, host: ToolchainHost = HOST): Promise<BuildToolchain> {
  const { platform, env } = host;
  const cargo = await run("cargo", ["--version"]);
  const docker = await run("docker", ["version", "--format", "{{.Server.Version}}"]);
  let msvcLinker: BuildToolchain["msvcLinker"] = "n/a";
  const vsPath = platform === "win32" ? await visualStudioPath(run, env) : undefined;
  if (cargo.ok && platform === "win32") {
    const rustc = await run("rustc", ["-vV"]);
    const hostTriple = /^host:\s*(\S+)/m.exec(rustc.stdout)?.[1] ?? "";
    if (hostTriple === "" || hostTriple.includes("msvc")) {
      msvcLinker = vsPath !== undefined || (await msvcLinkerOnPath(run)) ? "found" : "missing";
    }
  }
  const cmake = await findCmake(run, host, vsPath);
  const protoc = await findProtoc(run, host);
  return {
    cargo: cargo.ok ? cargo.stdout.trim() : undefined,
    msvcLinker,
    docker: docker.ok,
    pgPasswordSet: (env.GEARS_PG_PASSWORD ?? "") !== "",
    ...(cmake !== undefined ? { cmake } : {}),
    ...(protoc !== undefined ? { protoc } : {}),
    env: buildEnv(host, cmake, protoc),
  };
}

/**
 * What the Build and Run terminals get: a tool found off the PATH by its
 * variable (`CMAKE` is what the `cmake` crate reads, `PROTOC` what
 * `prost-build` does), and on Windows a short `CARGO_TARGET_DIR` unless the
 * member set one -- a product's tree under a project checkout is deep enough
 * that cmake's MSBuild projects pass MAX_PATH ("Could not find a part of the
 * path"). One target folder for every product also reuses what the last one
 * built.
 */
export function buildEnv(host: ToolchainHost, cmake: string | undefined, protoc: string | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  if (cmake !== undefined && cmake !== "path" && (host.env.CMAKE ?? "") === "") env.CMAKE = cmake;
  if (protoc !== undefined && protoc !== "path" && (host.env.PROTOC ?? "") === "") env.PROTOC = protoc;
  if (host.platform === "win32" && (host.env.CARGO_TARGET_DIR ?? "") === "") {
    env.CARGO_TARGET_DIR = path.win32.join(host.home, "ConstructorStudio", "target");
  }
  return env;
}

/** cmake from CMAKE or the PATH, else the copy Visual Studio's C++ workload installs off the PATH. */
async function findCmake(run: Exec, host: ToolchainHost, vsPath: string | undefined): Promise<string | undefined> {
  const set = host.env.CMAKE ?? "";
  if (set !== "" && host.exists(set)) return set;
  if ((await run("cmake", ["--version"])).ok) return "path";
  if (vsPath === undefined) return undefined;
  const bundled = path.win32.join(vsPath, "Common7", "IDE", "CommonExtensions", "Microsoft", "CMake", "CMake", "bin", "cmake.exe");
  return host.exists(bundled) ? bundled : undefined;
}

/** protoc from PROTOC, the PATH, or the copy "Get protoc" fetched. */
async function findProtoc(run: Exec, host: ToolchainHost): Promise<string | undefined> {
  const set = host.env.PROTOC ?? "";
  if (set !== "" && host.exists(set)) return set;
  if ((await run("protoc", ["--version"])).ok) return "path";
  const own = studioProtoc(host.home, host.platform);
  return host.exists(own) ? own : undefined;
}

/**
 * The Visual Studio installation with the x64 C++ tools, the way rustc's own
 * lookup finds the linker: `vswhere` naming one.
 */
async function visualStudioPath(run: Exec, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const programFiles = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const vswhere = path.win32.join(programFiles, "Microsoft Visual Studio", "Installer", "vswhere.exe");
  const found = await run(vswhere, [
    "-latest", "-products", "*",
    "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "-property", "installationPath",
  ]);
  const at = found.ok ? (found.stdout.split(/\r?\n/)[0] ?? "").trim() : "";
  return at === "" ? undefined : at;
}

/**
 * An MSVC `link.exe` on the PATH (a Developer prompt). Git's coreutils
 * `link.exe` is not one, which is why the path is checked for `MSVC`.
 */
async function msvcLinkerOnPath(run: Exec): Promise<boolean> {
  const where = await run("where.exe", ["link.exe"]);
  return where.ok && where.stdout.split(/\r?\n/).some((line) => /\\MSVC\\/i.test(line));
}

/**
 * Fetch protoc's release for this machine into Studio's tools folder, once.
 * The zip is unpacked by the system's own tool: `tar` on Windows 10+ and
 * macOS (bsdtar reads zip), `unzip` on Linux.
 */
export async function fetchProtoc(
  run: Exec = exec,
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  download: (url: string, to: string) => Promise<void> = downloadTo,
): Promise<{ ok: boolean; message: string; path?: string }> {
  const target = studioProtoc(home, platform);
  if (fs.existsSync(target)) return { ok: true, message: `protoc ${PROTOC_VERSION} is already at ${target}`, path: target };
  const asset = protocAsset(platform, arch);
  if (asset === undefined) {
    return { ok: false, message: `protobuf publishes no protoc for ${platform}-${arch}; install it with the system's package manager` };
  }
  const url = `https://github.com/protocolbuffers/protobuf/releases/download/v${PROTOC_VERSION}/${asset}`;
  const dir = path.dirname(path.dirname(target));
  const zip = path.join(studioToolsDir(home), asset);
  try {
    fs.mkdirSync(dir, { recursive: true });
    await download(url, zip);
    const unpacked =
      platform === "linux"
        ? await run("unzip", ["-o", "-q", zip, "-d", dir], 60000)
        : await run("tar", ["-xf", zip, "-C", dir], 60000);
    if (!unpacked.ok) return { ok: false, message: `${asset} could not be unpacked: ${firstLine(unpacked.stderr)}` };
    if (platform !== "win32" && fs.existsSync(target)) fs.chmodSync(target, 0o755);
  } catch (error) {
    return { ok: false, message: `protoc could not be fetched from ${url}: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    fs.rmSync(zip, { force: true });
  }
  return fs.existsSync(target)
    ? { ok: true, message: `protoc ${PROTOC_VERSION} is at ${target}; Build and Run use it`, path: target }
    : { ok: false, message: `${asset} held no ${path.basename(target)}` };
}

async function downloadTo(url: string, to: string): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  await fs.promises.writeFile(to, Buffer.from(await response.arrayBuffer()));
}

/** The docker container publishing `port` on this machine, if one does. */
export async function containerOnPort(port: number, run: Exec = exec): Promise<string | undefined> {
  const listed = await run("docker", ["ps", "--filter", `publish=${port}`, "--format", "{{.Names}}"]);
  if (!listed.ok) return undefined;
  return listed.stdout.split(/\r?\n/).map((line) => line.trim()).find((name) => name !== "");
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
 * Postgres server and one database per gear in `dbGears`, and what a gear
 * needs set to start on this machine (`LOCAL_RUN_DEFAULTS`), and return its
 * path relative to the output root. Rewritten from the generated file every
 * time, so it follows the last Generate. With nothing to add, the generated
 * file is the one to use and its path is returned.
 */
export async function writeRunConfig(
  outRoot: string,
  app: string,
  dbGears: readonly string[],
  pg: PostgresTarget,
): Promise<{ config: string; missing: string[]; defaulted: string[] }> {
  const generated = `config/${app}.yaml`;
  const text = await fs.promises.readFile(path.join(outRoot, generated), "utf8");
  const withDb = dbGears.length === 0 ? undefined : withPostgres(text, dbGears, pg);
  const defaults = withLocalDefaults(withDb?.text ?? text);
  if (withDb === undefined && defaults.added.length === 0) return { config: generated, missing: [], defaulted: [] };
  const local = `config/${app}.local.yaml`;
  const header =
    `# Written by Constructor Studio from ${generated}, for Run: the same configuration plus the\n` +
    `# database section generate leaves out (https://github.com/MikeFalcon77/gearbox/issues/4)\n` +
    `# and what ${defaults.added.length > 0 ? defaults.added.join(", ") : "a gear"} needs set to start on this machine.\n` +
    `# Rewritten on every Run; edit ${generated}'s product instead.\n`;
  await fs.promises.writeFile(path.join(outRoot, local), header + defaults.text, "utf8");
  return { config: local, missing: withDb?.missing ?? [], defaulted: defaults.added };
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
  // graph-storage's first migration creates it; a plain postgres image has none.
  const vector = await run("docker", ["exec", container, "psql", "-U", "postgres", "-tAc", "SELECT 1 FROM pg_available_extensions WHERE name = 'vector'"]);
  const noVector = vector.ok && vector.stdout.trim() !== "1";
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
      (created.length > 0 ? `; created ${created.join(", ")}` : "; its databases were already there") +
      (noVector ? `. It has no pgvector, which graph-storage needs: stop ${container} and start Studio's (${POSTGRES_IMAGE}).` : ""),
  };
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim() !== "")?.trim() ?? "no reason given";
}
