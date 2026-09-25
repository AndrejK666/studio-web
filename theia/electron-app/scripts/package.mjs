#!/usr/bin/env node
// Package the built electron-app as an installable desktop Studio (ADR-0027).
//
//   npm --prefix electron-app run package -- [--environments environments.json] \
//       [--default dev] [--version <electron-app's own version>]
//   npm --prefix electron-app run package -- --studio-url https://studio.example.com \
//       [--issuer https://studio.example.com/auth/realms/studio]
//
// The first form ships the Studios in environments.json (dev, test, local by
// default) and lets the member switch between them in the Studio view; the
// build starts on --default. The second ships exactly one Studio.
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
/** The rolling release the desktop-windows workflow refreshes on each desktop release. */
const UPDATES_URL = 'https://github.com/constructorfabric/studio-web/releases/download/desktop-updates';
const app = dirname(dirname(fileURLToPath(import.meta.url)));
// The installer carries electron-app's own version, so it is set in one place.
const ownVersion = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')).version;
const { values } = parseArgs({
    options: {
        environments: { type: 'string', default: join(app, 'environments.json') },
        default: { type: 'string' },
        'studio-url': { type: 'string' },
        issuer: { type: 'string' },
        version: { type: 'string', default: ownVersion },
        out: { type: 'string', default: join(app, 'dist') },
    },
});
const studioUrl = values['studio-url']?.replace(/\/+$/, '');
const environments = studioUrl
    ? [{ id: 'default', label: studioUrl.replace(/^https?:\/\//, ''), studioUrl, issuer: values.issuer ?? `${studioUrl}/auth/realms/studio` }]
    : JSON.parse(readFileSync(values.environments, 'utf8'));
if (!Array.isArray(environments) || environments.length === 0
    || environments.some(e => typeof e?.id !== 'string' || !/^https?:\/\//.test(e?.studioUrl ?? ''))) {
    console.error('no usable Studio: give --studio-url, or an --environments file of { id, label, studioUrl, issuer }');
    process.exit(2);
}
const defaultEnvironment = values.default ?? environments[0].id;
if (!environments.some(e => e.id === defaultEnvironment)) {
    console.error(`--default ${defaultEnvironment} is not one of ${environments.map(e => e.id).join(', ')}`);
    process.exit(2);
}

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
// The updater and electron-updater in one file: the staged app has no
// node_modules, and electron is the only thing the runtime provides.
await require('esbuild').build({
    entryPoints: [join(app, 'desktop-updater.js')],
    outfile: join(stage, 'desktop-updater.js'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['electron'],
    logLevel: 'warning',
});
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
writeFileSync(join(resources, 'studio-desktop.json'), JSON.stringify({ environments, defaultEnvironment }, null, 2));

const electronPackage = require.resolve('electron/package.json');
const { build } = require('electron-builder');
await build({
    projectDir: stage,
    // Publishing is the workflow's, from the files this writes.
    publish: 'never',
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
        // The portal's "Open in desktop" link (ADR-0027 §6), registered at
        // install so it works before the app's first run; the app registers it
        // again itself on every start (Theia's `electron.uriScheme`).
        protocols: [{ name: 'Constructor Studio', schemes: ['cfstudio'] }],
        // Where the installed app looks for updates (desktop-updater.js): one
        // rolling release every desktop release refreshes. Written into the
        // app's app-update.yml; this script publishes nothing.
        publish: [{ provider: 'generic', url: UPDATES_URL }],
        // A stable release writes beta.yml too, so a member on betas is
        // offered a stable version that has passed their beta.
        generateUpdatesFilesForAllChannels: true,
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
console.log(`packaged into ${values.out}: ${environments.map(e => e.id).join(', ')} (starts on ${defaultEnvironment})`);
