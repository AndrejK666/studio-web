/**
 * A project's file, opened on the member's own desktop when the project is
 * open there (ADR-0027 §5): the command goes out on studio-events and the
 * desktop opens the file. The device it went to, or `undefined` when there is
 * none (or this Studio has no desktop sessions, or no kit fills
 * `desktop.openFile`) and the caller opens it another way.
 */

import { apiRegistry } from '@gears-frontx/react';
import { DesktopApiService } from '@/app/api/DesktopApiService';
import { shellPort } from '@/app/ports/shellPorts';
import { myDesktop } from './desktopLink';

export async function openOnMyDesktop(
  projectId: string,
  path: string,
  me: string | undefined
): Promise<string | undefined> {
  const openFile = shellPort('desktop.openFile');
  if (!me || !openFile || !apiRegistry.has(DesktopApiService)) return undefined;
  const desktops = apiRegistry.getService(DesktopApiService);
  let desktop;
  try {
    desktop = myDesktop((await desktops.sessions({ projectId }).fetch({ staleTime: 0 }))?.items ?? [], me);
  } catch {
    return undefined;
  }
  if (!desktop) return undefined;
  try {
    await openFile(desktop.id, path);
  } catch {
    return undefined;
  }
  return desktop.device_name?.trim() || 'your desktop';
}
