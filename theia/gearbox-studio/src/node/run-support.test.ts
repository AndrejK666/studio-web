import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  buildEnv,
  buildToolchain,
  containerOnPort,
  startLocalPostgres,
  studioProtoc,
  writeRunConfig,
  type Exec,
  type ExecResult,
  type ToolchainHost,
} from "./run-support";
import { LOCAL_POSTGRES } from "../common/run-product";

const ok = (stdout = ""): ExecResult => ({ ok: true, stdout, stderr: "" });
const fail = (stderr = "not found"): ExecResult => ({ ok: false, stdout: "", stderr });

/** A fake `execFile`: answers by the command line, records every call. */
function fakeExec(answers: Record<string, ExecResult | ExecResult[]>): Exec & { calls: string[] } {
  const calls: string[] = [];
  const run = (async (file: string, args: readonly string[]) => {
    const line = [file, ...args].join(" ");
    calls.push(line);
    const key = Object.keys(answers).find((prefix) => line.startsWith(prefix));
    if (key === undefined) return fail();
    const answer = answers[key];
    if (Array.isArray(answer)) return answer.length > 1 ? (answer.shift() as ExecResult) : (answer[0] as ExecResult);
    return answer as ExecResult;
  }) as Exec & { calls: string[] };
  run.calls = calls;
  return run;
}

/** A machine: its platform, environment and the files that exist on it. */
function on(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}, files: readonly string[] = []): ToolchainHost {
  return { platform, env, home: platform === "win32" ? "C:\\Users\\ada" : "/home/ada", exists: (file) => files.includes(file) };
}

const VS = "C:\\BuildTools";
const VS_CMAKE = "C:\\BuildTools\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe";

describe("what the machine has for Build and Run", () => {
  it("finds cargo and docker on Linux, where no linker question arises", async () => {
    const found = await buildToolchain(fakeExec({ "cargo --version": ok("cargo 1.97.0 (x)\n"), docker: ok("29.8.1") }), on("linux"));
    expect(found).toEqual({ cargo: "cargo 1.97.0 (x)", msvcLinker: "n/a", docker: true, pgPasswordSet: false, env: {} });
  });

  it("says cargo is missing when it does not answer", async () => {
    const found = await buildToolchain(fakeExec({}), on("linux"));
    expect(found.cargo).toBeUndefined();
    expect(found.docker).toBe(false);
  });

  it("on Windows with an MSVC toolchain, finds the build tools through vswhere", async () => {
    const run = fakeExec({
      "cargo --version": ok("cargo 1.97.0"),
      "rustc -vV": ok("rustc 1.97.0\nhost: x86_64-pc-windows-msvc\n"),
      "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe": ok("C:\\BuildTools\n"),
    });
    expect((await buildToolchain(run, on("win32"))).msvcLinker).toBe("found");
  });

  it("on Windows, does not take Git's coreutils link.exe for the MSVC linker", async () => {
    const run = fakeExec({
      "cargo --version": ok("cargo 1.97.0"),
      "rustc -vV": ok("host: x86_64-pc-windows-msvc\n"),
      "where.exe link.exe": ok("C:\\Program Files\\Git\\usr\\bin\\link.exe\r\n"),
    });
    expect((await buildToolchain(run, on("win32"))).msvcLinker).toBe("missing");
  });

  it("on Windows, accepts an MSVC link.exe on the PATH", async () => {
    const run = fakeExec({
      "cargo --version": ok("cargo 1.97.0"),
      "rustc -vV": ok("host: x86_64-pc-windows-msvc\n"),
      "where.exe link.exe": ok("C:\\VS\\VC\\Tools\\MSVC\\14.40\\bin\\Hostx64\\x64\\link.exe\r\n"),
    });
    expect((await buildToolchain(run, on("win32"))).msvcLinker).toBe("found");
  });

  it("asks nothing about MSVC for a GNU toolchain", async () => {
    const run = fakeExec({ "cargo --version": ok("cargo 1.97.0"), "rustc -vV": ok("host: x86_64-pc-windows-gnu\n") });
    expect((await buildToolchain(run, on("win32"))).msvcLinker).toBe("n/a");
  });

  it("finds cmake and protoc on the PATH, and passes nothing for them", async () => {
    const found = await buildToolchain(fakeExec({ "cmake --version": ok("cmake 3.31"), "protoc --version": ok("libprotoc 36.2") }), on("linux"));
    expect(found.cmake).toBe("path");
    expect(found.protoc).toBe("path");
    expect(found.env).toEqual({});
  });

  it("on Windows, finds the cmake Visual Studio installs off the PATH and hands it to the build as CMAKE", async () => {
    const run = fakeExec({
      "cargo --version": ok("cargo 1.97.0"),
      "rustc -vV": ok("host: x86_64-pc-windows-msvc\n"),
      "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe": ok(`${VS}\r\n`),
    });
    const found = await buildToolchain(run, on("win32", {}, [VS_CMAKE]));
    expect(found.cmake).toBe(VS_CMAKE);
    expect(found.env?.CMAKE).toBe(VS_CMAKE);
  });

  it("uses the protoc Studio fetched when there is none on the PATH", async () => {
    const own = studioProtoc("/home/ada", "linux");
    const found = await buildToolchain(fakeExec({}), on("linux", {}, [own]));
    expect(found.protoc).toBe(own);
    expect(found.env?.PROTOC).toBe(own);
    expect((await buildToolchain(fakeExec({}), on("linux"))).protoc).toBeUndefined();
  });

  it("notices a password variable the IDE's environment already sets", async () => {
    expect((await buildToolchain(fakeExec({}), on("linux", { GEARS_PG_PASSWORD: "x" }))).pgPasswordSet).toBe(true);
  });
});

