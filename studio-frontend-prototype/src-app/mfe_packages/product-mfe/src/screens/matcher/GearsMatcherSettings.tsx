/**
 * Organization › Gears matcher (the Gears matcher kit, ADR-0072): whether the
 * gears-matcher service is set up for this deployment, and the organization's
 * default way of assembling its projects' products (`spec_mapping` or
 * `gears_matcher`), which a project may override on Project › Product. Only an
 * organization administrator changes it; everybody else reads it.
 */

import { useEffect, useState } from 'react';
import { Skeleton } from '@gears-frontx/ui-kit';
import { productApi } from '../../api/client';
import { STRATEGIES, type AssemblyStrategy, type StrategyId } from '../../model/assembly';
import { useAssemblyTranslations } from '../../i18n';
import { errText, PageHeader, Segmented, StatusChip } from '../common';
import page from '../product.module.css';

type DefaultChoice = 'studio' | StrategyId;

export function GearsMatcherSettings({ orgId }: { orgId: string }) {
  const { t } = useAssemblyTranslations();
  const [a, setA] = useState<AssemblyStrategy | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    productApi.organizationAssemblyStrategy(orgId).then(
      (r) => live && setA(r),
      (e: unknown) => live && setErr(errText(e))
    );
    return () => {
      live = false;
    };
  }, [orgId]);

  const choose = async (c: DefaultChoice) => {
    setBusy(true);
    setErr(null);
    try {
      setA(await productApi.setOrganizationAssemblyStrategy(orgId, c === 'studio' ? null : c));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const label = (s: StrategyId) => t(`strategy_${s}`);
  const matcher = a?.gears_matcher;

  return (
    <div className={page.stack} data-gears-matcher-settings>
      <PageHeader title={t('org_title')} info={<p>{t('org_lead')}</p>} />
      {!a && !err && <Skeleton className={page.skeleton} />}
      {err && <p className={page.error}>{t('error', { error: err })}</p>}
      {a && matcher && (
        <>
          <div className={page.card}>
            <span className={page.row}>
              <b>{t('org_service')}</b>
              <StatusChip tone={matcher.configured ? 'ok' : 'warn'} data-gears-matcher-service={matcher.configured ? 'ready' : 'missing'}>
                {matcher.configured ? t('org_service_ready') : t('org_service_missing', { reason: matcher.missing ?? '' })}
              </StatusChip>
            </span>
          </div>
          <div className={page.card} data-gears-matcher-default={a.organization_default ?? 'studio'}>
            <b>{t('org_default')}</b>
            {a.settable ? (
              <Segmented
                label={t('org_default')}
                value={(a.organization_default ?? 'studio') as DefaultChoice}
                onChange={(c) => void choose(c)}
                dataAttr="data-gears-matcher-default-choice"
                items={[
                  { id: 'studio' as DefaultChoice, label: t('org_default_studio', { strategy: label('spec_mapping') }) },
                  ...STRATEGIES.map((s) => ({
                    id: s as DefaultChoice,
                    label: label(s),
                    title: t(`hint_${s}`),
                  })),
                ].map((item) => ({ ...item, disabled: busy || !a.may_set_default }))}
              />
            ) : (
              <span className={page.muted}>{t('org_not_settable')}</span>
            )}
            {a.settable && !a.may_set_default && <span className={`${page.small} ${page.muted}`}>{t('org_may_not')}</span>}
            <span className={page.small}>{t('org_effective', { strategy: label(a.strategy) })}</span>
            {a.fallback && (
              <span className={`${page.small} ${page.error}`} data-gears-matcher-fallback={a.fallback.code}>
                {t('fallback', { chosen: label(a.chosen), reason: a.fallback.reason })}
              </span>
            )}
            {busy && <span className={`${page.small} ${page.muted}`}>{t('saving')}</span>}
          </div>
        </>
      )}
    </div>
  );
}
