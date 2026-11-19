/**
 * Organization › Gears matcher (the Gears matcher kit, ADR-0072, ADR-0074):
 *
 * - the service: whether the gears-matcher service is set up for this
 *   deployment and whether it answers now (its `/v1/info`, asked by the server
 *   at most every 30 s: versions, catalogue commit, limits);
 * - the organization's default way of assembling its projects' products, out
 *   of the strategies its installed kits provide (Spec mapping, Gears
 *   matcher): a choice only where there is more than one, which a project may
 *   override on Project › Product. Only an organization administrator changes
 *   it; everybody else reads it;
 * - how its projects use the matcher over a period (`GearsMatcherUsage`).
 */

import { useEffect, useState } from 'react';
import type { ChildMfeBridge } from '@gears-frontx/react';
import { Skeleton } from '@gears-frontx/ui-kit';
import { productApi } from '../../api/client';
import { offeredStrategies, type AssemblyStrategy, type StrategyId, type StrategyUsed } from '../../model/assembly';
import { serviceState, type GearMatchUsage, type MatcherService } from '../../model/gear-match-usage';
import { useAssemblyTranslations } from '../../i18n';
import { errText, PageHeader, Segmented, StatusChip } from '../common';
import { PeriodSwitch, UsageGrid, UsageTiles, useAddressPeriod } from './GearsMatcherUsage';
import page from '../product.module.css';
import styles from './matcher.module.css';

type T = (key: string, params?: Record<string, string>) => string;

/** The service block: configured, answering, and what it said. */
function ServiceCard({ service, fallback, t, language }: { service: MatcherService | null; fallback: AssemblyStrategy['gears_matcher'] | null; t: T; language: string }) {
  // Before the usage is read (or where it cannot be), the configuration alone.
  const s: MatcherService | null =
    service ?? (fallback ? { configured: fallback.configured, missing: fallback.missing, models: [] } : null);
  if (!s) return null;
  const state = serviceState(s);
  const tone = state === 'answers' ? 'ok' : state === 'unknown' ? 'neutral' : state === 'silent' ? 'danger' : 'warn';
  const label =
    state === 'missing' ? t('org_service_missing', { reason: s.missing ?? '' }) : t(`org_service_${state}`);
  const facts = [
    s.service_version ? t('org_service_version', { version: s.service_version }) : null,
    s.catalogue_commit
      ? t('org_service_catalogue', { source: s.catalogue_source ?? '', commit: s.catalogue_commit.slice(0, 8) })
      : null,
    s.models.length ? t('org_service_models', { models: s.models.join(', ') }) : null,
    s.limits?.max_documents != null
      ? t('org_service_limits', {
          documents: String(s.limits.max_documents),
          document: String(Math.round((s.limits.max_document_bytes ?? 0) / 1000)),
          request: String(Math.round((s.limits.max_request_bytes ?? 0) / 1000)),
        })
      : null,
    s.checked_at ? t('org_service_checked', { time: new Date(s.checked_at).toLocaleTimeString(language) }) : null,
  ].filter((f): f is string => !!f);
  return (
    <div className={page.card} data-gears-matcher-service-card>
      <span className={page.row}>
        <b>{t('org_service')}</b>
        <StatusChip tone={tone} data-gears-matcher-service={state === 'answers' || state === 'unknown' ? 'ready' : state}>
          {label}
        </StatusChip>
      </span>
      {facts.length > 0 && (
        <span className={styles.facts}>
          {facts.map((f) => (
            <span key={f}>{f}</span>
          ))}
        </span>
      )}
      {state === 'silent' && s.error && (
        <span className={`${page.small} ${page.error}`} data-gears-matcher-service-error>
          {t('org_service_error', { error: s.error })}
        </span>
      )}
    </div>
  );
}