describe("the environment Build and Run share", () => {
  it("gives Windows a short target folder, so cmake's MSBuild stays under MAX_PATH", () => {
    expect(buildEnv(on("win32"), "path", "path")).toEqual({ CARGO_TARGET_DIR: "C:\\Users\\ada\\ConstructorStudio\\target" });
    expect(buildEnv(on("linux"), "path", "path")).toEqual({});
  });

  it("leaves what the member set alone", () => {
    const host = on("win32", { CARGO_TARGET_DIR: "D:\\t", CMAKE: "D:\\cmake.exe", PROTOC: "D:\\protoc.exe" });
    expect(buildEnv(host, VS_CMAKE, "C:\\protoc.exe")).toEqual({});
  });
});

describe("the container a Postgres already answers from", () => {
  it("is the one docker says publishes the port", async () => {
    const run = fakeExec({ "docker ps --filter publish=5432": ok("gbx-pg-shop\n") });
    expect(await containerOnPort(5432, run)).toBe("gbx-pg-shop");
    expect(await containerOnPort(5432, fakeExec({ "docker ps": ok("") }))).toBeUndefined();
    expect(await containerOnPort(5432, fakeExec({}))).toBeUndefined();
  });
});

describe("Studio's run configuration", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gbx-run-"));
    fs.mkdirSync(path.join(root, "config"));
    fs.writeFileSync(path.join(root, "config", "shop.yaml"), "server:\n  home_dir: ~/x\ngears:\n  bss-pricing:\n    config: {}\n");
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("writes the copy beside the generated file and leaves the generated file alone", async () => {
    const result = await writeRunConfig(root, "shop", ["bss-pricing"], LOCAL_POSTGRES);
    expect(result).toEqual({ config: "config/shop.local.yaml", missing: [], defaulted: [] });
    const local = fs.readFileSync(path.join(root, "config", "shop.local.yaml"), "utf8");
    expect(local).toMatch(/^# Written by Constructor Studio from config\/shop\.yaml/);
    expect(local).toContain('dbname: "bss_pricing"');
    expect(fs.readFileSync(path.join(root, "config", "shop.yaml"), "utf8")).not.toContain("database");
  });

  it("uses the generated file when nothing needs a database", async () => {
    expect(await writeRunConfig(root, "shop", [], LOCAL_POSTGRES)).toEqual({ config: "config/shop.yaml", missing: [], defaulted: [] });
    expect(fs.existsSync(path.join(root, "config", "shop.local.yaml"))).toBe(false);
  });

  it("writes the copy for a gear that needs a value set to start, database or not", async () => {
    fs.writeFileSync(path.join(root, "config", "shop.yaml"), "server:\n  home_dir: ~/x\ngears:\n  graph-storage:\n    config: {}\n");
    const result = await writeRunConfig(root, "shop", [], LOCAL_POSTGRES);
    expect(result).toEqual({ config: "config/shop.local.yaml", missing: [], defaulted: ["graph-storage"] });
    expect(fs.readFileSync(path.join(root, "config", "shop.local.yaml"), "utf8")).toContain('      embedding_provider: "fake"');
  });
});

