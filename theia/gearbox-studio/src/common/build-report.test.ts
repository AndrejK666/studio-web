import { BuildWatcher, failureStep, newBuildId, plainText } from "./build-report";

describe("build-report", () => {
  it("a build passes when cargo says it finished, read across chunks and colours", () => {
    const w = new BuildWatcher("build");
    expect(w.feed("   Compiling gbx-shop v0.1.0\r\n    \x1b[1m\x1b[32mFini")).toBeUndefined();
    expect(w.feed("shed\x1b[0m `dev` profile [unoptimized + debuginfo] target(s) in 1m 20s\r\n")).toEqual({
      status: "passed",
    });
    // Once said, never again.
    expect(w.feed("    Finished `dev` profile target(s) in 0.1s\n")).toBeUndefined();
  });

  it("a build that stops names its first error and the step", () => {
    const w = new BuildWatcher("build");
    expect(w.feed("error[E0425]: cannot find value `x` in this scope\n")).toBeUndefined();
    expect(w.feed("error[E0308]: mismatched types\n")).toBeUndefined();
    expect(w.feed("error: could not compile `gbx-shop` (bin \"gbx-shop\") due to 2 previous errors\n")).toEqual({
      status: "failed",
      failure: "error[E0425]: cannot find value `x` in this scope",
      failureStep: "compile",
    });
  });

  it("a missing protoc is told as protoc, not as the build script that panicked", () => {
    const w = new BuildWatcher("run");
    w.feed("error: failed to run custom build command for `cf-gears-grpc v0.3.0`\n");
    expect(
      w.feed("  Could not find `protoc`. If `protoc` is installed, try setting the `PROTOC` environment variable.\n"),
    ).toBeUndefined();
    // With one job nothing more is printed: the terminal falls quiet.
    const out = w.idle();
    expect(out?.status).toBe("failed");
    expect(out?.failureStep).toBe("protoc");
    expect(out?.failure).toContain("Could not find `protoc`");
  });

  it("quiet is no outcome while cargo is compiling", () => {
    const w = new BuildWatcher("build");
    w.feed("   Compiling serde v1.0.0\n");
    expect(w.idle()).toBeUndefined();
  });

  it("a build that ran parallel jobs says so after a failed build script", () => {
    const w = new BuildWatcher("build");
    w.feed("error: failed to run custom build command for `x`\n");
    expect(w.feed("warning: build failed, waiting for other jobs to finish...\n")?.failureStep).toBe("build script");
  });

  it("a run passes its build when cargo starts the binary; a build ignores that line", () => {
    expect(new BuildWatcher("run").feed("     Running `target/debug/gbx-shop --config c.yaml run`\n")).toEqual({
      status: "passed",
    });
    expect(new BuildWatcher("build").feed("     Running `target/debug/gbx-shop`\n")).toBeUndefined();
  });

  it("no cargo on the machine is a failed toolchain", () => {
    expect(new BuildWatcher("build").feed("'cargo' is not recognized as an internal or external command,\r\n")).toEqual({
      status: "failed",
      failure: "'cargo' is not recognized as an internal or external command,",
      failureStep: "toolchain",
    });
  });

  it("names steps, strips terminal sequences and makes ids the server takes", () => {
    expect(failureStep("error: linking with `link.exe` failed")).toBe("link");
    expect(failureStep("error: failed to run custom build command for `x`")).toBe("build script");
    expect(plainText("\x1b]0;title\x07\x1b[31mred\x1b[0m")).toBe("red");
    const id = newBuildId(1_760_000_000_000, () => 0.5);
    expect(id).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(id).toBe(`b-${(1_760_000_000_000).toString(36)}-7fffffff`);
  });
});
