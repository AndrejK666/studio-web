#!/usr/bin/env node
// The assistants' manifest for a desktop installer (#480).
//
//   node electron-app/scripts/assistants-manifest.mjs --dockerfile Dockerfile \
//       [--target win32-x64] --out assistants.json
//
// Claude Code and Codex are not in the installer. The app fetches them on
// first need (studio/src/node/desktop-assistants.ts), and trusts only what
// this manifest says: `{ id, label, version, target, url, sha256 }` each.
//
// The pins are theia/Dockerfile's `fetch_vsix` lines, the one pin the browser
// session uses too. A pinned version with no build for the target takes the
// newest build there is instead, and says so (a GitHub Actions warning). The
// digest is open-vsx's (`files.sha256`), checked here against a download of
// the VSIX, so a manifest never names a file its build did not see.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const OPEN_VSX = 'https://open-vsx.org/api';

/** `fetch_vsix <namespace> <name> <version> <dir>` lines, as the Dockerfile writes them. */
export function parseFetchVsixPins(dockerfile) {
    const pins = [];
    for (const raw of dockerfile.replace(/\r/g, '').split('\n')) {
        const match = /^\s*fetch_vsix\s+([^\s;\\]+)\s+([^\s;\\]+)\s+([^\s;\\]+)\s+([^\s;\\]+)/.exec(raw);
        if (match) {
            const [, namespace, name, version, dir] = match;
            pins.push({ namespace, name, version, dir });
        }
    }
    return pins;
}

/** open-vsx's metadata of one version for one target, or of the newest when `version` is absent. */
export function metadataUrl(namespace, name, target, version) {
    return [OPEN_VSX, ...[namespace, name, target, version].filter(Boolean).map(encodeURIComponent)].join('/');
}

/** The name a member reads: open-vsx's display name without its tagline. */
export function shortLabel(displayName, fallback) {
    const name = String(displayName ?? '').split(/\s[–—-]\s/)[0].replace(/\s+for\s+VS\s?Code$/i, '').trim();
    return name || fallback;
}

/** One manifest entry from open-vsx's metadata, checked. */
export function manifestEntry(meta, target, digest) {
    const id = `${meta.namespace}.${meta.name}`.toLowerCase();
    const url = meta.files?.download;
    if (!url || !/^https:\/\//.test(url)) {
        throw new Error(`${id} ${meta.version}: open-vsx lists no download`);
    }
    if (!/^[0-9a-f]{64}$/.test(digest)) {
        throw new Error(`${id} ${meta.version}: no usable SHA-256 (${digest})`);
    }
    return { id, label: shortLabel(meta.displayName, id), version: meta.version, target, url, sha256: digest };
}

/** The hex digest out of a `.sha256` file (`<hex>` or `<hex>  <file>`). */
export function parseDigest(text) {
    return String(text).trim().split(/\s+/)[0].toLowerCase();
}

async function getJson(url) {
    const response = await fetch(url);
    if (!response.ok) {
        const error = new Error(`${url} answered ${response.status}`);
        error.status = response.status;
        throw error;
    }
    return response.json();
}

async function resolve(pin, target) {
    const { namespace, name, version } = pin;
    try {
        return await getJson(metadataUrl(namespace, name, target, version));
    } catch (error) {
        if (error.status !== 404 && error.status !== 400) {
            throw error;
        }
        const latest = await getJson(metadataUrl(namespace, name, target));
        console.log(`::warning::${namespace}.${name} ${version} has no ${target} build; the manifest pins ${latest.version}, the newest that has one`);
        return latest;
    }
}

async function main() {
    const { values } = parseArgs({
        options: {
            dockerfile: { type: 'string' },
            target: { type: 'string', default: 'win32-x64' },
            out: { type: 'string' },
        },
    });
    if (!values.dockerfile || !values.out) {
        console.error('usage: assistants-manifest.mjs --dockerfile <theia/Dockerfile> [--target win32-x64] --out <assistants.json>');
        process.exit(2);
    }
    const pins = parseFetchVsixPins(readFileSync(values.dockerfile, 'utf8'));
    if (pins.length === 0) {
        console.error(`::error::${values.dockerfile} no longer names the assistant extensions the way this script reads them (fetch_vsix)`);
        process.exit(1);
    }
    const assistants = [];
    for (const pin of pins) {
        const meta = await resolve(pin, values.target);
        if (!meta.files?.sha256) {
            throw new Error(`${pin.namespace}.${pin.name} ${meta.version}: open-vsx lists no sha256`);
        }
        const published = parseDigest(await (await fetch(meta.files.sha256)).text());
        const response = await fetch(meta.files.download);
        if (!response.ok) {
            throw new Error(`${meta.files.download} answered ${response.status}`);
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        const seen = createHash('sha256').update(bytes).digest('hex');
        if (seen !== published) {
            throw new Error(`${pin.namespace}.${pin.name} ${meta.version}: the download's SHA-256 ${seen} is not open-vsx's ${published}`);
        }
        const entry = manifestEntry(meta, values.target, seen);
        console.log(`${entry.id} ${entry.version} (${values.target}): ${(bytes.length / 1048576).toFixed(0)} MB, sha256 ${seen}`);
        assistants.push(entry);
    }
    writeFileSync(values.out, `${JSON.stringify({ assistants }, null, 2)}\n`);
    console.log(`wrote ${values.out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
    main().catch(error => {
        console.error(`::error::${error.message}`);
        process.exit(1);
    });
}
