/**
 * This file can be edited to adjust the ESBuild build process.
 * To reset, delete this file and rerun theia build again.
 *
 * The desktop's copy of browser-app/esbuild.mjs's first two corrections, and
 * only those: mermaid and KaTeX as their own scripts. mermaid-view.js and
 * katex-runtime.js load `mermaid.js` / `katex.js` with a script tag on first
 * use (see browser-app/esbuild.mjs for why they are not in bundle.js). Without
 * this file `theia build` writes its default, which builds neither, and every
 * diagram and equation on the desktop failed with "could not load mermaid.js".
 *
 * The other corrections there (`.wasm` as a file, no secondary-window app) are
 * about a session image's size and are left out here. `.gitignore` ignores
 * `*-app/*`, so this file is exempted there explicitly.
 */
import { browserOptions, watch, minify, sourcemap } from './gen-esbuild.browser.mjs';
import { nodeOptions } from './gen-esbuild.node.mjs';
import { electronOptions } from './gen-esbuild.electron.mjs';
import esbuild from 'esbuild';

const mermaidOptions = {
    entryPoints: { mermaid: '../mermaid-entry.mjs' },
    bundle: true,
    format: 'iife',
    globalName: 'studioMermaid',
    outdir: 'lib/frontend',
    platform: 'browser',
    mainFields: ['browser', 'module', 'main'],
    loader: browserOptions.loader,
    minify,
    sourcemap
};

const katexOptions = {
    entryPoints: { katex: '../katex-entry.mjs' },
    bundle: true,
    format: 'iife',
    globalName: 'studioKatex',
    outdir: 'lib/frontend',
    assetNames: '[name]',
    platform: 'browser',
    mainFields: ['browser', 'module', 'main'],
    loader: { ...browserOptions.loader, '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
    minify,
    sourcemap
};

const browserContext = await esbuild.context(browserOptions);
const nodeContext = await esbuild.context(nodeOptions);
const electronContext = await esbuild.context(electronOptions);
const mermaidContext = await esbuild.context(mermaidOptions);
const katexContext = await esbuild.context(katexOptions);

if (watch) {
    await Promise.all([
        browserContext.watch(),
        nodeContext.watch(),
        electronContext.watch(),
        mermaidContext.watch(),
        katexContext.watch(),
    ]);
} else {
    try {
        await browserContext.rebuild();
        await browserContext.dispose();
        await nodeContext.rebuild();
        await nodeContext.dispose();
        await electronContext.rebuild();
        await electronContext.dispose();
        await mermaidContext.rebuild();
        await mermaidContext.dispose();
        await katexContext.rebuild();
        await katexContext.dispose();
    } catch {
        process.exit(1);
    }
}
