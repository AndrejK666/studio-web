#!/usr/bin/env node
// Package the built electron-app as an installable desktop Studio (ADR-0027).
//
//   npm --prefix electron-app run package -- --studio-url https://studio.example.com \
//       [--issuer https://studio.example.com/auth/realms/studio] [--version 0.1.0]
//
// Run it after `theia build`. The Theia bundle in lib/ is self-contained — its
// only external is `electron` — so the app is staged without node_modules:
// the bundle, the entry point that fills in what `theia start` would get from
// a shell, and the git credential helper. The built-in plugins and the Studio
// this build signs in to ship as resources beside the app. Staging, rather
// than pointing electron-builder at this package, keeps it from walking the
// workspace's dependency tree into the installer.
//
// Native modules are whatever `theia rebuild:electron` produced; nothing is
// rebuilt here.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const require = createRequire(import.meta.url);
const app = dirname(dirname(fileURLToPath(import.meta.url)));
const { values } = parseArgs({
    options: {
        'studio-url': { type: 'string' },
        issuer: { type: 'string' },
        version: { type: 'string', default: '0.1.0' },
        out: { type: 'string', default: join(app, 'dist') },
    },
});
const studioUrl = values['studio-url']?.replace(/\/+$/, '');
if (!studioUrl) {
    console.error('--studio-url is required: the Studio this build signs in to');
    process.exit(2);
}
const issuer = values.issuer ?? `${studioUrl}/auth/realms/studio`;

for (const needed of ['lib/backend/electron-main.js', 'lib/frontend/index.html']) {
    if (!existsSync(join(app, needed))) {
        console.error(`${needed} is missing: run \`theia build\` in electron-app first`);
        process.exit(2);
    }
}

const stage = join(app, 'dist-stage');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(app, 'lib'), join(stage, 'lib'), { recursive: true, filter: source => !source.endsWith('.map') });
cpSync(join(app, 'desktop-main.js'), join(stage, 'desktop-main.js'));
// Where desktop-studio-contribution looks for it in a bundle: beside lib/.
mkdirSync(join(stage, 'scripts'));
cpSync(join(app, '..', 'studio', 'scripts', 'desktop-git-credentials.mjs'), join(stage, 'scripts', 'desktop-git-credentials.mjs'));
writeFileSync(join(stage, 'package.json'), JSON.stringify({
    name: 'constructor-studio',
    productName: 'Constructor Studio',
    version: values.version,
    description: 'Constructor Studio on your machine, signed in to your Studio',
    author: 'Constructor',
    main: 'desktop-main.js',
}, null, 2));

const resources = join(app, 'dist-resources');
rmSync(resources, { recursive: true, force: true });
mkdirSync(resources, { recursive: true });
writeFileSync(join(resources, 'studio-desktop.json'), JSON.stringify({ studioUrl, issuer }, null, 2));

const electronPackage = require.resolve('electron/package.json');
const { build } = require('electron-builder');
await build({
    projectDir: stage,
    config: {
        appId: 'tech.constructor.studio.desktop',
        productName: 'Constructor Studio',
        electronVersion: JSON.parse(readFileSync(electronPackage, 'utf8')).version,
        electronDist: join(dirname(electronPackage), 'dist'),
        directories: { output: values.out },
        // Nothing to rebuild or install: the bundle carries its native modules.
        npmRebuild: false,
        nodeGypRebuild: false,
        files: ['**/*'],
        extraResources: [
            { from: join(app, '..', 'plugins'), to: 'plugins' },
            { from: join(resources, 'studio-desktop.json'), to: 'studio-desktop.json' },
            // cfs-map-adapter requires `__dirname/../../../.cf-studio/…` at
            // runtime; from resources/app/lib/backend that is resources/. The
            // session image ships the same file for the same reason.
            { from: join(app, '..', 'docker', 'cfs-map.schema.json'), to: '.cf-studio/.core/schemas/map.schema.json' },
        ],
        // No asar: the bundle spawns executables by paths relative to its own
        // directory (rg.exe, windows-trash.exe, the node-pty agents, and the
        // credential helper git runs), and nothing can be spawned out of an
        // archive.
        asar: false,
        win: {
            target: ['nsis', 'zip'],
            artifactName: 'Constructor-Studio-${version}-${os}-${arch}.${ext}',
        },
        // A per-user install: no administrator rights, like the rest of a
        // member's tools.
        nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true },
        mac: { target: ['dmg', 'zip'], category: 'public.app-category.developer-tools' },
        linux: { target: ['AppImage', 'tar.gz'], category: 'Development' },
    },
});
console.log(`packaged into ${values.out}, signing in to ${studioUrl}`);
