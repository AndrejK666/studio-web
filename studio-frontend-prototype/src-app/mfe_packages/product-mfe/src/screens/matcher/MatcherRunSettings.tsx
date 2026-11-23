/**
 * A strategy's service's run settings, inside its service card on
 * Organization › Gears matcher (docs/design/product-gear-match.md §10): the
 * provider, the three models and the call bounds a match runs with. The
 * service's configuration sets them; an override replaces some of them until
 * it is cleared. Editable where the server says `may_change`: the
 * organization's own service by its administrator, the deployment's shared one
 * by a platform administrator. Keys are never settings and never here.
 */

import { useEffect, useState } from 'react';
import { Button, Checkbox, Input, NativeSelect, NativeSelectOption } from '@gears-frontx/ui-kit';
import { responseStatus } from '@constructor-studio/mfe-shared';
import { productApi } from '../../api/client';
import { draftOf, overridesOf, type MatcherSettings, type SettingsDraft } from '../../model/matcher-settings';
import { errText } from '../common';
import page from '../product.module.css';
import styles from './matcher.module.css';

type T = (key: string, params?: Record<string, string>) => string;

const ROLES = ['run_model_1', 'run_model_2', 'run_model_3'] as const;

/** A field that may be left to the configuration: its hint and its reset. */
function FromConfig({ value, onReset, t, show }: { value: string; onReset: () => void; t: T; show: boolean }) {
  return (
    <span className={`${page.small} ${page.muted}`}>
      {t('run_config_hint', { value })}
      {show && (
        <>
          {' · '}
          <button type="button" className={page.link} onClick={onReset} data-matcher-settings-reset>
            {t('run_use_config')}
          </button>
        </>
      )}
    </span>
  );
}

