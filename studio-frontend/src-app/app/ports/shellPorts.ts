/**
 * The shell's ports (ADR-0079 §4, the portal's side): what a kit hands the
 * shell, read where the shell needs it. The shell declares the port and never
 * names who fills it; a kit fills it from `src-app/kits/<kit>/shell.ts`, which
 * `main.tsx` collects by pattern, so adding a kit changes no shell file.
 *
 * A port nobody filled is absent, and the shell works without it: no kit is
 * needed for an empty Studio (ADR-0079 §1). A filled port may still find its
 * kit's gear absent (404/503, `KIT_NOT_INSTALLED`): it answers as it would for
 * nothing to say, never with an error the shell shows.
 */

import type { EditorConnect } from '@/app/ports/editorPort';
import type { EditorCloneProblem } from '@/app/slices/editorSessionSlice';

export interface ShellPorts {
  /**
   * Why a project's sources could not be cloned, for the editor's status: the
   * failed ones only, [] when none failed or nothing is known.
   */
  'editor.cloneProblems': (projectId: string) => Promise<EditorCloneProblem[]>;
  /**
   * Hand a project file to the IDE of a desktop the member holds open
   * (ADR-0027 §5); rejects when the desktop could not be told.
   */
  'desktop.openFile': (desktopSessionId: string, relativePath: string) => Promise<void>;
  /**
   * Talk to the editor's frame (ADR-0080 §4): the kit that brings the IDE
   * knows its messages; the shell only asks it to open `{ kind, ref }`.
   */
  'editor.connect': EditorConnect;
}

export type ShellPortName = keyof ShellPorts;

/** What a kit's `shell.ts` is handed: register its API services, then fill ports. */
export interface KitShellContext {
  /** Fill `port` for the kit `kit`; one kit per port, the last one wins and says so. */
  fill<K extends ShellPortName>(kit: string, port: K, value: ShellPorts[K]): void;
}

/** A kit's `shell.ts`: its default export, run once before the API registry initializes. */
export type KitShell = (context: KitShellContext) => void;

const filled = new Map<ShellPortName, { kit: string; value: unknown }>();

export const shellPortsContext: KitShellContext = {
  fill(kit, port, value) {
    const before = filled.get(port);
    if (before && before.kit !== kit) {
      console.warn(`[shell-ports] ${port}: ${kit} replaces ${before.kit}`);
    }
    filled.set(port, { kit, value });
  },
};

/** The port as a kit filled it, or `undefined` where no kit did. */
export function shellPort<K extends ShellPortName>(port: K): ShellPorts[K] | undefined {
  return filled.get(port)?.value as ShellPorts[K] | undefined;
}

/** Run every kit's `shell.ts` (`import.meta.glob` of `src-app/kits/*\/shell.ts`). */
export function contributeKits(modules: Record<string, { default?: unknown }>): void {
  for (const [path, module] of Object.entries(modules)) {
    if (typeof module.default !== 'function') {
      console.warn(`[shell-ports] ${path} has no default export to run`);
      continue;
    }
    (module.default as KitShell)(shellPortsContext);
  }
}

/** Empty every port: for tests. */
export function resetShellPorts(): void {
  filled.clear();
}
