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

/**
 * Written by the packaging script: the Studios this build offers and the one
 * it starts with. The member's own choice, made in the Studio view, is kept
 * elsewhere (~/ConstructorStudio/settings.json) and wins over the default.
 */
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
const { environments, defaultEnvironment } = preset();

const defaults = {
    // A list, not STUDIO_DESKTOP_URL: that one pins a single Studio and hides
    // the choice, which is for a developer's `theia start`.
    STUDIO_DESKTOP_ENVIRONMENTS: environments ? JSON.stringify(environments) : undefined,
    STUDIO_DESKTOP_DEFAULT: defaultEnvironment,
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

// The portal's "Open in desktop" link (ADR-0027 §6). Theia takes a link only
// after `--open-url`, which is how it registers the scheme itself once the app
// has run; the installer registers it before that, and hands the link over as
// a bare argument, which Theia would read as a folder to open. So a bare
// `cfstudio:` argument is moved to the end behind the flag -- in this process,
// and so also for an instance already running, which receives this process's
// argv through the single-instance lock (`singleInstance` in package.json).
const link = process.argv.findIndex(arg => /^cfstudio:/i.test(arg));
if (link >= 0 && !process.argv.includes('--open-url')) {
    const [url] = process.argv.splice(link, 1);
    process.argv.push('--open-url', url);
}

// Updates: checked on start and every few hours, offered once downloaded
// (desktop-updater.js). The same settings file as the Studio view's choice of
// Studio holds the member's choice of channel.
try {
    require('./desktop-updater.js').startUpdates({ settingsFile: path.join(home, 'settings.json') });
} catch (error) {
    // A build without the updater (a checkout, an old stage) still starts.
    console.warn(`[studio-desktop] updates are off: ${error}`);
}

require('./lib/backend/electron-main.js');