export function MatcherRunSettings({
  orgId,
  strategy,
  t,
  language,
  onSaved,
}: {
  orgId: string;
  strategy: string;
  t: T;
  language: string;
  /** After a change: the card reads the service's live check again. */
  onSaved: () => void;
}) {
  const [s, setS] = useState<MatcherSettings | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [readErr, setReadErr] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [note, setNote] = useState<'saved' | 'conflict' | null>(null);
  const [busy, setBusy] = useState(false);
  /** Bumped to read them again (after a conflict). */
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    productApi.matcherSettings(orgId, strategy).then(
      (r) => {
        if (!live) return;
        setS(r);
        setDraft(draftOf(r));
        setReadErr(null);
      },
      (e: unknown) => live && setReadErr(errText(e))
    );
    return () => {
      live = false;
    };
  }, [orgId, strategy, round]);

  if (readErr && !s) {
    return (
      <span className={`${page.small} ${page.muted}`} data-matcher-settings-error>
        {t('run_error', { error: readErr })}
      </span>
    );
  }
  if (!s || !draft) return null;

  const edit = (patch: Partial<SettingsDraft>) => {
    setDraft({ ...draft, ...patch });
    setNote(null);
    setSaveErr(null);
  };
  const save = async () => {
    const asked = overridesOf(draft, s.ceilings);
    if ('problem' in asked) {
      setSaveErr(t(`run_${asked.problem}`));
      return;
    }
    setBusy(true);
    setSaveErr(null);
    setNote(null);
    try {
      const r = await productApi.putMatcherSettings(orgId, strategy, { version: s.version, overrides: asked.overrides });
      setS(r);
      setDraft(draftOf(r));
      setNote('saved');
      onSaved();
    } catch (e) {
      if (responseStatus(e) === 409) {
        setNote('conflict');
        setRound((n) => n + 1);
      } else {
        setSaveErr(errText(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const eff = s.effective;
  const cfg = s.config;
  const effective = t('run_effective', {
    provider: eff.provider,
    models: eff.models.join(', '),
    calls: String(eff.max_calls),
    extract: String(eff.max_extract_calls),
  });
  const changed = s.updated_at
    ? t('run_updated', {
        time: new Date(s.updated_at).toLocaleString(language),
        who: s.updated_by ?? '—',
      })
    : t('run_never_changed');
  const disabled = busy || !s.may_change;

  return (
    <div className={page.stack} data-matcher-settings={s.scope} data-matcher-settings-may-change={String(s.may_change)}>
      <b>{t('run_title')}</b>
      <span className={`${page.small} ${page.muted}`}>{t(`run_scope_${s.scope}`)}</span>
      <span className={page.small} data-matcher-settings-effective>
        {effective}
      </span>
      <span className={`${page.small} ${page.muted}`}>{changed}</span>
      {s.problem && (
        <span className={`${page.small} ${page.error}`} data-matcher-settings-problem>
          {t('run_problem', { problem: s.problem })}
        </span>
      )}
      {s.may_change && (
        <div className={styles.settings}>
          <label className={styles.field}>
            <span>{t('run_provider')}</span>
            <NativeSelect
              value={draft.provider}
              disabled={disabled}
              onChange={(e) => edit({ provider: e.target.value })}
              data-matcher-settings-provider
            >
              <NativeSelectOption value="">{t('run_provider_config', { value: cfg.provider })}</NativeSelectOption>
              {s.providers.map((p) => (
                <NativeSelectOption key={p.id} value={p.id} disabled={!p.available} title={p.reason ?? undefined}>
                  {p.available ? p.id : t('run_provider_unavailable', { id: p.id, reason: p.reason ?? '' })}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <div className={styles.field}>
            <span>{t('run_models')}</span>
            <label className={page.row}>
              <Checkbox
                checked={draft.sameModel}
                disabled={disabled}
                onCheckedChange={(v) => edit({ sameModel: v === true })}
                data-matcher-settings-same-model
              />
              {t('run_same_model')}
            </label>
            <span className={styles.models}>
              {(draft.sameModel ? ['run_model_all'] : ROLES).map((role, i) => (
                <Input
                  key={role}
                  aria-label={t(role)}
                  placeholder={draft.sameModel ? cfg.models[0] : cfg.models[i]}
                  value={draft.models[i]}
                  disabled={disabled}
                  onChange={(e) => {
                    const models = [...draft.models] as SettingsDraft['models'];
                    models[i] = e.target.value;
                    edit({ models });
                  }}
                  data-matcher-settings-model={i}
                />
              ))}
            </span>
            <FromConfig
              value={cfg.models.join(', ')}
              show={draft.models.some((m) => m.trim())}
              onReset={() => edit({ models: ['', '', ''] })}
              t={t}
            />
          </div>
          <label className={styles.field}>
            <span>{t('run_max_calls', { ceiling: String(s.ceilings.max_calls ?? '') })}</span>
            <Input
              type="number"
              min={1}
              max={s.ceilings.max_calls ?? undefined}
              placeholder={String(cfg.max_calls)}
              value={draft.maxCalls}
              disabled={disabled}
              onChange={(e) => edit({ maxCalls: e.target.value })}
              data-matcher-settings-max-calls
            />
            <FromConfig
              value={String(cfg.max_calls)}
              show={!!draft.maxCalls.trim()}
              onReset={() => edit({ maxCalls: '' })}
              t={t}
            />
          </label>
          <label className={styles.field}>
            <span>{t('run_max_extract_calls', { ceiling: String(s.ceilings.max_extract_calls ?? '') })}</span>
            <Input
              type="number"
              min={1}
              max={s.ceilings.max_extract_calls ?? undefined}
              placeholder={String(cfg.max_extract_calls)}
              value={draft.maxExtractCalls}
              disabled={disabled}
              onChange={(e) => edit({ maxExtractCalls: e.target.value })}
              data-matcher-settings-max-extract-calls
            />
            <FromConfig
              value={String(cfg.max_extract_calls)}
              show={!!draft.maxExtractCalls.trim()}
              onReset={() => edit({ maxExtractCalls: '' })}
              t={t}
            />
          </label>
          <span className={page.row}>
            <Button type="button" size="sm" disabled={disabled} onClick={() => void save()} data-matcher-settings-save>
              {busy ? t('saving') : t('run_save')}
            </Button>
            {note === 'saved' && <span className={`${page.small} ${page.muted}`}>{t('run_saved')}</span>}
          </span>
          <span className={`${page.small} ${page.muted}`}>{t('run_keys_note')}</span>
        </div>
      )}
      {note === 'conflict' && (
        <span className={`${page.small} ${page.error}`} data-matcher-settings-conflict>
          {t('run_conflict')}
        </span>
      )}
      {saveErr && (
        <span className={`${page.small} ${page.error}`} data-matcher-settings-save-error>
          {t('error', { error: saveErr })}
        </span>
      )}
    </div>
  );
}
