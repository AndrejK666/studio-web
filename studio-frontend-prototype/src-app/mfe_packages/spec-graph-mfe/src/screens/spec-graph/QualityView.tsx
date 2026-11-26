/**
 * Project › Spec graph › Quality: the project's spec quality in numbers and how
 * far each rule can be trusted.
 * - Headline numbers: findings stored in the graph (blocking and advisory), the
 *   share of p1 requirements a design element realizes, and conflicting passages
 *   that do not link to each other (the ones authors do not see side by side).
 * - Per rule: how many findings, and its calibration from people's labels
 *   (real / not / unsure): precision, its lower 95% bound, and whether it may
 *   block, which takes enough labels and a lower bound over the threshold.
 */

import React, { useEffect, useState } from 'react';
import { apiRegistry } from '@gears-frontx/react';
import { Badge, Card, CardContent, CardHeader, CardTitle, Skeleton } from '@gears-frontx/ui-kit';
import { refusalText } from '@constructor-studio/mfe-shared';
import { SpecGraphApiService } from '../../api/SpecGraphApiService';
import type { Calibration, Metrics } from '../../api/types';
import { useSpecGraphTranslations } from '../../i18n';
import styles from './SpecGraphScreen.module.css';

type Text = ReturnType<typeof useSpecGraphTranslations>['t'];

const message = (e: unknown) => refusalText(e) ?? (e instanceof Error ? e.message : String(e));
const pct = (x: number | null | undefined) => (x == null ? '—' : `${Math.round(x * 100)}%`);

export interface RuleRow {
  rule: string;
  gate: string;
  findings: number;
  real: number;
  not: number;
  unsure: number;
  precision: number | null;
  lower: number | null;
  mayBlock: boolean;
}

/** One row per rule: its findings (`rule (gate)` keys) joined with its calibration. */
export function ruleRows(m: Metrics, c: Calibration): RuleRow[] {
  const rows = new Map<string, RuleRow>();
  const empty = (rule: string, gate = ''): RuleRow => ({
    rule,
    gate,
    findings: 0,
    real: 0,
    not: 0,
    unsure: 0,
    precision: null,
    lower: null,
    mayBlock: false,
  });
  for (const [key, n] of Object.entries(m.findings.by_rule)) {
    const hit = /^(.*) \((block|advise)\)$/.exec(key);
    const rule = hit ? hit[1] : key;
    const row = rows.get(rule) ?? empty(rule, hit?.[2]);
    row.findings += n;
    rows.set(rule, row);
  }
  for (const [rule, k] of Object.entries(c.rules)) {
    const row = rows.get(rule) ?? empty(rule);
    Object.assign(row, {
      real: k.real,
      not: k.not,
      unsure: k.unsure,
      precision: k.precision,
      lower: k.precision_lower_95,
      mayBlock: k.may_block,
    });
    rows.set(rule, row);
  }
  return [...rows.values()].sort((a, b) => b.findings - a.findings || a.rule.localeCompare(b.rule));
}

const Tile: React.FC<{ value: string; label: string; detail?: string }> = ({ value, label, detail }) => (
  <div className={styles.tile}>
    <span className={styles.tileValue}>{value}</span>
    <span>{label}</span>
    {detail && <span className={styles.muted}>{detail}</span>}
  </div>
);

export const QualityView: React.FC<{ projectId: string; t: Text }> = ({ projectId, t }) => {
  const api = apiRegistry.getService(SpecGraphApiService);
  const [data, setData] = useState<{ m: Metrics; c: Calibration } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([
      api.metrics({ projectId }).fetch({ staleTime: 0 }),
      api.calibration({ projectId }).fetch({ staleTime: 0 }),
    ])
      .then(([m, c]) => live && setData({ m: m.answer, c: c.answer }))
      .catch((e: unknown) => live && setError(message(e)));
    return () => {
      live = false;
    };
  }, [api, projectId]);

  if (error) return <p className={styles.error}>{error}</p>;
  if (!data) return <Skeleton className={styles.skeleton} />;
  const { m, c } = data;
  const req = m.requirements_p1;
  const pairs = m.conflicting_pairs;
  const rows = ruleRows(m, c);
  return (
    <>
      <div className={styles.tiles}>
        <Tile
          value={String(m.findings.total)}
          label={t('quality_findings')}
          detail={t('quality_findings_split', { block: m.findings.block, advise: m.findings.advise })}
        />
        {req && (
          <Tile
            value={pct(req.share_with_judge)}
            label={t('quality_realized')}
            detail={t('quality_realized_detail', { done: req.realized_with_judge, count: req.count })}
          />
        )}
        {pairs && (
          <Tile
            value={String(pairs.passages_not_linked)}
            label={t('quality_unlinked')}
            detail={t('quality_unlinked_detail', { pairs: pairs.pairs })}
          />
        )}
      </div>
      <Card className={styles.document}>
        <CardHeader>
          <CardTitle>{t('quality_rules')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className={styles.muted}>
            {t('quality_rules_hint', { min: c.threshold.min_labels, lower: pct(c.threshold.min_precision_lower) })}
          </p>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{t('quality_rule')}</th>
                <th>{t('quality_gate')}</th>
                <th className={styles.num}>{t('quality_count')}</th>
                <th className={styles.num}>{t('quality_labels')}</th>
                <th className={styles.num}>{t('quality_precision')}</th>
                <th>{t('quality_may_block')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.rule}>
                  <td>
                    <code>{r.rule}</code>
                  </td>
                  <td>{r.gate ? (r.gate === 'block' ? t('gate_block') : t('gate_advise')) : '—'}</td>
                  <td className={styles.num}>{r.findings}</td>
                  <td className={styles.num} title={t('quality_labels_title')}>
                    {r.real + r.not + r.unsure ? `${r.real} / ${r.not} / ${r.unsure}` : '—'}
                  </td>
                  <td className={styles.num}>
                    {r.precision == null ? '—' : `${pct(r.precision)} (≥ ${pct(r.lower)})`}
                  </td>
                  <td>
                    {r.mayBlock ? (
                      <Badge variant="secondary">✓ {t('quality_yes')}</Badge>
                    ) : (
                      <span className={styles.muted}>{t('quality_not_yet')}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </>
  );
};
