/**
 * Every stylesheet an exposed module needs, in its `mf-manifest.json`.
 *
 * `@module-federation/vite` lists under an expose's `assets.css.sync` only the
 * CSS of the expose's own chunk. When two exposes of one MFE use the same
 * ui-kit components (a screen and an Overview slot), Vite puts those
 * components' CSS modules into a chunk both import, and that CSS is listed for
 * neither: the host mounts the second expose without its Card, Table or Select
 * styles (reports-mfe's `./metrics` rendered as bare HTML on the Overview).
 *
 * Vite's own manifest (`vite build --manifest`) knows each chunk's CSS and
 * static imports, so the CSS an expose needs is the CSS of its chunk and of
 * every chunk it imports, transitively.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/** One chunk of `.vite/manifest.json`. */
export interface ViteChunk {
  file: string;
  src?: string;
  isEntry?: boolean;
  css?: string[];
  imports?: string[];
}

export type ViteManifest = Record<string, ViteChunk>;

/** One expose of `mf-manifest.json`, the part read here. */
export interface MfExpose {
  name: string;
  path: string;
  assets: {
    js: { sync: string[]; async: string[] };
    css: { sync: string[]; async: string[] };
  };
}

export interface MfManifest {
  exposes: MfExpose[];
}

/** The CSS of the chunk written to `file` and of every chunk it statically imports. */
export function cssOfChunk(vite: ViteManifest, file: string): string[] {
  const byFile = new Map(Object.entries(vite).map(([key, chunk]) => [chunk.file, key]));
  const start = byFile.get(file);
  if (!start) return [];
  const seen = new Set<string>();
  const css: string[] = [];
  const visit = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    const chunk = vite[key];
    if (!chunk) return;
    for (const c of chunk.css ?? []) if (!css.includes(c)) css.push(c);
    for (const imported of chunk.imports ?? []) visit(imported);
  };
  visit(start);
  return css;
}

/** The federation manifest with every expose's sync CSS made complete; `changed` says whether anything was added. */
export function completeExposeCss(mf: MfManifest, vite: ViteManifest): { manifest: MfManifest; changed: boolean } {
  let changed = false;
  const exposes = mf.exposes.map((expose) => {
    const needed = expose.assets.js.sync.flatMap((js) => cssOfChunk(vite, js));
    const sync = [...expose.assets.css.sync];
    for (const c of needed) {
      if (!sync.includes(c)) {
        sync.push(c);
        changed = true;
      }
    }
    return { ...expose, assets: { ...expose.assets, css: { ...expose.assets.css, sync } } };
  });
  return { manifest: { ...mf, exposes }, changed };
}

/** Rewrite `<dist>/mf-manifest.json` from `<dist>/.vite/manifest.json`; false when either is missing. */
export function completeExposeCssIn(distDir: string): boolean {
  const mfPath = join(distDir, 'mf-manifest.json');
  const vitePath = join(distDir, '.vite', 'manifest.json');
  if (!existsSync(mfPath) || !existsSync(vitePath)) return false;
  const mf = JSON.parse(readFileSync(mfPath, 'utf-8')) as MfManifest;
  const vite = JSON.parse(readFileSync(vitePath, 'utf-8')) as ViteManifest;
  const { manifest, changed } = completeExposeCss(mf, vite);
  if (changed) writeFileSync(mfPath, JSON.stringify(manifest, null, 2));
  return true;
}
