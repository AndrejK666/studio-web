/**
 * Project › Spec graph › Pull requests: review an open pull request as the
 * spec-graph service's CI does. The deterministic review answers in seconds;
 * with the model it is a run on the service (minutes, model cost) that this
 * view follows to its end. Either way the answer is the findings the pull
 * request brings and the threads CI would post on its head, shown here: Studio
 * does not post them on the pull request yet.
 *
 * Only the pull requests of the repository the graph reads are listed: a review
 * names branches, not a repository, so another repository's pull request with
 * the same branch name would be reviewed against the wrong code.
 */

import React, { useEffect, useState } from 'react';
import { apiRegistry } from '@gears-frontx/react';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Skeleton } from '@gears-frontx/ui-kit';
import { SpecGraphApiService } from '../../api/SpecGraphApiService';
import type { OpenPullRequest, Review, Run } from '../../api/types';
import { place, plainThread } from '../../model/findings';
import { pullsOf } from '../../model/pulls';
import { useSpecGraphTranslations } from '../../i18n';
import styles from './SpecGraphScreen.module.css';

type Text = ReturnType<typeof useSpecGraphTranslations>['t'];

const ENDED = ['succeeded', 'failed', 'cancelled', 'interrupted'];
/** How many 25 s waits a model review is followed for: about twenty minutes. */
const MAX_WAITS = 48;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Pending {
  pull: OpenPullRequest;
  model: boolean;
}

export const PullsView: React.FC<{
  projectId: string;
  /** The repository the graph reads (`owner/name`), as `GET …/project` names it. */
  repository: string | null;
  defaultBase: string;
  t: Text;
}> = ({ projectId, repository, defaultBase, t }) => {
  const api = apiRegistry.getService(SpecGraphApiService);
  const [pulls, setPulls] = useState<OpenPullRequest[] | null>(null);
  const [base, setBase] = useState(defaultBase);
  const [pending, setPending] = useState<Pending | null>(null);
  const [review, setReview] = useState<{ pull: OpenPullRequest; review: Review; cost?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .openPullRequests({ projectId })
      .fetch({ staleTime: 0 })
      .then((r) => live && setPulls(r.items))
      .catch((e: unknown) => {
        if (!live) return;
        setPulls([]);
        setError(message(e));
      });
    return () => {
      live = false;
    };
  }, [api, projectId]);

  const start = async (pull: OpenPullRequest, model: boolean) => {
    if (!pull.source_branch) return;
    setPending({ pull, model });
    setReview(null);
    setError(null);
    try {
      const answer = await api.review(projectId).fetch({ base: base.trim(), head: pull.source_branch, model });
      if (answer.review) {
        setReview({ pull, review: answer.review });
      } else if (answer.run) {
        let run: Run = answer.run;
        for (let i = 0; i < MAX_WAITS && !ENDED.includes(run.state); i += 1) {
          run = (await api.run({ projectId, runId: run.id }).fetch({ staleTime: 0 })).run;
        }
        if (run.state !== 'succeeded' || !run.result) {
          setError(run.error ?? t('review_failed', { state: run.state }));
        } else {
          setReview({ pull, review: run.result as Review, cost: run.result.stats?.model_cost_usd });
        }
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setPending(null);
    }
  };

  if (pulls === null) return <Skeleton className={styles.skeleton} />;
  const { mine, others } = pullsOf(pulls, repository);
  return (
    <>
      <label className={styles.baseField}>
        {t('review_base')}
        <input className={styles.input} value={base} onChange={(e) => setBase(e.target.value)} />
      </label>
      {error && <p className={styles.error}>{error}</p>}
      {!repository ? (
        <p className={styles.muted}>{t('pulls_no_repository')}</p>
      ) : (
        <>
          {mine.length === 0 && <p className={styles.muted}>{t('no_pulls', { repository })}</p>}
          {others > 0 && <p className={styles.muted}>{t('pulls_other_repos', { count: others, repository })}</p>}
        </>
      )}
      <div className={styles.list}>
        {mine.map((p) => (
          <div key={p.id} className={styles.pull}>
            <div className={styles.findingHead}>
              <strong>#{p.number}</strong>
              <span>{p.title}</span>
              {p.source_branch && <code className={styles.rule}>{p.source_branch}</code>}
            </div>
            <div className={styles.rowActions}>
              <Button
                size="sm"
                variant="outline"
                disabled={!!pending || !p.source_branch || !base.trim()}
                onClick={() => void start(p, false)}
              >
                {t('review')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!!pending || !p.source_branch || !base.trim()}
                onClick={() => void start(p, true)}
              >
                {t('review_model')}
              </Button>
              {pending?.pull.id === p.id && (
                <span className={styles.muted}>{pending.model ? t('reviewing_model') : t('reviewing')}</span>
              )}
            </div>
          </div>
        ))}
      </div>
      {review && <ReviewCard pull={review.pull} review={review.review} cost={review.cost} t={t} />}
    </>
  );
};

const ReviewCard: React.FC<{ pull: OpenPullRequest; review: Review; cost?: number; t: Text }> = ({
  pull,
  review,
  cost,
  t,
}) => (
  <Card className={styles.document}>
    <CardHeader>
      <CardTitle>
        {t('review_of', { number: pull.number, head: review.head.slice(0, 12), base: review.base.slice(0, 12) })}
      </CardTitle>
    </CardHeader>
    <CardContent className={styles.list}>
      <div className={styles.chips}>
        <Badge variant={review.blocking ? 'destructive' : 'secondary'}>
          {t(review.blocking === 1 ? 'blocking_one' : 'blocking_many', { count: review.blocking })}
        </Badge>
        <Badge variant="secondary">
          {t(review.threads.length === 1 ? 'threads_one' : 'threads_many', { count: review.threads.length })}
        </Badge>
        {review.dismissed > 0 && (
          <Badge variant="outline">
            {t(review.dismissed === 1 ? 'dismissed_one' : 'dismissed_many', { count: review.dismissed })}
          </Badge>
        )}
        {cost != null && <Badge variant="outline">{t('cost', { usd: cost.toFixed(3) })}</Badge>}
      </div>
      <p className={styles.muted}>{t('review_hint')}</p>
      {review.count === 0 && <p className={styles.muted}>{t('review_clean')}</p>}
      {review.threads.map((th) => (
        <div key={th.fingerprints.join(',')} className={styles.finding} data-gate={th.gate}>
          <div className={styles.findingHead}>
            <Badge variant={th.gate === 'block' ? 'destructive' : 'secondary'}>
              {th.gate === 'block' ? t('gate_block') : t('gate_advise')}
            </Badge>
            <code>{place(th.path, { section: null, line_start: th.start_line ?? th.line, line_end: th.line, quote: null })}</code>
            <code className={styles.rule}>{th.rule}</code>
          </div>
          <pre className={styles.thread}>{plainThread(th.body)}</pre>
        </div>
      ))}
      {review.outside_diff.length > 0 && (
        <>
          <p className={styles.muted}>{t('outside_diff')}</p>
          <ul className={styles.related}>
            {review.outside_diff.map((f) => (
              <li key={f.id}>
                <code>{f.rule}</code> {f.message}
              </li>
            ))}
          </ul>
        </>
      )}
    </CardContent>
  </Card>
);
