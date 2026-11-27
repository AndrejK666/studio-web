/**
 * What Studio already knows of the target (`GET /mna/evidence`): the facts as
 * small tiles in four groups, and the target's repositories with whether each
 * was synced. Every number says where it came from (the fact's `source`); a
 * fact the server could not read says why, and never shows a number.
 */

import React from 'react';
import { Badge, Button, Skeleton } from '@gears-frontx/ui-kit';
import { errorMessage } from '@constructor-studio/mfe-shared';
import type { MnaEvidence, MnaFact } from '../../api/types';
import { groupFacts, isKnownFact, readFact } from '../../model/deal';
import { timeLabel, type Text } from './text';
import styles from './DealScreen.module.css';

export const Evidence: React.FC<{
  evidence: MnaEvidence | undefined;
  loading: boolean;
  error: unknown;
  refreshing: boolean;
  onRefresh: () => void;
  t: Text;
  language: string;
}> = ({ evidence, loading, error, refreshing, onRefresh, t, language }) => (
  <section className={styles.section} data-mna-evidence>
    <div className={styles.sectionHead}>
      <h3 className={styles.sectionTitle}>{t('evidence_title')}</h3>
      {evidence && (
        <span className={styles.muted}>{t('evidence_read_at', { when: timeLabel(evidence.read_at, language) })}</span>
      )}
      <Button
        variant="outline"
        size="sm"
        className={styles.push}
        onClick={onRefresh}
        disabled={refreshing}
        data-mna-evidence-refresh
      >
        {refreshing ? t('refreshing') : t('refresh')}
      </Button>
    </div>
    <p className={styles.about}>{t('evidence_about')}</p>
    {loading ? (
      <div className={styles.tiles}>
        <Skeleton className={styles.tileSkeleton} />
        <Skeleton className={styles.tileSkeleton} />
        <Skeleton className={styles.tileSkeleton} />
      </div>
    ) : error || !evidence ? (
      <p className={styles.error} role="alert">
        {t('evidence_failed', { error: errorMessage(error) })}
      </p>
    ) : (
      <>
        {groupFacts(evidence.facts).map(({ group, facts }) => (
          <div key={group} className={styles.factGroup} data-mna-fact-group={group}>
            <h4 className={styles.groupTitle}>{t(`group_${group}`)}</h4>
            <div className={styles.tiles}>
              {facts.map((fact) => (
                <FactTile key={fact.key} fact={fact} t={t} />
              ))}
            </div>
          </div>
        ))}
        <Repositories evidence={evidence} t={t} language={language} />
      </>
    )}
  </section>
);

Evidence.displayName = 'Evidence';

const FactTile: React.FC<{ fact: MnaFact; t: Text }> = ({ fact, t }) => {
  const reading = readFact(fact);
  const label = isKnownFact(fact.key) ? t(`fact_${fact.key}`) : fact.key;
  let value: React.ReactNode;
  let sub: string | null = null;
  switch (reading.kind) {
    case 'unavailable':
      value = <span className={styles.unavailable}>{t('not_available')}</span>;
      sub = reading.reason;
      break;
    case 'percent':
      value = `${reading.percent}%`;
      sub = reading.total !== null ? t.count('of_runs', reading.total) : null;
      break;
    case 'build':
      value = (
        <Badge variant={reading.passed ? 'success' : 'danger'}>
          {reading.passed ? t('build_passed') : t('build_failed')}
        </Badge>
      );
      sub = fact.detail;
      break;
    case 'count':
      value = reading.of !== null ? t('value_of', { value: reading.value, total: reading.of }) : String(reading.value);
      sub = fact.detail;
      break;
    default:
      value = '—';
      sub = fact.detail;
  }
  return (
    <div className={styles.tile} data-mna-fact={fact.key} data-mna-fact-available={fact.available}>
      <span className={styles.tileLabel}>{label}</span>
      <span className={styles.tileValue}>{value}</span>
      {sub && <span className={styles.tileDetail}>{sub}</span>}
      <span className={styles.tileSource} title={t('source_hint')}>
        {t('source', { source: fact.source })}
      </span>
    </div>
  );
};

const Repositories: React.FC<{ evidence: MnaEvidence; t: Text; language: string }> = ({ evidence, t, language }) => {
  const num = (n: number | null) => (n === null ? '—' : String(n));
  return (
    <div className={styles.factGroup} data-mna-repositories>
      <h4 className={styles.groupTitle}>{t('repositories_title')}</h4>
      {evidence.repositories.length === 0 ? (
        <p className={styles.muted}>{t('repositories_none')}</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{t('col_repository')}</th>
                <th>{t('col_branch')}</th>
                <th>{t('col_synced')}</th>
                <th className={styles.num}>{t('col_contributors')}</th>
                <th className={styles.num}>{t('col_truck_factor')}</th>
              </tr>
            </thead>
            <tbody>
              {evidence.repositories.map((r) => (
                <tr key={r.full_path} data-mna-repository={r.full_path}>
                  <td>
                    <code>{r.full_path}</code>
                  </td>
                  <td>{r.branch ?? '—'}</td>
                  <td>
                    {r.synced_at ? (
                      <Badge variant="success">{t('synced_at', { when: timeLabel(r.synced_at, language) })}</Badge>
                    ) : (
                      <Badge variant="warning">{t('not_synced')}</Badge>
                    )}
                  </td>
                  <td className={styles.num}>{num(r.contributors)}</td>
                  <td className={styles.num}>{num(r.truck_factor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
