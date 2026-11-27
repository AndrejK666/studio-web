/**
 * A project type's next steps (ADR-0073): what the type kit's manifest says
 * the person does once a project of it exists, shown on the project's
 * Overview until each is done or dismissed.
 *
 * `done_when` takes two forms. A path step (one of
 * `ProjectStatus.path[].step`): the step is done when that path step is
 * done — the Overview reads that status anyway. `field:<name>`: the step is
 * done when the project's object in the domain model (type `project`, the
 * one whose `tenant_id` is the project) has `<name>` set — a non-empty
 * string, a non-empty list, or any other value that is not null; the
 * Overview reads those fields only while such a step is pending. A step that
 * names neither is done when somebody dismisses it; a dismissal is kept in
 * `project.config` `next_steps_dismissed`, so the whole team stops seeing it.
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

/**
 * The domain-model type a `field:` step reads the project's object as: the
 * core Project type. A project of a kit's type is that kit's subtype of
 * Project (ADR-0073); once #1118 stores the object as the subtype, a query
 * for the core type matches its subtypes too, so this stays the one name.
 */
export const PROJECT_OBJECT_TYPE = 'project';

const FIELD_PREFIX = 'field:';

/** The project field a step's `done_when` names (`field:<name>`), or null when it names a path step or nothing. */
export function stepField(step: ProjectNextStep): string | null {
  const when = step.done_when?.trim();
  if (!when?.startsWith(FIELD_PREFIX)) return null;
  return when.slice(FIELD_PREFIX.length).trim() || null;
}

/** Whether a field's value counts as set: a non-empty string or list, or any other non-null value. */
export function isFieldSet(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Whether `step` is done: its path step is done, or the project field it
 * names is set in `fields` (the project object's values; `undefined` while
 * they are not read or could not be, which leaves such a step pending).
 */
export function isStepDone(
  step: ProjectNextStep,
  path: readonly ProjectPathStep[] | undefined,
  fields?: Readonly<Record<string, unknown>>
): boolean {
  if (!step.done_when) return false;
  const field = stepField(step);
  if (field !== null) return fields !== undefined && isFieldSet(fields[field]);
  if (step.done_when.startsWith(FIELD_PREFIX) || !Array.isArray(path)) return false;
  return path.some((p) => p.step === step.done_when && p.state === 'done');
}

/** The type's next steps that are neither done nor dismissed, in the type's order. */
export function pendingNextSteps(
  type: ProjectTypeKit | null,
  dismissed: readonly string[] | undefined,
  path: readonly ProjectPathStep[] | undefined,
  fields?: Readonly<Record<string, unknown>>
): ProjectNextStep[] {
  const gone = new Set(dismissed ?? []);
  return (type?.next_steps ?? []).filter((step) => !gone.has(step.id) && !isStepDone(step, path, fields));
}

/** The project fields the steps not yet dismissed are waiting on, once each, sorted: what the Overview reads. */
export function fieldsAwaited(type: ProjectTypeKit | null, dismissed: readonly string[] | undefined): string[] {
  const gone = new Set(dismissed ?? []);
  const names = new Set<string>();
  for (const step of type?.next_steps ?? []) {
    const field = gone.has(step.id) ? null : stepField(step);
    if (field) names.add(field);
  }
  return [...names].sort();
}

/** `dismissed` with `id`, once. */
export function withDismissed(dismissed: readonly string[] | undefined, id: string): string[] {
  const list = [...(dismissed ?? [])];
  return list.includes(id) ? list : [...list, id];
}
