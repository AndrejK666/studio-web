/**
 * A project type's next steps (ADR-0073): what the type kit's manifest says
 * the person does once a project of it exists, shown on the project's
 * Overview until each is done or dismissed.
 *
 * A step is done when the project path step it names (`done_when`, one of
 * `ProjectStatus.path[].step`) is done: the Overview reads that status
 * anyway, so nothing more is asked. A step that names none is done when
 * somebody dismisses it; a dismissal is kept in `project.config`
 * `next_steps_dismissed`, so the whole team stops seeing it.
 */

import type { ProjectNextStep, ProjectTypeKit } from '../api/ProjectStatusApiService';
import type { ProjectPathStep } from './projectStatus';

/** The type a project is, by the kit its configuration names; none for a project created before types. */
export function typeOf(
  types: readonly ProjectTypeKit[] | undefined,
  kit: string | undefined
): ProjectTypeKit | null {
  if (!kit || !Array.isArray(types)) return null;
  return types.find((type) => type.slug === kit) ?? null;
}

/** Whether the path says `step` is done. */
export function isStepDone(step: ProjectNextStep, path: readonly ProjectPathStep[] | undefined): boolean {
  if (!step.done_when || !Array.isArray(path)) return false;
  return path.some((p) => p.step === step.done_when && p.state === 'done');
}

/** The type's next steps that are neither done nor dismissed, in the type's order. */
export function pendingNextSteps(
  type: ProjectTypeKit | null,
  dismissed: readonly string[] | undefined,
  path: readonly ProjectPathStep[] | undefined
): ProjectNextStep[] {
  const gone = new Set(dismissed ?? []);
  return (type?.next_steps ?? []).filter((step) => !gone.has(step.id) && !isStepDone(step, path));
}

/** `dismissed` with `id`, once. */
export function withDismissed(dismissed: readonly string[] | undefined, id: string): string[] {
  const list = [...(dismissed ?? [])];
  return list.includes(id) ? list : [...list, id];
}
