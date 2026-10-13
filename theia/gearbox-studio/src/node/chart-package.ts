// Constructor Studio: the generated Helm chart, packaged the way `helm
// package` lays it out (`<chart>/Chart.yaml`, `<chart>/templates/...` in a
// gzipped tar), for a deploy the Studio server runs (ADR-0043). Written here
// rather than by calling helm, which a member deploying to the organization's
// environments does not need to have.
//
// Regular files only: a symlink in a generated chart would be the engine's
// mistake, and following it could pack something from outside the tree.

import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";

/** What the server takes (studio-backend `environments::model::MAX_CHART_BYTES`). */
export const MAX_CHART_BYTES = 512 * 1024;

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

/** One ustar header for a regular file. */
function header(name: string, size: number, mtime: number): Buffer {
  const h = Buffer.alloc(512, 0);
  let prefix = "";
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", 155);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new Error(`a chart path is too long to pack: ${name}`);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  h.write(base, 0, 100, "utf8");
  h.write(octal(0o644, 8), 100, "ascii");
  h.write(octal(0, 8), 108, "ascii");
  h.write(octal(0, 8), 116, "ascii");
  h.write(octal(size, 12), 124, "ascii");
  h.write(octal(mtime, 12), 136, "ascii");
  h.write("        ", 148, "ascii");
  h.write("0", 156, "ascii");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  h.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(octal(sum, 7) + " ", 148, "ascii");
  return h;
}

/** Every regular file under `dir`, relative, `/`-separated, in a stable order. */
function filesUnder(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...filesUnder(dir, child));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

/**
 * The chart at `chartDir` as a `.tgz`, its files under the chart's folder
 * name. Refuses a chart without `Chart.yaml`, or one too large to send.
 */
export function packChart(chartDir: string): Buffer {
  if (!fs.existsSync(path.join(chartDir, "Chart.yaml"))) throw new Error(`${chartDir} is not a chart: no Chart.yaml`);
  const top = path.basename(chartDir);
  const parts: Buffer[] = [];
  let total = 0;
  for (const rel of filesUnder(chartDir)) {
    const full = path.join(chartDir, ...rel.split("/"));
    const body = fs.readFileSync(full);
    total += body.length;
    if (total > MAX_CHART_BYTES) throw new Error(`the chart is larger than ${MAX_CHART_BYTES} bytes`);
    parts.push(header(`${top}/${rel}`, body.length, Math.floor(fs.statSync(full).mtimeMs / 1000)));
    parts.push(body);
    const pad = (512 - (body.length % 512)) % 512;
    if (pad > 0) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  const packed = zlib.gzipSync(Buffer.concat(parts));
  if (packed.length > MAX_CHART_BYTES) throw new Error(`the packaged chart is larger than ${MAX_CHART_BYTES} bytes`);
  return packed;
}

/** The names and contents in a `.tgz` this module wrote: for tests. */
export function unpackNames(tgz: Buffer): { name: string; body: string }[] {
  const tar = zlib.gunzipSync(tgz);
  const out: { name: string; body: string }[] = [];
  for (let at = 0; at + 512 <= tar.length; ) {
    const h = tar.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const field = (from: number, len: number) => h.subarray(from, from + len).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(field(124, 12).trim(), 8);
    const prefix = field(345, 155);
    const name = (prefix ? `${prefix}/` : "") + field(0, 100);
    out.push({ name, body: tar.subarray(at + 512, at + 512 + size).toString("utf8") });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}
