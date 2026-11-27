/**
 * The findings on the graph: each finding stored in the project's graph, linked to the documents
 * it cites (sections folded into their documents), laid out as islands and coloured by rule
 * family; the legend filters the families. Used as Graph › Findings and on Quality, where a rule
 * chosen in the table keeps only its findings.
 *
 * Choosing a finding opens its panel beside the graph: the rule, the judge's explanation, every
 * passage it cites with its quote, and Real / Dismiss / Label, so a finding is worked through
 * without leaving the graph. Choosing a document opens it to a depth (Graph only).
 */

import React, { useEffect, useMemo, useState } from 'react';
import { apiRegistry } from '@gears-frontx/react';
import { Button, Skeleton } from '@gears-frontx/ui-kit';
import { refusalText } from '@constructor-studio/mfe-shared';
import { SpecGraphApiService } from '../../api/SpecGraphApiService';
import type { Decision, DocumentFindings, Finding, Picture, Verdict } from '../../api/types';
import { findingsPicture } from '../../model/picture';
import { useSpecGraphTranslations } from '../../i18n';
import { FindingRow } from './FindingCard';
import { GraphCanvas } from './GraphCanvas';
import styles from './SpecGraphScreen.module.css';

type Text = ReturnType<typeof useSpecGraphTranslations>['t'];

const message = (e: unknown) => refusalText(e) ?? (e instanceof Error ? e.message : String(e));

/** A finding node's key is `finding:<fingerprint>:<run>`. */
export const fingerprintOf = (key: string) => (key.startsWith('finding:') ? (key.split(':')[1] ?? null) : null);

export const FindingsGraph: React.FC<{
  projectId: string;
  /** Only this rule's findings; every rule's when absent. */
  rule?: string | null;
  /** Open a document (or, from the panel, the finding's place) to a depth; absent on Quality. */
  onOpen?: (key: string) => void;
  t: Text;
}> = ({ projectId, rule = null, onOpen, t }) => {
  const api = apiRegistry.getService(SpecGraphApiService);
  const [all, setAll] = useState<Picture | null>(null);
  const [stored, setStored] = useState<DocumentFindings[]>([]);
  const [error, setError] = useState<string | null>(null);
  // the finding whose panel is open, by its fingerprint
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api
      .overview({ projectId, types: 'finding,section,document' })
      .fetch({ staleTime: 0 })
      .then((r) => live && setAll(r.answer))
      .catch((e: unknown) => live && setError(message(e)));
    // the stored findings in full (both passages, the judge's explanation) for the panel
    api
      .findings({ projectId })
      .fetch({ staleTime: 0 })
      .then((r) => live && setStored(r.items))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, projectId]);
  const picture = useMemo(() => (all ? findingsPicture(all, rule) : null), [all, rule]);
  const byFingerprint = useMemo(() => {
    const m = new Map<string, { path: string | null; finding: Finding }>();
    for (const d of stored) for (const f of d.findings) m.set(f.id, { path: d.path, finding: f });
    return m;
  }, [stored]);

  if (error) return <p className={styles.error}>{error}</p>;
  if (!picture) return <Skeleton className={styles.skeleton} />;
  if (!picture.nodes.some((n) => n.type === 'finding'))
    return <p className={styles.muted}>{t('findings_graph_empty')}</p>;

  const chosen = open ? byFingerprint.get(open) : undefined;
  const chosenKey = open ? (picture.nodes.find((n) => fingerprintOf(n.key) === open)?.key ?? null) : null;
  const click = (key: string) => {
    const fp = fingerprintOf(key);
    if (fp) setOpen((o) => (o === fp ? null : fp));
    else onOpen?.(key);
  };
  return (
    <div className={open ? styles.withPanel : undefined}>
      <GraphCanvas picture={picture} layout="islands" colouring="finding" onOpen={click} selected={chosenKey} t={t} />
      {open && (
        <aside className={styles.panel} aria-label={t('finding_panel')}>
          <div className={styles.findingHead}>
            <strong>{t('finding_panel')}</strong>
            <Button size="sm" variant="ghost" onClick={() => setOpen(null)} aria-label={t('finding_panel_close')}>
              ×
            </Button>
          </div>
          {chosen ? (
            <FindingRow
              key={open}
              path={chosen.path}
              finding={chosen.finding}
              graphBuilt={!!onOpen}
              t={t}
              onDecide={async (f: Finding, d: Decision) => {
                await api.decide(projectId, f.id).fetch({ decision: d, rule: f.rule });
              }}
              onLabel={(f: Finding, verdict: Verdict, note: string) =>
                api.label(projectId, f.id).fetch({ verdict, rule: f.rule, note })
              }
              onShow={(node) => onOpen?.(node)}
            />
          ) : (
            <p className={styles.muted}>{t('finding_panel_missing')}</p>
          )}
        </aside>
      )}
    </div>
  );
};
