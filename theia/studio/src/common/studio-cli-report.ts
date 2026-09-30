// How a `cfs` run is told: a line for the notification, and the full log for
// the Output channel. Pure, so the wording is tested without an IDE.

import type { StudioCliCommandId, StudioCliRun } from './studio-cli-protocol';

/** The commands as the ribbon and the palette name them. */
export const STUDIO_CLI_LABELS: Readonly<Record<StudioCliCommandId, { readonly label: string; readonly title: string; readonly icon: string }>> = {
    validate: { label: 'Validate', icon: 'pass', title: 'Check the artifacts and the code\'s traceability to them (cfs validate)' },
    doctor: { label: 'Doctor', icon: 'pulse', title: 'Check the environment Constructor Studio runs in (cfs doctor)' },
    info: { label: 'Info', icon: 'info', title: 'Show the project\'s Constructor Studio configuration (cfs info)' },
    'generate-agents': { label: 'Agent files', icon: 'hubot', title: 'Generate or update the agents\' integration files (cfs generate-agents)' },
    init: { label: 'Initialize', icon: 'rocket', title: 'Prepare this checkout for Constructor Studio, pinned to the IDE\'s engine (cfs init)' },
    version: { label: 'Version', icon: 'versions', title: 'Which Constructor Studio CLI the IDE runs (cfs --version)' },
};

export interface StudioCliSummary {
    readonly level: 'info' | 'warning' | 'error';
    readonly text: string;
}

function lastLine(text: string): string | undefined {
    return text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean).pop();
}

/**
 * One line for the notification. A command that ran and said no -- `validate`
 * finding errors -- is a warning, not an error: the tool worked, the project
 * has findings. An error is a `cfs` that could not run at all.
 */
export function summarizeCliRun(run: StudioCliRun, target: string): StudioCliSummary {
    const name = `cfs ${run.command === 'version' ? '--version' : run.command}`;
    if (run.error !== undefined || run.exitCode === null) {
        return { level: 'error', text: `${name} did not run in ${target}: ${run.error ?? 'it was stopped'}` };
    }
    if (run.exitCode !== 0) {
        const said = lastLine(run.stderr) ?? lastLine(run.stdout);
        return { level: 'warning', text: `${name} in ${target} exited with ${run.exitCode}${said ? `: ${said}` : ''}` };
    }
    if (run.command === 'version') {
        return { level: 'info', text: `${lastLine(run.stdout) ?? 'cfs'} (${run.identity})` };
    }
    return { level: 'info', text: `${name} in ${target}: done in ${(run.durationMs / 1000).toFixed(1)} s` };
}

/** The run as the Output channel shows it: what ran, where, with which cfs, then everything it said. */
export function logOfCliRun(run: StudioCliRun): string[] {
    const lines = [
        `$ ${run.commandLine}`,
        `  in ${run.cwd}`,
        `  with ${run.identity}`,
    ];
    for (const stream of [run.stdout, run.stderr]) {
        const text = stream.replace(/\s+$/u, '');
        if (text) {
            lines.push(...text.split(/\r?\n/u));
        }
    }
    lines.push(run.error !== undefined
        ? `✗ ${run.error}`
        : `→ exit ${run.exitCode ?? '—'} after ${(run.durationMs / 1000).toFixed(1)} s`, '');
    return lines;
}
