// Constructor Studio: what a gear needs set before it starts on a member's
// machine, for Run.
//
// **Temporary, and in the wrong place.** Each entry is knowledge about one
// gear -- what its config refuses to start without, and the value that is safe
// on a local machine -- and that belongs to the gear: its `gear.gdl` should say
// it, and the engine should write it into the configuration it generates for an
// `embedded` or `self_hosted` profile. Until it does (constructorfabric/gearbox
// issue linked in the PR that added this file), Run adds these to Studio's
// `config/<app>.local.yaml`, and only a key the generated file does not already
// set. Each entry names the failure it answers, as seen running the gears-rust
// corpus at 70a5354 on 2026-10-13.

/**
 * The root tenant of a local product: the id `toolkit-security` treats as the
 * default tenant, which account-management bootstraps and the static tenant
 * resolver answers for.
 */
export const LOCAL_ROOT_TENANT_ID = "00000000-df51-5b42-9538-d2b56b7ee953";

export const LOCAL_RUN_DEFAULTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  // Without a bootstrap there is no root tenant, and oagw's post-init stops:
  // "Failed to resolve root tenant: tenant not found".
  "account-management": {
    root_tenant_type: { gts_id: "gts.cf.core.am.tenant_type.v1~cf.core.am.platform.v1~", idp_provisioning: false },
    bootstrap: {
      root_id: LOCAL_ROOT_TENANT_ID,
      root_name: "local-root",
      idp_wait_timeout: "5m",
      idp_retry_backoff_initial: "2s",
      idp_retry_backoff_max: "30s",
      strict: false,
    },
  },
  // "signing_key_seed is required (set require_signing_key_seed: false to allow
  // an ephemeral per-boot key in dev)".
  "file-storage": { require_signing_key_seed: false },
  // "graph-storage.embedding_provider is not set; name one of `fake`, `onnx`
  // or `remote`". The fake answers searches without meaningful ranking.
  "graph-storage": { embedding_provider: "fake" },
  // The static resolver answers only for the tenants its config lists.
  "static-tr-plugin": {
    tenants: [{ id: LOCAL_ROOT_TENANT_ID, name: "local-root", parent_id: null, status: "active" }],
  },
};

/**
 * The generated configuration with `defaults` added to each gear's `config:`
 * block, a key at a time and only where the block does not set it already.
 * Text, on the shape the engine writes (`  <gear>:` then `    config: {}` or
 * `    config:` with keys at six spaces), each value written as JSON -- a
 * subset of YAML -- so the rest of the file stays as the engine wrote it.
 * `added` names the gears that got anything.
 */
export function withLocalDefaults(
  yaml: string,
  defaults: Readonly<Record<string, Readonly<Record<string, unknown>>>> = LOCAL_RUN_DEFAULTS,
): { text: string; added: string[] } {
  const eol = yaml.includes("\r\n") ? "\r\n" : "\n";
  const lines = yaml.split(/\r?\n/);
  const gearsAt = lines.findIndex((line) => /^gears\s*:/.test(line));
  if (gearsAt < 0) return { text: yaml, added: [] };
  const added: string[] = [];
  for (const [gear, values] of Object.entries(defaults)) {
    const at = lines.findIndex((line, index) => index > gearsAt && line === `  ${gear}:`);
    if (at < 0) continue;
    let end = at + 1;
    while (end < lines.length && (lines[end] ?? "").startsWith("    ")) end++;
    const configAt = lines.findIndex((line, index) => index > at && index < end && /^ {4}config\s*:/.test(line));
    if (configAt < 0) continue;
    const configLine = lines[configAt] ?? "";
    let blockEnd = configAt + 1;
    while (blockEnd < end && (lines[blockEnd] ?? "").startsWith("      ")) blockEnd++;
    const present = new Set(
      lines
        .slice(configAt + 1, blockEnd)
        .filter((line) => /^ {6}[^ ]/.test(line))
        .map((line) => line.trim().split(":")[0]),
    );
    const missing = Object.entries(values).filter(([key]) => !present.has(key));
    if (missing.length === 0) continue;
    const rendered = missing.map(([key, value]) => `      ${key}: ${JSON.stringify(value)}`);
    if (/^ {4}config\s*:\s*\{\s*\}\s*$/.test(configLine)) {
      lines.splice(configAt, 1, "    config:", ...rendered);
    } else if (/^ {4}config\s*:\s*$/.test(configLine)) {
      lines.splice(blockEnd, 0, ...rendered);
    } else {
      // An inline mapping with keys of its own: left as the engine wrote it.
      continue;
    }
    added.push(gear);
  }
  return { text: lines.join(eol), added };
}
