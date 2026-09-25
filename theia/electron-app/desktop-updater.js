// Updates for the PACKAGED desktop Studio (ADR-0027 phase 6).
//
// Where they come from: one rolling GitHub release, `desktop-updates`, that
// every desktop release refreshes with its installer and the channel files
// electron-builder writes -- `latest.yml` for a release, `beta.yml` for a
// pre-release and a release alike. A rolling release rather than GitHub's
// "latest": this repository also publishes the product (`v*`) and its
// infrastructure (`infra-v*`), and the newest of those is not a desktop.
// The address is the updater's `generic` feed, written by `scripts/package.mjs`
// into the app's `app-update.yml`.
//
// What a member sees: nothing, until an update has downloaded; then one
// question -- restart now, later, or read what changed. "Later" installs it
// when the app next quits. No update is ever forced.
//
// Which channel: stable, unless the member asked for betas in the Studio view,
// which writes `updates: "beta"` into ~/ConstructorStudio/settings.json. The
// file is read before every check, so the choice takes effect without a
// restart.
//
// Bundled into one file by `scripts/package.mjs` (esbuild), because the
// packaged app ships without node_modules.

const fs = require('fs');
const path = require('path');
const { app, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');

const RELEASES = 'https://github.com/constructorfabric/studio-web/releases/tag';
const FIRST_CHECK_MS = 10_000;
const EVERY_MS = 6 * 60 * 60 * 1000;

/** `beta` when the member asked for pre-releases, `latest` otherwise. */
function channelFrom(settingsFile) {
    try {
        const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        return settings.updates === 'beta' ? 'beta' : 'latest';
    } catch {
        return 'latest';
    }
}

/**
 * Start checking for updates. Only in an installed app: a checkout's
 * `theia start` and an unpacked zip have nothing to update in place.
 */
function startUpdates({ settingsFile, log = console }) {
    if (!app.isPackaged || process.env.STUDIO_DESKTOP_NO_UPDATES === '1') {
        return;
    }
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    // A beta member moving back to stable keeps what they have until stable
    // passes it, rather than being walked back to an older version.
    autoUpdater.allowDowngrade = false;
    autoUpdater.logger = {
        info: m => log.info(`[studio-desktop] update: ${m}`),
        warn: m => log.warn(`[studio-desktop] update: ${m}`),
        error: m => log.error(`[studio-desktop] update: ${m}`),
        debug: () => undefined,
    };

    let asked = false;
    autoUpdater.on('update-downloaded', async info => {
        if (asked) {
            return;
        }
        asked = true;
        const { response } = await dialog.showMessageBox({
            type: 'info',
            title: 'Constructor Studio update',
            message: `Constructor Studio ${info.version} is available`,
            detail: `You have ${app.getVersion()}. It is downloaded and installs when you restart, `
                + 'or the next time you quit the app.',
            buttons: ['Restart and update', 'Later', 'What\'s new'],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
        });
        if (response === 0) {
            autoUpdater.quitAndInstall();
        } else if (response === 2) {
            void shell.openExternal(`${RELEASES}/desktop-v${info.version}`);
        }
    });
    autoUpdater.on('error', error => {
        // Offline, rate-limited, or a release in the middle of being uploaded:
        // the next check tries again, and the member is not told about any of it.
        log.warn(`[studio-desktop] update check failed: ${error instanceof Error ? error.message : error}`);
    });

    const check = () => {
        const channel = channelFrom(settingsFile);
        autoUpdater.channel = channel;
        autoUpdater.allowPrerelease = channel === 'beta';
        autoUpdater.checkForUpdates().catch(() => undefined);
    };
    app.whenReady().then(() => {
        setTimeout(check, FIRST_CHECK_MS);
        setInterval(check, EVERY_MS).unref?.();
    });
}

module.exports = { startUpdates, channelFrom };
