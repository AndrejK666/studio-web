/**
 * The screen's translator and the few helpers every part of it shares: an
 * enum value's label (translated when the screen knows the value, else the
 * value itself, readable), and dates in the screen's language.
 */

import type { ScreenText } from '@constructor-studio/mfe-shared';

export type Text = ScreenText;

/** The enum values the dictionaries name, by scale; a value outside them is shown as itself. */
const KNOWN: Record<string, readonly string[]> = {
  phase: ['screening', 'confirmatory_dd', 'signing', 'integration'],
  recommendation: ['proceed', 'proceed_with_conditions', 'stop'],
  severity: ['critical', 'high', 'medium', 'low', 'info'],
  level: ['low', 'medium', 'high', 'critical'],
  finding_status: ['open', 'accepted', 'resolved'],
  risk_status: ['open', 'mitigating', 'accepted', 'closed'],
  question_status: ['open', 'answered', 'closed'],
};

/** `scale_value` translated when the screen knows it, else the value with spaces for underscores. */
export function enumLabel(t: Text, scale: string, value: string | null | undefined): string {
  if (!value) return '—';
  return KNOWN[scale]?.includes(value) ? t(`${scale}_${value}`) : value.replace(/_/g, ' ');
}

/** `YYYY-MM-DD` as a date in `language`, read as a calendar day (no time zone shift). */
export function dayLabel(day: string | null | undefined, language: string): string {
  if (!day) return '—';
  const at = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(at)) return day;
  return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeZone: 'UTC' }).format(at);
}

/** An RFC 3339 time as a date and time in `language`. */
export function timeLabel(iso: string | null | undefined, language: string): string {
  const at = Date.parse(iso ?? '');
  if (Number.isNaN(at)) return '—';
  return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
}
