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
import * as zlib from "zlib";

import {
  LOCAL_POSTGRES_PASSWORD,
  POSTGRES_IMAGE,
  PROTOC_VERSION,
  dbNameOf,
  protocAsset,
  protocUrl,
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

/** cargo, the linker cargo will need, docker, protoc, and whether the password variable is set. */
export async function buildToolchain(
  run: Exec = exec,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
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
    protoc: await findProtoc(run, platform, env, home),
  };
}

/** Where Studio keeps the protoc it installs: beside the shared corpus, one folder per version. */
export function protocHome(home: string = os.homedir()): string {
  return path.join(home, "ConstructorStudio", "tools", `protoc-${PROTOC_VERSION}`);
}

function protocBinary(root: string, platform: NodeJS.Platform): string {
  return path.join(root, "bin", platform === "win32" ? "protoc.exe" : "protoc");
}

/**
 * The protoc a build would use, in prost-build's order: `PROTOC` when it names
 * a file, then the PATH; then the copy Studio installed, which the terminals get
 * as `PROTOC`, since it is on no PATH.
 */
async function findProtoc(
  run: Exec,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): Promise<string | undefined> {
  const named = env.PROTOC ?? "";
  if (named !== "" && fs.existsSync(named)) return named;
  if ((await run("protoc", ["--version"])).ok) return "protoc";
  const own = protocBinary(protocHome(home), platform);
  return fs.existsSync(own) ? own : undefined;
}

/**
 * Every file of a zip archive, by its path inside it. Enough of the format for
 * a release archive -- stored or deflated entries, no encryption, no zip64 --
 * so installing protoc needs no unzip program, which a Windows machine may not
 * have and a container image often does not.
 */
export function unzip(archive: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  // The end of central directory record: its signature, searched from the end
  // past a comment of at most 64 KiB.
  let end = -1;
  for (let at = archive.length - 22; at >= Math.max(0, archive.length - 22 - 0xffff); at--) {
    if (archive.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error("not a zip archive");
  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (archive.readUInt32LE(at) !== 0x02014b50) throw new Error("a damaged zip directory");
    const method = archive.readUInt16LE(at + 10);
    const size = archive.readUInt32LE(at + 20);
    const nameLength = archive.readUInt16LE(at + 28);
    const extraLength = archive.readUInt16LE(at + 30);
    const commentLength = archive.readUInt16LE(at + 32);
    const local = archive.readUInt32LE(at + 42);
    const name = archive.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    const dataAt = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const data = archive.subarray(dataAt, dataAt + size);
    if (method === 0) files.set(name, Buffer.from(data));
    else if (method === 8) files.set(name, zlib.inflateRawSync(data));
    else throw new Error(`${name}: compression method ${method} is not supported`);
  }
  return files;
}

export type Fetch = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

/**
 * Download the pinned protoc release for this machine into `protocHome()`, with
 * the well-known `.proto` files beside it (`include/`, which protoc finds
 * relative to itself), and answer the binary's path. An archive entry that
 * would land outside the folder is refused.
 */
export async function installProtoc(
  fetchImpl: Fetch = (url) => fetch(url),
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  home: string = os.homedir(),
): Promise<{ ok: boolean; message: string; path?: string }> {
  const asset = protocAsset(platform, arch);
  if (asset === undefined) {
    return { ok: false, message: `protoc ${PROTOC_VERSION} has no release for ${platform} ${arch}; install it with the system's package manager.` };
  }
  const url = protocUrl(asset);
  let archive: Buffer;
  try {
    const response = await fetchImpl(url);
    if (!response.ok) return { ok: false, message: `${url} answered ${response.status}.` };
    archive = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    return { ok: false, message: `${url} could not be downloaded: ${error instanceof Error ? error.message : String(error)}` };
  }
  const root = protocHome(home);
  let files: Map<string, Buffer>;
  try {
    files = unzip(archive);
  } catch (error) {
    return { ok: false, message: `${asset} could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  // Every entry is checked before anything is written, so a refused archive
  // leaves nothing behind.
  const writes: [string, Buffer][] = [];
  for (const [name, data] of files) {
    const target = path.resolve(root, name);
    if (target === root || !target.startsWith(root + path.sep)) {
      return { ok: false, message: `${asset} has an entry outside its folder (${name}); nothing was installed.` };
    }
    writes.push([target, data]);
  }
  for (const [target, data] of writes) {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, data);
  }
  const binary = protocBinary(root, platform);
  if (!fs.existsSync(binary)) return { ok: false, message: `${asset} holds no ${path.basename(binary)}.` };
  if (platform !== "win32") await fs.promises.chmod(binary, 0o755);
  return { ok: true, message: `protoc ${PROTOC_VERSION} is installed in ${root}; Build and Run use it.`, path: binary };
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
