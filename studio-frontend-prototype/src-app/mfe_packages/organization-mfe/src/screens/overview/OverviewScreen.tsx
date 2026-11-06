/**
 * Organization › Overview, for the people who lead it (the prototype's
 * org-dashboard.tsx, ADR-0069 parity). One read — `GET /studio-organizations/
 * v1/overview` — and the prototype's words for it (overview/model.ts):
 *
 *   - the header: the organization, and how much needs attention;
 *   - four tiles: spend, delivery, specs, people;
 *   - "Needs attention › For others": refused connections, spend, who the
 *     stuck pull requests wait on, components to decide, idle people;
 *   - the workspaces, each with its worst project and why.
 *
 * Not yet here: the metrics board (charts over 7/30/90 days, Constructor
 * Insight's figures) and "For you" — what waits on the reader is the shell's
 * Inbox (ADR-0068 §6), not this screen's to compute.
 */

import React from 'react';
import {
  apiRegistry,
  useApiQuery,
  useMfeBridge,
  useSharedProperty,
  FRONTX_SHARED_PROPERTY_LANGUAGE,
} from '@gears-frontx/react';
import { Badge, Card, CardContent, CardHeader, CardTitle, Skeleton } from '@gears-frontx/ui-kit';
import { openScreen, useOrganization } from '@constructor-studio/mfe-shared';
import { OverviewApiService } from '../../api/OverviewApiService';
import { attentionStatus, growthText, othersAttention, workspaceLine, type NeedTarget } from '../../overview/model';
import type { OrgOverview } from '../../overview/types';
import { useOverviewTranslations } from '../../i18n';
import styles from './OverviewScreen.module.css';

type Text = ReturnType<typeof useOverviewTranslations>['t'];

/** Where a row's action leads, among the screens this portal has so far.
 *  Costs, Components and Background work are not here yet (parity.md): their
 *  rows say what is wrong and offer no button rather than a dead one. */
const TARGET_ROUTE: Partial<Record<NeedTarget, string>> = {
  connectors: '/connections',
  projects: '/organization/workspaces',
  people: '/people',
};

function money(value: number, currency: string, language: string): string {
  try {
    return new Intl.NumberFormat(language, { style: 'currency', currency, maximumFractionDigits: 0 }).format(value);
  } catch {
    return `${Math.round(value)} ${currency}`;
  }
}

const shown = (v: number | null | undefined, t: Text) => (v === null || v === undefined ? t('unknown') : String(v));

export const OverviewScreen: React.FC = () => {
  const { org } = useOrganization();
  const published = useSharedProperty(FRONTX_SHARED_PROPERTY_LANGUAGE);
  const language = typeof published === 'string' && published ? published : 'en';
  const { t, loading } = useOverviewTranslations();
  if (loading || !org) return <Skeleton className={styles.skeleton} />;
  return <OrganizationOverview key={org.id} organizationId={org.id} name={org.name} t={t} language={language} />;
};

OverviewScreen.displayName = 'OverviewScreen';

function OrganizationOverview({
  organizationId,
  name,
  t,
  language,
}: {
  organizationId: string;
  name: string;
  t: Text;
  language: string;
}) {
  const bridge = useMfeBridge();
  const read = useApiQuery(apiRegistry.getService(OverviewApiService).overview({ organizationId }));
  const o: OrgOverview | undefined = read.data;
  const cash = (n: number) => money(n, o?.spend?.currency || 'USD', language);
  const others = o ? othersAttention(o, cash) : [];

  return (
    <div className={styles.screen} data-org-overview>
      <header className={styles.header}>
        <h2 className={styles.title} title={t('about')}>
          {o?.name ?? name}
        </h2>
        {o ? (
          <Badge variant={others.length > 0 ? 'warning' : 'success'} dot data-attention-status>
            {attentionStatus(0, others.length)}
          </Badge>
        ) : read.isError ? (
          <Badge variant="danger">{t('unreadable')}</Badge>
        ) : (
          <Badge variant="info">{t('reading')}</Badge>
        )}
      </header>
      <p className={styles.about}>{t('about')}</p>

      {read.isError && (
        <p role="alert" className={styles.error}>
          {t('load_failed', { error: String(read.error) })}
        </p>
      )}
      {read.isLoading && <Skeleton className={styles.skeletonWide} />}

      {o && (
        <>
          <div className={styles.tiles} data-overview-tiles>
            <Tile title={t('tile_spend')}>
              {o.costs === 'hidden' ? (
                <span className={styles.muted}>{t('tile_spend_hidden')}</span>
              ) : o.costs === 'unreadable' || !o.spend ? (
                <span className={styles.muted}>{t('tile_spend_unreadable')}</span>
              ) : (
                <>
                  <span className={styles.big}>{cash(o.spend.current)}</span>
                  <span className={styles.muted}>
                    {t('tile_spend_sub', {
                      growth: growthText(o.spend.current, o.spend.previous),
                      forecast: cash(o.spend.forecast),
                    })}
                  </span>
                </>
              )}
            </Tile>
            <Tile title={t('tile_delivery')}>
              <span className={styles.big}>{t('tile_delivery_value', { merged: shown(o.delivery.merged, t) })}</span>
              <span className={styles.muted}>
                {t('tile_delivery_sub', {
                  open: shown(o.delivery.open, t),
                  wait: shown(o.delivery.median_wait_days, t),
                })}
              </span>
            </Tile>
            <Tile title={t('tile_specs')}>
              <span className={styles.big}>
                {t('tile_specs_value', { failing: shown(o.specs.failing, t), specs: shown(o.specs.specs, t) })}
              </span>
              <span className={styles.muted}>{t('tile_specs_sub', { findings: shown(o.specs.open_findings, t) })}</span>
            </Tile>
            <Tile title={t('tile_people')}>
              <span className={styles.big}>{t('tile_people_value', { active: shown(o.people.active, t) })}</span>
              <span className={styles.muted}>
                {t('tile_people_sub', { idle: shown(o.people.idle?.length ?? null, t) })}
              </span>
            </Tile>
          </div>

          <div className={styles.columns}>
            <Card data-org-needs>
              <CardHeader>
                <CardTitle>{t('needs_title')}</CardTitle>
              </CardHeader>
              <CardContent>
                <h3 className={styles.group}>
                  {t('for_others')}
                  {others.length > 0 && <span className={styles.count}>{others.length}</span>}
                </h3>
                {others.length === 0 ? (
                  <p className={styles.muted}>{t('nothing_waits')}</p>
                ) : (
                  <ul className={styles.list}>
                    {others.map((r) => (
                      <li key={r.key} className={`${styles.row} ${styles[r.tone]}`} data-attention={r.key.split(':')[0]}>
                        <b>{r.sentence}</b>
                        {r.detail && <span className={styles.muted}> · {r.detail}</span>}
                        {TARGET_ROUTE[r.action.target] && (
                          <button
                            type="button"
                            className={styles.action}
                            onClick={() => openScreen(bridge, TARGET_ROUTE[r.action.target]!)}
                          >
                            {r.action.label}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card data-org-workspaces>
              <CardHeader>
                <CardTitle>{t('workspaces_title')}</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className={styles.list}>
                  {o.workspaces.map((ws) => (
                    <li key={ws.id} className={styles.row} data-overview-workspace={ws.id}>
                      <b>{ws.name}</b>
                      <span className={styles.muted}> · {workspaceLine(ws, o.stuck_days)}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function Tile({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className={styles.tileTitle}>{title}</CardTitle>
      </CardHeader>
      <CardContent className={styles.tileBody}>{children}</CardContent>
    </Card>
  );
}
