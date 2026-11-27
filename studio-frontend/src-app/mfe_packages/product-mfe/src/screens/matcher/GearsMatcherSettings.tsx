/**
 * Organization › Gears matcher (the Gears matcher kit, ADR-0072, ADR-0074):
 *
 * - the service: whether the gears-matcher service is set up for this
 *   deployment and whether it answers now (its `/v1/info`, asked by the server
 *   at most every 30 s: versions, catalogue commit, limits), and its run
 *   settings (`MatcherRunSettings`: provider, models, call bounds), which the
 *   organization's administrator changes for its own service and a platform
 *   administrator for the deployment's shared one;
 * - the organization's default way of assembling its projects' products, out
 *   of the strategies its installed kits provide (Spec mapping, Gears
 *   matcher): a choice only where there is more than one, which a project may
 *   override on Project › Product. Only an organization administrator changes
 *   it; everybody else reads it;
 * - how its projects use the matcher over a period (`GearsMatcherUsage`).
 */

import { useEffect, useState } from 'react';
import type { ChildMfeBridge } from '@gears-frontx/react';
import { Button, Input, Skeleton } from '@gears-frontx/ui-kit';
import { productApiFor } from '../../api/client';
import { offeredStrategies, strategyName, type AssemblyStrategy, type StrategyId } from '../../model/assembly';
import { serviceState, servicesOf, type GearMatchUsage, type MatcherService } from '../../model/gear-match-usage';
import { useAssemblyTranslations } from '../../i18n';
import { ProjectPage } from '@constructor-studio/mfe-shared/page';
import { errText, Segmented, StatusChip } from '../common';
import { PeriodSwitch, UsageGrid, UsageTiles, useAddressPeriod } from './GearsMatcherUsage';
import { MatcherRunSettings } from './MatcherRunSettings';
import page from '../product.module.css';
import styles from './matcher.module.css';

type T = (key: string, params?: Record<string, string>) => string;

/** Connect a strategy's service for the organization: its address and secret, kept as a connection, never in the kit. */
function ConnectService({ orgId, strategy, name, t, onDone }: { orgId: string; strategy: string; name: string; t: T; onDone: () => void }) {
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const connect = async () => {
    setBusy(true);
    setErr(null);
    try {
      await productApiFor(orgId).connectStrategyService(orgId, strategy, url.trim(), secret, name);
      setSecret('');
      onDone();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={page.stack} data-gears-matcher-connect={strategy}>
      <span className={`${page.small} ${page.muted}`}>{t('service_connect_lead')}</span>
      <span className={page.row}>
        <Input
          aria-label={t('service_connect_url')}
          placeholder={t('service_connect_url')}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          data-gears-matcher-connect-url
        />
        <Input
          type="password"
          aria-label={t('service_connect_secret')}
          placeholder={t('service_connect_secret')}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          data-gears-matcher-connect-secret
        />
        <Button type="button" size="sm" disabled={busy || !url.trim() || !secret} onClick={() => void connect()} data-gears-matcher-connect-submit>
          {busy ? t('saving') : t('service_connect')}
        </Button>
      </span>
      {err && <span className={`${page.small} ${page.error}`}>{t('error', { error: err })}</span>}
    </div>
  );
}

/** One strategy's service block: configured or connected, answering, and what it said. */
function ServiceCard({
  service,
  fallback,
  t,
  language,
  orgId,
  mayConnect,
  onConnected,
  onSettingsSaved,
}: {
  service: MatcherService | null;
  fallback: AssemblyStrategy['gears_matcher'] | null;
  t: T;
  language: string;
  orgId: string;
  mayConnect: boolean;
  onConnected: () => void;
  onSettingsSaved: () => void;
}) {
  // Before the usage is read (or where it cannot be), the configuration alone.
  const s: MatcherService | null =
    service ?? (fallback ? { configured: fallback.configured, missing: fallback.missing, models: [] } : null);
  if (!s) return null;
  const state = serviceState(s);
  const tone = state === 'answers' ? 'ok' : state === 'unknown' ? 'neutral' : state === 'silent' ? 'danger' : 'warn';
  const label =
    state === 'missing'
      ? t('org_service_missing', { reason: s.missing ?? '' })
      : t(`org_service_${state}`);
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
  const strategy = s.strategy ?? 'gears_matcher';
  const name = s.name ?? t('strategy_gears_matcher');
  return (
    <div className={page.card} data-gears-matcher-service-card={strategy}>
      <span className={page.row}>
        <b>{t('org_service_of', { name })}</b>
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
      {typeof s.runs === 'number' && s.runs > 0 && (
        <span className={`${page.small} ${page.muted}`} data-gears-matcher-service-runs>
          {t('org_service_runs', { runs: String(s.runs), calls: String(s.usage?.calls ?? 0) })}
        </span>
      )}
      {state === 'unconnected' &&
        (mayConnect ? (
          <ConnectService orgId={orgId} strategy={strategy} name={name} t={t} onDone={onConnected} />
        ) : (
          <span className={`${page.small} ${page.muted}`}>{t('service_connect_admin')}</span>
        ))}
      {(state === 'answers' || state === 'unknown') && (
        <MatcherRunSettings orgId={orgId} strategy={strategy} t={t} language={language} onSaved={onSettingsSaved} />
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
  /** Bumped to read the usage (and the services) again, after a service is connected. */
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    productApiFor(orgId).organizationAssemblyStrategy(orgId).then(
      (r) => live && setA(r),
      (e: unknown) => live && setErr(errText(e))
    );
    return () => {
      live = false;
    };
  }, [orgId]);

  useEffect(() => {
    let live = true;
    productApiFor(orgId).gearMatchUsage(orgId, period).then(
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
  }, [orgId, period, round]);

  const choose = async (c: StrategyId) => {
    setBusy(true);
    setErr(null);
    try {
      setA(await productApiFor(orgId).setOrganizationAssemblyStrategy(orgId, c));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const kits = a ? offeredStrategies(a) : [];
  const label = (s: string) => strategyName(s, t, kits);
  // The default the picker shows: the organization's own, else what the kits make it.
  const current = (a?.organization_default ?? (a?.chosen !== 'manual' ? a?.chosen : null)) as StrategyId | null;

  return (
    <ProjectPage title={t('org_title')} help={<p>{t('org_lead')}</p>} helpLabel={t('help_label')}>
      <div className={page.stack} data-gears-matcher-settings>
        {!a && !err && <Skeleton className={page.skeleton} />}
        {err && <p className={page.error}>{t('error', { error: err })}</p>}
        {a && (
          <>
            {(usage ? servicesOf(usage) : [null]).map((service) => (
              <ServiceCard
                key={service?.strategy ?? 'gears_matcher'}
                service={service}
                fallback={a.gears_matcher}
                t={t}
                language={language}
                orgId={orgId}
                mayConnect={a.may_set_default}
                onConnected={() => setRound((r) => r + 1)}
                onSettingsSaved={() => setRound((r) => r + 1)}
              />
            ))}
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
                    title: k.offered ? (k.description || t(`hint_${k.id}`)) : (k.reason ?? k.description),
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
    </ProjectPage>
  );
}
