import { describe, expect, it } from "vitest";

import type { Connection, RemoteRepo } from "./api";
import { asRows, checkoutDir, hasRepository, named, withPicked, without } from "./project-sources";
import type { ProjectSource } from "./project-sources";

const connection = {
  id: "c1",
  provider: "github",
  secret_ref: "studio-connection-c1",
} as Connection;

const src = (full_path: string, clone_url = `https://github.com/${full_path}.git`): ProjectSource => ({
  connection_id: "c1",
  full_path,
  clone_url,
});

describe("checkout directories", () => {
  it("are the last segment, spelled as the backend spells them", () => {
    expect(checkoutDir("acme/studio-web")).toBe("studio-web");
    expect(checkoutDir("group/sub/Studio.Web")).toBe("studio-web");
    expect(checkoutDir("")).toBe("source");
  });

  it("take suffixes in order, and a source with nothing to clone takes none", () => {
    const dirs = named([src("a/app"), src("b/app"), { ...src("c/app"), clone_url: "" }, src("d/app")]).map((n) => n.dir);
    expect(dirs).toEqual(["app", "app-2", "app-3"]);
  });
});

describe("picking repositories", () => {
  const pick = (full_path: string, branch?: string): RemoteRepo => ({
    id: full_path,
    name: full_path.split("/")[1],
    full_path,
    clone_url: `https://github.com/${full_path}.git`,
    default_branch: branch,
  });

  it("adds each through its connection with its default branch", () => {
    const got = withPicked([], connection, [pick("acme/api", "main")]);
    expect(got.added).toBe(1);
    expect(got.sources).toEqual([
      { connection_id: "c1", full_path: "acme/api", clone_url: "https://github.com/acme/api.git", branch: "main" },
    ]);
  });

  it("does not add a repository the config already lists, however its URL is spelled", () => {
    const got = withPicked([src("acme/api", "https://GitHub.com/Acme/api")], connection, [pick("acme/api")]);
    expect(got.added).toBe(0);
    expect(hasRepository(got.sources, "https://github.com/acme/api.git")).toBe(true);
  });
});

describe("detaching", () => {
  it("removes the source checked out into that directory and no other", () => {
    const sources = [src("a/app"), src("b/app")];
    expect(without(sources, "app-2")).toEqual([src("a/app")]);
    expect(without(sources, "nope")).toEqual(sources);
  });
});

describe("rows", () => {
  it("carry the directory, the provider and the connection's token reference", () => {
    expect(asRows([{ ...src("acme/api"), branch: "dev" }], [connection])).toEqual([
      { name: "api", source: "github", url: "https://github.com/acme/api.git", branch: "dev", token_ref: "studio-connection-c1" },
    ]);
  });

  it("of a connection not visible from here have no token reference", () => {
    expect(asRows([src("acme/api")], [])[0]).toEqual({
      name: "api",
      source: "git",
      url: "https://github.com/acme/api.git",
    });
  });
});
