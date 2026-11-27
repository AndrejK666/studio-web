/**
 * A call into another kit's gear that failed because that kit is not here: a
 * state the screen shows, not an error it prints (ADR-0079 §5).
 *
 * Three answers mean it:
 *
 * - **`KIT_NOT_INSTALLED`** — the gear runs, but the kit does not apply where
 *   the call acts (studio-backend `kit_registry/gate.rs`: a 400
 *   `failed_precondition` whose violation has `type: KIT_NOT_INSTALLED` and
 *   the kit's slug as `subject`; an MCP tool's text `KIT_NOT_INSTALLED (kit
 *   <slug>)`). Always read, whoever asked.
 * - **404 on the gear's route** — the gear is not in this deployment, so the
 *   gateway has no such route.
 * - **503 from the gear** — the gear is switched off, or a gear beside Studio
 *   left the directory (ADR-0077).
 *
 * A 404 or a 503 is ambiguous on its own (a missing row; a provider that is
 * down), so those two count only when the caller names the kit whose gear it
 * called (`{ kit }`): the caller then says this read is a route of that kit,
 * one that never answers 404 for a row. Anything else stays an error.
 */

import { parseProblemDetails } from './problemDetails';
import { responseStatus } from './notFound';

export const KIT_NOT_INSTALLED = 'KIT_NOT_INSTALLED';

export interface KitAbsence {
  /** The kit's slug, when the refusal or the caller names it. */
  kit: string | null;
  /** `not_installed`: the kit does not apply here; `gear_absent`: its gear does not answer (404/503). */
  reason: 'not_installed' | 'gear_absent';
  /** The gear's own sentence (which kit, and where it is installed), when it sent one. */
  detail: string | null;
}

const KIT_IN_TEXT = new RegExp(`${KIT_NOT_INSTALLED}\\s*\\(kit\\s+([a-z0-9][a-z0-9-]*)\\)`);

function messageOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (typeof error !== 'object' || error === null) return '';
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : '';
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);

/**
 * Why the kit this call belongs to is absent, or `null` when the failure is
 * anything else. `kit` is the slug of the kit whose gear was called: name it
 * to have a 404 or a 503 of that gear count.
 */
export function kitAbsent(error: unknown, options: { kit?: string } = {}): KitAbsence | null {
  const named = options.kit ?? null;
  const refusal = parseProblemDetails(error).violations.find((v) => v.type === KIT_NOT_INSTALLED);
  if (refusal) {
    return { kit: text(refusal.subject) ?? named, reason: 'not_installed', detail: text(refusal.description) };
  }
  const said = messageOf(error);
  if (said.includes(KIT_NOT_INSTALLED)) {
    return { kit: KIT_IN_TEXT.exec(said)?.[1] ?? named, reason: 'not_installed', detail: null };
  }
  if (!named) return null;
  const status = responseStatus(error);
  if (status === 404 || status === 503) return { kit: named, reason: 'gear_absent', detail: null };
  return null;
}
