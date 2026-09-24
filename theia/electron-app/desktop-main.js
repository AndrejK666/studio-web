// Entry point of the PACKAGED desktop Studio (ADR-0027). `scripts/package.mjs`
// makes it the app's `main`; `theia start` in a checkout never loads it.
//
// A developer's `theia start` gets its settings from the command line and the
// shell: which Studio to sign in to, where the plugins are, where to keep the
// workspace. An installed app has neither, so this fills them in before
// Theia's own electron main starts the backend, which inherits the
// environment. Anything already set in the environment wins, so one build can
// still be pointed at another Studio for a test.

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Written by the packaging script: which Studio this build signs in to. */
function preset() {
    try {
        return JSON.parse(fs.readFileSync(path.join(process.resourcesPath, 'studio-desktop.json'), 'utf8'));
    } catch {
        return {};
    }
}

const home = path.join(os.homedir(), 'ConstructorStudio');
const workspace = path.join(home, 'workspace');
const data = path.join(home, 'data');
const { studioUrl, issuer } = preset();

const defaults = {
    STUDIO_DESKTOP_URL: studioUrl,
    STUDIO_DESKTOP_ISSUER: issuer,
    // The runtime config of the studio extension requires these. On a desktop
    // the actor is the signed-in member, whom the sign-in names later; these
    // only let the IDE start.
    STUDIO_ACTOR_ID: 'desktop',
    STUDIO_WORKSPACE_ID: 'desktop',
    STUDIO_WORKSPACE_ROOT: workspace,
    STUDIO_REPOSITORY_ROOT: workspace,
    STUDIO_DATA_DIR: data,
    // The built-in VS Code plugins ship as a resource beside the app.
    THEIA_DEFAULT_PLUGINS: `local-dir:${path.join(process.resourcesPath, 'plugins')}`,
};
for (const [name, value] of Object.entries(defaults)) {
    if (value && !process.env[name]) {
        process.env[name] = value;
    }
}
for (const dir of [workspace, data]) {
    fs.mkdirSync(dir, { recursive: true });
}

require('./lib/backend/electron-main.js');
