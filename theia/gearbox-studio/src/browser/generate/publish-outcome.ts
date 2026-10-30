// Constructor Studio: how a Publish in the Deploy terminal ended, read off the
// terminal's output -- so a build is recorded as published only when its
// pushes went through.

import type { TerminalWidget } from "@theia/terminal/lib/browser/base/terminal-widget";

/** How long Publish waits for its pushes before it stops waiting (and records nothing). */
export const PUBLISH_WAIT_MS = 30 * 60_000;

/**
 * How a Publish ended, read off its terminal: the line `<marker>-ok` or
 * `<marker>-failed` on its own (the typed command echoes the marker inside a
 * longer line, so only a whole line counts), with the first line that names an
 * error or a refusal as why: the push that failed, not what followed it.
 */
export function publishOutcome(
  terminal: Pick<TerminalWidget, "onOutput" | "onTerminalDidClose">,
  marker: string,
  waitMs: number,
): Promise<{ readonly ok: boolean; readonly why?: string }> {
  return new Promise((resolve) => {
    let buffer = "";
    let why: string | undefined;
    const subscriptions: { dispose(): void }[] = [];
    const done = (ok: boolean, reason?: string): void => {
      subscriptions.forEach((d) => d.dispose());
      clearTimeout(timer);
      resolve({ ok, ...(ok ? {} : { why: reason ?? why }) });
    };
    const timer = setTimeout(() => done(false, "it did not finish in time"), waitMs);
    subscriptions.push(
      terminal.onOutput((chunk: string) => {
        buffer += chunk.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.trim();
          if (line === `${marker}-ok`) return done(true);
          if (line === `${marker}-failed`) return done(false);
          if (/\b(error|denied|unauthorized|forbidden)\b/i.test(line) && !line.includes(marker)) why ??= line.slice(0, 240);
        }
      }),
      terminal.onTerminalDidClose(() => done(false, "the terminal was closed")),
    );
  });
}
