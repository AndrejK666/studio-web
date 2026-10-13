import { LOCAL_ROOT_TENANT_ID, localRunCautions, withLocalDefaults } from "./local-run-defaults";

const GENERATED = `server:
  home_dir: ~/x
gears:
  account-management:
    config: {}
  api-gateway:
    config:
      bind_addr: 127.0.0.1:8087
  file-storage:
    config:
      require_signing_key_seed: true
  graph-storage:
    config:
      embedding_dimension: 768
  static-tr-plugin:
    config: {}
`;

describe("what Run sets for a gear to start on this machine", () => {
  const { text, added } = withLocalDefaults(GENERATED);

  it("fills an empty config with the gear's local values", () => {
    expect(text).toContain(`  account-management:\n    config:\n      root_tenant_type: {"gts_id":`);
    expect(text).toContain(`"root_id":"${LOCAL_ROOT_TENANT_ID}"`);
  });

  it("adds a missing key beside what the engine wrote, and never overrides a key it set", () => {
    expect(text).toContain("      embedding_dimension: 768\n      embedding_provider: \"fake\"");
    expect(text).toContain("      require_signing_key_seed: true\n");
    expect(text).not.toContain("require_signing_key_seed: false");
    expect(added).not.toContain("file-storage");
  });

  it("answers for the same root tenant account-management bootstraps", () => {
    expect(text).toContain(`  static-tr-plugin:\n    config:\n      tenants: [{"id":"${LOCAL_ROOT_TENANT_ID}"`);
    expect(added).toEqual(["account-management", "graph-storage", "static-tr-plugin"]);
  });

  it("leaves a gear it knows nothing about, and a file without gears, as they are", () => {
    expect(text).toContain("  api-gateway:\n    config:\n      bind_addr: 127.0.0.1:8087\n");
    expect(withLocalDefaults("server: {}\n")).toEqual({ text: "server: {}\n", added: [] });
  });

  it("keeps Windows line endings", () => {
    expect(withLocalDefaults(GENERATED.replace(/\n/g, "\r\n")).text).not.toMatch(/[^\r]\n/);
  });
});

describe("what Run warns about before a local run", () => {
  it("names rg-tr-plugin, which cannot find the root tenant on a fresh start, and nothing else", () => {
    const said = localRunCautions(["tenant-resolver", "rg-tr-plugin", "oagw"]);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/static-tr-plugin/);
    expect(localRunCautions(["tenant-resolver", "static-tr-plugin"])).toEqual([]);
  });
});
