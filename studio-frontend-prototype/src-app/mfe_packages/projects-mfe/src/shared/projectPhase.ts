/**
 * A project's phase (the built-in Project lifecycle kit, ADR-0068 §7) as the
 * screens draw it: the lifecycle's phases in their order, and the badge each
 * one wears, so the projects list and the project's Overview agree.
 *
 * The order is the lifecycle `project-lifecycle.kit.json` declares
 * (idea → discovery → build → run). A phase this list does not know (a later
 * lifecycle) still shows, by its own name, in a neutral badge, after these.
 */

import type { BadgeProps } from '@gears-frontx/ui-kit';

/** The lifecycle's phases, in order. */
export const PROJECT_PHASES = ['idea', 'discovery', 'build', 'run'] as const;

const VARIANTS: Readonly<Record<string, NonNullable<BadgeProps['variant']>>> = {
  idea: 'secondary',
  discovery: 'info',
  build: 'accent',
  run: 'success',
};

/** The badge a phase wears; a phase the lifecycle does not list, a neutral one. */
export function phaseVariant(phase: string): NonNullable<BadgeProps['variant']> {
  return VARIANTS[phase] ?? 'outline';
}

/** Where a phase sorts: the lifecycle's order, an unknown phase after it, no phase last. */
export function phaseRank(phase: string | null | undefined): number {
  if (!phase) return PROJECT_PHASES.length + 1;
  const at = (PROJECT_PHASES as readonly string[]).indexOf(phase);
  return at < 0 ? PROJECT_PHASES.length : at;
}

/** A phase's words: its translation where the lifecycle lists it, its own name otherwise. */
export function phaseLabel(phase: string, t: (key: string) => string): string {
  return (PROJECT_PHASES as readonly string[]).includes(phase) ? t(`phase_${phase}`) : phase;
}
