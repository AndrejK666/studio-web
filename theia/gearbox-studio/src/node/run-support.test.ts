import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { buildToolchain, startLocalPostgres, writeRunConfig, type Exec, type ExecResult } from "./run-support";
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

describe("what the machine has for Build and Run", () => {
  it("finds cargo and docker on Linux, where no linker question arises", async () => {
    const found = await buildToolchain(fakeExec({ "cargo --version": ok("cargo 1.97.0 (x)\n"), docker: ok("29.8.1") }), "linux", {});
    expect(found).toEqual({ cargo: "cargo 1.97.0 (x)", msvcLinker: "n/a", docker: true, pgPasswordSet: false });
  });

  it("says cargo is missing when it does not answer", async () => {
    const found = await buildToolchain(fakeExec({}), "linux", {});
    expect(found.cargo).toBeUndefined();
    expect(found.docker).toBe(false);
  });

  it("on Windows with an MSVC toolchain, finds the build tools through vswhere", async () => {
    const run = fakeExec({
      "cargo --version": ok("cargo 1.97.0"),
      "rustc -vV": ok("rustc 1.97.0\nhost: x86_64-pc-windows-msvc\n"),
      "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe": ok("C:\\BuildTools\n"),
    });
    expect((await buildToolchain(run, "win32", {})).msvcLinker).toBe("found");
  });

  it("on Windows, does not take Git's coreutils link.exe for the MSVC linker", async () => {
    const run = fakeExec({
      "cargo --version": ok("cargo 1.97.0"),
      "rustc -vV": ok("host: x86_64-pc-windows-msvc\n"),
      "where.exe link.exe": ok("C:\\Program Files\\Git\\usr\\bin\\link.exe\r\n"),
    });
    expect((await buildToolchain(run, "win32", {})).msvcLinker).toBe("missing");
  });

  it("on Windows, accepts an MSVC link.exe on the PATH", async () => {
    const run = fakeExec({
      "cargo --version": ok("cargo 1.97.0"),
      "rustc -vV": ok("host: x86_64-pc-windows-msvc\n"),
      "where.exe link.exe": ok("C:\\VS\\VC\\Tools\\MSVC\\14.40\\bin\\Hostx64\\x64\\link.exe\r\n"),
    });
    expect((await buildToolchain(run, "win32", {})).msvcLinker).toBe("found");
  });

  it("asks nothing about MSVC for a GNU toolchain", async () => {
    const run = fakeExec({ "cargo --version": ok("cargo 1.97.0"), "rustc -vV": ok("host: x86_64-pc-windows-gnu\n") });
    expect((await buildToolchain(run, "win32", {})).msvcLinker).toBe("n/a");
  });

  it("notices a password variable the IDE's environment already sets", async () => {
    expect((await buildToolchain(fakeExec({}), "linux", { GEARS_PG_PASSWORD: "x" })).pgPasswordSet).toBe(true);
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
    expect(result).toEqual({ config: "config/shop.local.yaml", missing: [] });
    const local = fs.readFileSync(path.join(root, "config", "shop.local.yaml"), "utf8");
    expect(local).toMatch(/^# Written by Constructor Studio from config\/shop\.yaml/);
    expect(local).toContain('dbname: "bss_pricing"');
    expect(fs.readFileSync(path.join(root, "config", "shop.yaml"), "utf8")).not.toContain("database");
  });

  it("uses the generated file when nothing needs a database", async () => {
    expect(await writeRunConfig(root, "shop", [], LOCAL_POSTGRES)).toEqual({ config: "config/shop.yaml", missing: [] });
    expect(fs.existsSync(path.join(root, "config", "shop.local.yaml"))).toBe(false);
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
      "docker exec gbx-pg-shop psql": ok(""),
      "docker exec gbx-pg-shop createdb": ok(),
    });
    const result = await startLocalPostgres(request, run);
    expect(result).toEqual({ ok: true, message: "Postgres is up in gbx-pg-shop on 127.0.0.1:5432; created types_registry" });
    expect(run.calls).toContain(
      "docker run -d --name gbx-pg-shop -p 127.0.0.1:5432:5432 -e POSTGRES_PASSWORD=gears postgres:18-alpine",
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
      message: "docker could not start postgres:18-alpine as gbx-pg-shop: Bind for 127.0.0.1:5432 failed: port is already allocated",
    });
  });
});
