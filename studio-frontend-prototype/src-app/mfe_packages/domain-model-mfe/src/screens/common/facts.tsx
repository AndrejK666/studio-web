/**
 * A fact and the passage it rests on, as every view of the tab draws them
 * (the prototype's `Prose`, `SideLink` and `FactRow` in
 * domain-model-screens.tsx). A member accepts or rejects a reading right on
 * its row when the tab provides the review (`FactReviewContext`).
 */

import { useContext } from 'react';
import { FactReviewContext } from '../../model/review-state';
import { PROVISIONAL_NOTE } from '../../model/saved-entities';
import { codeSpans, sideLabel, type SpecModelFact, type SpecModelSide } from '../../model/spec-model';
import { useCommonTranslations } from '../../i18n';
import styles from './common.module.css';

/** Opens a document in the project's editor; absent where nothing can open it. */
export type OpenFile = ((path: string) => void) | undefined;

/** Text the backend wrote with backticked names, the names set as code. */
export function Prose({ text }: { text: string }) {
  return <>{codeSpans(text).map((s, i) => (s.code ? <code key={i}>{s.text}</code> : s.text))}</>;
}

/** Where a fact was read: the document and its lines, and the passage quoted. */
export function SideLink({ side, onOpenFile }: { side: SpecModelSide; onOpenFile?: OpenFile }) {
  const { t } = useCommonTranslations();
  return (
    <div className={styles.side}>
      <button
        type="button"
        className={styles.sidePath}
        disabled={!onOpenFile}
        onClick={() => onOpenFile?.(side.path)}
        title={onOpenFile ? t('open_in_editor') : undefined}
      >
        {sideLabel(side)}
      </button>
      {side.quote && <blockquote className={styles.quote}>{side.quote}</blockquote>}
    </div>
  );
}

/** One fact with its review buttons, its state and its passage. */
export function FactRow({ fact, onOpenFile }: { fact: SpecModelFact; onOpenFile?: OpenFile }) {
  const { t } = useCommonTranslations();
  const inactive = fact.status !== 'active';
  const review = useContext(FactReviewContext);
  const state = review?.stateOf(fact);
  const cls = [
    styles.fact,
    inactive ? styles.factInactive : '',
    state === 'accepted' ? styles.factAccepted : state === 'rejected' ? styles.factRejected : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={cls} data-fact-state={state ?? 'proposed'}>
      {review && !fact.provisional && (
        <span className={styles.review} role="group" aria-label={t('review_group')}>
          <button
            type="button"
            aria-pressed={state === 'accepted'}
            title={state === 'accepted' ? t('accepted_put_back') : t('accept_reading')}
            onClick={() => void review.review([fact], state === 'accepted' ? 'proposed' : 'accepted')}
          >
            ✓
          </button>
          <button type="button" title={t('reject_reading')} onClick={() => void review.review([fact], 'rejected')}>
            ✗
          </button>
        </span>
      )}
      <div>
        {fact.aspect && <span className={styles.aspect}>{fact.aspect}: </span>}
        {fact.value ? <strong>{fact.value}</strong> : fact.text}
        {inactive && (
          <span className={styles.status} title={fact.status_because}>
            {fact.status}
          </span>
        )}
        {fact.provisional && <span className={styles.status}>{PROVISIONAL_NOTE}</span>}
        {state && review?.reviewedEarlier?.(fact) && (
          <span className={styles.status} title={t('reviewed_earlier_title')}>
            {t(state === 'accepted' ? 'accepted_earlier' : 'rejected_earlier')}
          </span>
        )}
      </div>
      {fact.value && fact.text && <div className={styles.hint}>{fact.text}</div>}
      <SideLink side={fact.source} onOpenFile={onOpenFile} />
    </div>
  );
}
