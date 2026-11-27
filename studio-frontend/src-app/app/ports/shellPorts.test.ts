import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contributeKits, resetShellPorts, shellPort } from './shellPorts';

afterEach(resetShellPorts);

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every source file under `dir`, tests aside. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('the shell ports', () => {
  it('are absent until a kit fills them', () => {
    expect(shellPort('editor.cloneProblems')).toBeUndefined();
  });

  it("run every kit's shell.ts and keep what it filled", async () => {
    const openFile = vi.fn(async () => undefined);
    contributeKits({
      '../kits/ide/shell.ts': { default: ({ fill }: { fill: (kit: string, port: string, value: unknown) => void }) => fill('ide', 'desktop.openFile', openFile) },
      '../kits/broken/shell.ts': {},
    });
    await shellPort('desktop.openFile')?.('d1', 'README.md');
    expect(openFile).toHaveBeenCalledWith('d1', 'README.md');
  });

  it("are how the shell reaches a kit's gear: app/ names none", () => {
    const kitGears = /\/studio-(artifact-ingest|environments|components-catalog|documents|insight|theia|usage|product|reports|spec-[a-z]+|llm-proxy)\//;
    const named = sources(appRoot).filter((file) => kitGears.test(readFileSync(file, 'utf-8')));
    expect(named.map((file) => file.slice(appRoot.length + 1).replace(/\\/g, '/'))).toEqual([]);
  });
});
