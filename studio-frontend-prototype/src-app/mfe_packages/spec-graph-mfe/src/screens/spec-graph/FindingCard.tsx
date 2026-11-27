/**
 * One finding, as Now, Stored and the findings graph's panel show it: its rule and gate, the
 * message (a judge's explanation for a model's finding), every place it cites with the quote, a
 * suggested replacement, and what a person does with it: Real or Dismiss (a decision Project model
 * keeps; a dismissal also leaves checks and reviews), or a label (real / not / unsure, a note) that
 * only calibrates the rule.
 */

import React, { useState } from 'react';
import { Badge, Button } from '@gears-frontx/ui-kit';
import type { Decision, Finding, Verdict } from '../../api/types';
import { place } from '../../model/findings';
import { findingNode } from '../../model/graph';
import { useSpecGraphTranslations } from '../../i18n';
import styles from './SpecGraphScreen.module.css';

type Text = ReturnType<typeof useSpecGraphTranslations>['t'];

export const FindingRow: React.FC<{
  path: string | null;
  finding: Finding;
  /** Show in graph only once the graph is built: before, it opens on nothing. */
  graphBuilt: boolean;
  /** The decision already taken here (the panel keeps it while the finding stays shown). */
  decided?: Decision | null;
  t: Text;
  onDecide: (f: Finding, d: Decision) => Promise<void>;
  /** A label for the rule's calibration: it neither hides the finding nor records a decision. */
  onLabel: (f: Finding, verdict: Verdict, note: string) => Promise<unknown>;
  onShow: (node: string) => void;
}> = ({ path, finding: f, graphBuilt, decided = null, t, onDecide, onLabel, onShow }) => {
  const [done, setDone] = useState<Decision | null>(decided);
  const node = graphBuilt ? findingNode(path, f) : null;
  const [deciding, setDeciding] = useState(false);
  const [labelling, setLabelling] = useState(false);
  const [verdict, setVerdict] = useState<Verdict>('not');
  const [note, setNote] = useState('');
  const [labelled, setLabelled] = useState<Verdict | null>(null);
  const label = async () => {
    setDeciding(true);
    try {
      await onLabel(f, verdict, note.trim());
      setLabelled(verdict);
      setLabelling(false);
    } finally {
      setDeciding(false);
    }
  };
  const act = async (d: Decision) => {
    setDeciding(true);
    await onDecide(f, d);
    setDone(d);
    setDeciding(false);
  };
  return (
    <div className={styles.finding} data-gate={f.gate}>
      <div className={styles.findingHead}>
        <Badge variant={f.gate === 'block' ? 'destructive' : 'secondary'}>
          {f.gate === 'block' ? t('gate_block') : t('gate_advise')}
        </Badge>
        <strong>{f.title}</strong>
        <code className={styles.rule}>{f.rule}</code>
      </div>
      <p className={styles.message}>{f.message}</p>
      <p className={styles.place}>
        <code>{place(path, f.anchor)}</code>
        {f.anchor.quote && <span className={styles.quote}> — {f.anchor.quote}</span>}
      </p>
      {f.related.length > 0 && (
        <ul className={styles.related}>
          {f.related.slice(0, 5).map((r) => (
            <li key={place(r.path, r.anchor)}>
              <code>{place(r.path, r.anchor)}</code>
              {r.anchor.quote && <span className={styles.quote}> — {r.anchor.quote}</span>}
            </li>
          ))}
        </ul>
      )}
      {f.suggestion && (
        <pre className={styles.suggestion} aria-label={t('suggestion')}>
          {f.suggestion.text}
        </pre>
      )}
      <div className={styles.rowActions}>
        {done ? (
          <Badge variant="outline">{t(done === 'confirmed' ? 'decided_confirmed' : 'decided_dismissed')}</Badge>
        ) : (
          <>
            <Button size="sm" variant="outline" disabled={deciding} onClick={() => void act('confirmed')}>
              {t('confirm')}
            </Button>
            <Button size="sm" variant="ghost" disabled={deciding} onClick={() => void act('dismissed')}>
              {t('dismiss')}
            </Button>
          </>
        )}
        {node && (
          <Button size="sm" variant="link" onClick={() => onShow(node)}>
            {t('show_in_graph')}
          </Button>
        )}
        {!labelling && !labelled && (
          <Button size="sm" variant="link" onClick={() => setLabelling(true)} title={t('label_hint')}>
            {t('label')}
          </Button>
        )}
        {labelled && <Badge variant="outline">{t('labelled', { verdict: t(`verdict_${labelled}`) })}</Badge>}
      </div>
      {labelling && (
        <form
          className={styles.labelForm}
          onSubmit={(e) => {
            e.preventDefault();
            void label();
          }}
        >
          {(['real', 'not', 'unsure'] as const).map((v) => (
            <label key={v} className={styles.radio}>
              <input type="radio" name={`verdict-${f.id}`} checked={verdict === v} onChange={() => setVerdict(v)} />
              {t(`verdict_${v}`)}
            </label>
          ))}
          <input
            className={styles.input}
            value={note}
            placeholder={t('label_note')}
            aria-label={t('label_note')}
            onChange={(e) => setNote(e.target.value)}
          />
          <Button size="sm" type="submit" disabled={deciding}>
            {t('label_save')}
          </Button>
          <Button size="sm" type="button" variant="ghost" onClick={() => setLabelling(false)}>
            {t('label_cancel')}
          </Button>
        </form>
      )}
    </div>
  );
};
