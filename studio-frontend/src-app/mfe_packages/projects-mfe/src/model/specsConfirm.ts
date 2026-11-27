/**
 * The Specs list's bulk *Confirm*: which rows have a proposed type to confirm,
 * what the dialog says about them, and what the toast says afterwards.
 */

import type { Refusal } from '@constructor-studio/mfe-shared';
import type { ConfirmTypesResultDto } from '../api/documentTypes';
import type { SpecRow } from './specRows';

/** A row whose type a classifier proposed and a person may confirm. */
export interface ConfirmTarget {
  id: string;
  /** The document's name, for the toast if it is not confirmed. */
  name: string;
  /** The proposed type's name, for the dialog's summary. */
  typeName: string;
}

/** Every row of the project with a proposed type a person may confirm, filters or not. */
export function proposedTargets(rows: readonly SpecRow[]): ConfirmTarget[] {
  return rows.flatMap((row) =>
    row.typeEditable && row.type?.proposed
      ? [{ id: row.id, name: row.name, typeName: row.type.name }]
      : []
  );
}

/** The selected rows that have a proposed type, and how many selected rows have none. */
export function selectedTargets(
  selected: readonly string[],
  proposed: readonly ConfirmTarget[]
): { targets: ConfirmTarget[]; skipped: number } {
  const ticked = new Set(selected);
  const targets = proposed.filter((target) => ticked.has(target.id));
  return { targets, skipped: ticked.size - targets.length };
}

/** How many of each type, most first, then by name: `2 × Design Document`. */
export function typeSummary(
  targets: readonly ConfirmTarget[]
): { typeName: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const target of targets) {
    counts.set(target.typeName, (counts.get(target.typeName) ?? 0) + 1);
  }
  return [...counts]
    .map(([typeName, count]) => ({ typeName, count }))
    .sort((a, b) => b.count - a.count || a.typeName.localeCompare(b.typeName));
}

/** A target the server did not confirm, and why (`ConfirmTypesSkippedDto.reason`). */
export interface ConfirmFailure {
  name: string;
  reason: string;
}

/** What the toast says after a bulk confirmation. */
export type ConfirmOutcome =
  | { kind: 'confirmed'; confirmed: number; failed: ConfirmFailure[] }
  /** The call as a whole was refused: nothing was confirmed. */
  | { kind: 'refused'; refusal: Refusal };

/** The server's answer, by the names of the targets it was asked about. */
export function confirmOutcome(
  targets: readonly ConfirmTarget[],
  result: ConfirmTypesResultDto
): ConfirmOutcome {
  const names = new Map(targets.map((target) => [target.id, target.name]));
  return {
    kind: 'confirmed',
    confirmed: result.confirmed.length,
    failed: result.skipped.map((skip) => ({
      name: names.get(skip.id) ?? skip.id,
      reason: skip.reason,
    })),
  };
}