describe("the local Postgres", () => {
  const request = { container: "gbx-pg-shop", port: 5432, databases: ["bss_pricing", "types_registry"] };

  it("starts a container, waits for it, and creates the databases that are missing", async () => {
    const run = fakeExec({
      "docker inspect": fail("No such object"),
      "docker run": ok("abc\n"),
      "docker exec gbx-pg-shop pg_isready": [fail(), ok()],
      "docker exec gbx-pg-shop psql -U postgres -tAc SELECT 1 FROM pg_database WHERE datname = 'bss_pricing'": ok("1\n"),
      "docker exec gbx-pg-shop psql -U postgres -tAc SELECT 1 FROM pg_available_extensions": ok("1\n"),
      "docker exec gbx-pg-shop psql": ok(""),
      "docker exec gbx-pg-shop createdb": ok(),
    });
    const result = await startLocalPostgres(request, run);
    expect(result).toEqual({ ok: true, message: "Postgres is up in gbx-pg-shop on 127.0.0.1:5432; created types_registry" });
    expect(run.calls).toContain(
      "docker run -d --name gbx-pg-shop -p 127.0.0.1:5432:5432 -e POSTGRES_PASSWORD=gears pgvector/pgvector:pg18",
    );
    expect(run.calls.filter((c) => c.includes("createdb"))).toEqual(["docker exec gbx-pg-shop createdb -U postgres types_registry"]);
  }, 10000);

  it("reuses a stopped container instead of making a second one", async () => {
    const run = fakeExec({
      "docker inspect": ok("false\n"),
      "docker start": ok(),
      "docker exec gbx-pg-shop pg_isready": ok(),
      "docker exec gbx-pg-shop psql": ok("1\n"),
    });
    const result = await startLocalPostgres(request, run);
    expect(result.message).toMatch(/already there/);
    expect(run.calls.some((c) => c.startsWith("docker run"))).toBe(false);
    expect(run.calls).toContain("docker start gbx-pg-shop");
  });

  it("says why docker could not start it", async () => {
    const run = fakeExec({
      "docker inspect": fail(),
      "docker run": fail("Bind for 127.0.0.1:5432 failed: port is already allocated\n"),
    });
    expect(await startLocalPostgres(request, run)).toEqual({
      ok: false,
      message: "docker could not start pgvector/pgvector:pg18 as gbx-pg-shop: Bind for 127.0.0.1:5432 failed: port is already allocated",
    });
  });

  it("says a Postgres without pgvector will not hold graph-storage", async () => {
    const run = fakeExec({
      "docker inspect": ok("true\n"),
      "docker exec gbx-pg-other pg_isready": ok(),
      "docker exec gbx-pg-other psql -U postgres -tAc SELECT 1 FROM pg_available_extensions": ok(""),
      "docker exec gbx-pg-other psql": ok("1\n"),
    });
    const result = await startLocalPostgres({ ...request, container: "gbx-pg-other" }, run);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/no pgvector/);
  });
});
