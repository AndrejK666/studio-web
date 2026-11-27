/**
 * A strategy's service's run settings
 * (`GET`/`PUT /studio-product/v1/gears-matcher-settings?organization_id=&strategy=`,
 * docs/design/product-gear-match.md §10): the provider and models a match
 * runs with and its call bounds, and the form Organization › Gears matcher
 * edits them in. Keys are never settings: nothing here holds one. Pure.
 */

/** What a run uses. */
export interface MatcherSettingsValues {
  provider: string;
  /** Candidates 1, candidates 2, checks. */
  models: string[];
  max_calls: number;
  max_extract_calls: number;
}

/** What replaces the service's configuration; null uses its value. */
export interface MatcherSettingsOverrides {
  provider?: string | null;
  /** One model id for all three roles, or three. */
  models?: string[] | null;
  max_calls?: number | null;
  max_extract_calls?: number | null;
}

export interface MatcherSettings {
  strategy: string;
  /** `organization`: its own connection; `deployment`: the deployment's, shared by every organization. */
  scope: 'organization' | 'deployment';
  may_change: boolean;
  /** 0 when they were never changed. */
  version: number;
  updated_at?: string | null;
  updated_by?: string | null;
  effective: MatcherSettingsValues;
  config: MatcherSettingsValues;
  overrides: MatcherSettingsOverrides;
  /** Which providers have their key in the service's configuration; `reason` names what is missing. */
  providers: { id: string; available: boolean; reason?: string | null }[];
  ceilings: { max_calls?: number | null; max_extract_calls?: number | null };
  /** Why the stored override is set aside. */
  problem?: string | null;
}

export interface MatcherSettingsUpdate {
  version: number;
  overrides: MatcherSettingsOverrides;
}

/** The form: an empty field uses the service's configuration. */
export interface SettingsDraft {
  provider: string;
  /** One model for all three roles. */
  sameModel: boolean;
  models: [string, string, string];
  maxCalls: string;
  maxExtractCalls: string;
}

/** The model ids the service takes (its `MODEL_ID`). */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;

/** The form as the stored override fills it. */
export function draftOf(s: MatcherSettings): SettingsDraft {
  const m = s.overrides.models ?? [];
  const models: [string, string, string] =
    m.length === 1 ? [m[0], m[0], m[0]] : m.length === 3 ? [m[0], m[1], m[2]] : ['', '', ''];
  return {
    provider: s.overrides.provider ?? '',
    sameModel: m.length === 1 || (m.length === 3 && m[0] === m[1] && m[1] === m[2]),
    models,
    maxCalls: s.overrides.max_calls != null ? String(s.overrides.max_calls) : '',
    maxExtractCalls: s.overrides.max_extract_calls != null ? String(s.overrides.max_extract_calls) : '',
  };
}

/** Why the form cannot be sent, as a translation key; null when it can. */
export type DraftProblem = 'models_bad' | 'models_three' | 'max_calls_bad' | 'max_extract_calls_bad';

function bound(text: string, ceiling: number | null | undefined): number | null | 'bad' {
  const t = text.trim();
  if (!t) return null;
  if (!/^\d+$/.test(t)) return 'bad';
  const n = Number(t);
  if (n < 1 || (ceiling != null && n > ceiling)) return 'bad';
  return n;
}

/** The override the form asks for, or why it cannot be sent. */
export function overridesOf(
  d: SettingsDraft,
  ceilings: MatcherSettings['ceilings']
): { overrides: MatcherSettingsOverrides } | { problem: DraftProblem } {
  const ids = (d.sameModel ? [d.models[0]] : d.models).map((m) => m.trim());
  let models: string[] | null;
  if (ids.every((m) => !m)) models = null;
  else if (ids.some((m) => !m)) return { problem: 'models_three' };
  else if (ids.some((m) => !MODEL_ID.test(m))) return { problem: 'models_bad' };
  else models = ids;
  const maxCalls = bound(d.maxCalls, ceilings.max_calls);
  if (maxCalls === 'bad') return { problem: 'max_calls_bad' };
  const maxExtract = bound(d.maxExtractCalls, ceilings.max_extract_calls);
  if (maxExtract === 'bad') return { problem: 'max_extract_calls_bad' };
  return {
    overrides: {
      provider: d.provider || null,
      models,
      max_calls: maxCalls,
      max_extract_calls: maxExtract,
    },
  };
}