export function GearsMatcherSettings({
  orgId,
  bridge = null,
  language = 'en',
}: {
  orgId: string;
  bridge?: ChildMfeBridge | null;
  language?: string;
}) {
  const { t } = useAssemblyTranslations();
  const [a, setA] = useState<AssemblyStrategy | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [period, setPeriod] = useAddressPeriod();
  const [usage, setUsage] = useState<GearMatchUsage | null>(null);
  const [usageErr, setUsageErr] = useState<string | null>(null);

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

  useEffect(() => {
    let live = true;
    productApi.gearMatchUsage(orgId, period).then(
      (r) => {
        if (!live) return;
        setUsage(r);
        setUsageErr(null);
      },
      (e: unknown) => {
        if (!live) return;
        setUsage(null);
        setUsageErr(errText(e));
      }
    );
    return () => {
      live = false;
    };
  }, [orgId, period]);

  const choose = async (c: StrategyId) => {
    setBusy(true);
    setErr(null);
    try {
      setA(await productApi.setOrganizationAssemblyStrategy(orgId, c));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const label = (s: StrategyUsed) => t(`strategy_${s}`);
  const kits = a ? offeredStrategies(a) : [];
  // The default the picker shows: the organization's own, else what the kits make it.
  const current = (a?.organization_default ?? (a?.chosen !== 'manual' ? a?.chosen : null)) as StrategyId | null;

  return (
    <div className={page.stack} data-gears-matcher-settings>
      <PageHeader title={t('org_title')} info={<p>{t('org_lead')}</p>} />
      {!a && !err && <Skeleton className={page.skeleton} />}
      {err && <p className={page.error}>{t('error', { error: err })}</p>}
      {a && (
        <>
          <ServiceCard service={usage?.service ?? null} fallback={a.gears_matcher} t={t} language={language} />
          <div className={page.card} data-gears-matcher-default={a.organization_default ?? 'kits'}>
            <b>{t('org_default')}</b>
            {!a.settable ? (
              <span className={page.muted}>{t('org_not_settable')}</span>
            ) : kits.length === 0 ? (
              <span className={page.muted} data-gears-matcher-default-none>
                {t('org_default_none')}
              </span>
            ) : kits.length === 1 ? (
              <span className={page.small} data-gears-matcher-default-only={kits[0].id}>
                {t('org_default_only', { strategy: label(kits[0].id) })}
              </span>
            ) : (
              <Segmented
                label={t('org_default')}
                value={(current ?? kits[0].id) as StrategyId}
                onChange={(c) => void choose(c)}
                dataAttr="data-gears-matcher-default-choice"
                items={kits.map((k) => ({
                  id: k.id,
                  label: label(k.id),
                  title: k.offered ? t(`hint_${k.id}`) : (k.reason ?? t(`hint_${k.id}`)),
                  disabled: busy || !a.may_set_default,
                }))}
              />
            )}
            {a.settable && kits.length > 1 && !a.may_set_default && (
              <span className={`${page.small} ${page.muted}`}>{t('org_may_not')}</span>
            )}
            {kits.length > 0 && <span className={page.small}>{t('org_effective', { strategy: label(a.strategy) })}</span>}
            {a.fallback && (
              <span className={`${page.small} ${page.error}`} data-gears-matcher-fallback={a.fallback.code}>
                {a.strategy === 'manual'
                  ? t('fallback_manual', { chosen: label(a.chosen), reason: a.fallback.reason })
                  : t('fallback', { chosen: label(a.chosen), used: label(a.strategy), reason: a.fallback.reason })}
              </span>
            )}
            {busy && <span className={`${page.small} ${page.muted}`}>{t('saving')}</span>}
          </div>
        </>
      )}
      <section className={page.stack} data-gears-matcher-usage>
        <div className={styles.heading}>
          <h3>{t('usage_title')}</h3>
          <PeriodSwitch period={period} onChange={setPeriod} t={t} />
        </div>
        {!usage && !usageErr && <Skeleton className={page.skeleton} />}
        {usageErr && <p className={`${page.small} ${page.error}`}>{t('usage_error', { error: usageErr })}</p>}
        {usage && (
          <>
            <UsageTiles usage={usage} t={t} />
            <UsageGrid usage={usage} t={t} language={language} bridge={bridge} organizationId={orgId} />
          </>
        )}
      </section>
    </div>
  );
}
