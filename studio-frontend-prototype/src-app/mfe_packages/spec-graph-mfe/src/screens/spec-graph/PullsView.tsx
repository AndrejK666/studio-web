/**
 * Project › Spec graph › Pull requests: review an open pull request as the
 * spec-graph service's CI does. The deterministic review answers in seconds;
 * with the model it is a run on the service (minutes, model cost) that this
 * view follows to its end. Either way the answer is the findings the pull
 * request brings and the threads CI would post on its head, shown here: Studio
 * does not post them on the pull request yet.
 *
 * Each pull request's latest review (deterministic, or with the model) is read
 * back from the service, so a reload shows it again; a review with the model
 * still going is picked up and followed, its stage and count shown as it goes.
 *
 * Only the pull requests of the repository the graph reads are listed: a review
 * names branches, not a repository, so another repository's pull request with
 * the same branch name would be reviewed against the wrong code.
 */

import React, { useEffect, useRef, useState } from 'react';
import { apiRegistry } from '@gears-frontx/react';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Skeleton } from '@gears-frontx/ui-kit';
import { SpecGraphApiService } from '../../api/SpecGraphApiService';
import type { OpenPullRequest, Review, ReviewRecord, Run } from '../../api/types';
import { place, plainThread } from '../../model/findings';
import { pullsOf } from '../../model/pulls';
import { ended, lastSucceeded } from '../../model/runs';
import { runLine } from './GraphStatus';
import { useSpecGraphTranslations } from '../../i18n';
import styles from './SpecGraphScreen.module.css';
import { kitAbsent, refusalText, type KitAbsence } from '@constructor-studio/mfe-shared';
import { KitAbsentState } from '@constructor-studio/mfe-shared/page';

type Text = ReturnType<typeof useSpecGraphTranslations>['t'];

/** How many 5 s waits a model review is followed for: about forty minutes. */
const MAX_WAITS = 480;

// The gear's own sentence (a 503 names what to configure), not the transport's status line.
const message = (e: unknown) => refusalText(e) ?? (e instanceof Error ? e.message : String(e));

interface Pending {
  pull: OpenPullRequest;
  model: boolean;
  /** The model run being followed, as last read. */
  run?: Run;
}

/** The newest record of each kind for each head branch. */
function latestByHead(records: readonly ReviewRecord[]): Map<string, { review?: ReviewRecord; model?: ReviewRecord }> {
  const out = new Map<string, { review?: ReviewRecord; model?: ReviewRecord }>();
  for (const r of records) {
    const e = out.get(r.head) ?? {};
    if (!e[r.kind] || (r.at ?? '') > (e[r.kind]?.at ?? '')) e[r.kind] = r;
    out.set(r.head, e);
  }
  return out;
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
  // The open pull requests are Git collaboration's (studio-artifact-ingest): without it there are none to review.
  const [absent, setAbsent] = useState<KitAbsence | null>(null);
  const [records, setRecords] = useState<ReviewRecord[]>([]);
  const [prepared, setPrepared] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    api
      .openPullRequests({ projectId })
      .fetch({ staleTime: 0 })
      .then((r) => live && setPulls(r.items))
      .catch((e: unknown) => {
        if (!live) return;
        setPulls([]);
        const why = kitAbsent(e, { kit: 'project-git' });
        if (why) setAbsent(why);
        else setError(message(e));
      });
    return () => {
      live = false;
    };
  }, [api, projectId]);

  // The latest reviews, and whether model reviews are prepared (a `prepare` run succeeded).
  useEffect(() => {
    let live = true;
    api
      .reviews({ projectId })
      .fetch({ staleTime: 0 })
      .then((r) => live && setRecords(r.items))
      .catch(() => undefined);
    api
      .runs({ projectId, job: 'prepare' })
      .fetch({ staleTime: 0 })
      .then((r) => live && setPrepared(!!lastSucceeded(r.items)))
      .catch(() => live && setPrepared(null));
    return () => {
      live = false;
    };
  }, [api, projectId]);

  /** Follow a model run to its end, showing its stage as it goes. */
  const follow = async (pull: OpenPullRequest, first: Run) => {
    let run = first;
    setPending({ pull, model: true, run });
    for (let i = 0; i < MAX_WAITS && !ended(run); i += 1) {
      run = (await api.run({ projectId, runId: run.id }).fetch({ staleTime: 0 })).run;
      setPending({ pull, model: true, run });
    }
    if (run.state !== 'succeeded' || !run.result) {
      setError(run.error ?? t('review_failed', { state: run.state }));
    } else {
      setReview({ pull, review: run.result as Review, cost: run.result.stats?.model_cost_usd });
    }
  };

  // A model review still going (started before a reload, or elsewhere) is picked up.
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current || pending || !pulls || !records.length) return;
    resumed.current = true;
    const going = records.find((r) => r.kind === 'model' && r.run && !ended(r.run));
    const pull = going && pulls.find((p) => p.source_branch === going.head);
    const run = going?.run;
    if (run && pull) {
      // after this render: following sets the row's state
      void Promise.resolve()
        .then(() => follow(pull, run))
        .catch((e: unknown) => setError(message(e)))
        .finally(() => setPending(null));
    }
  }, [records, pulls]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async (pull: OpenPullRequest, model: boolean) => {
    if (!pull.source_branch) return;
    setPending({ pull, model });
    setReview(null);
    setError(null);
    try {
      const answer = await api.review(projectId).fetch({ base: base.trim(), head: pull.source_branch, model });
      if (answer.review) {
        setReview({ pull, review: answer.review });
        const head = pull.source_branch;
        setRecords((rs) => [
          { kind: 'review', base: base.trim(), head, at: new Date().toISOString(), result: answer.review as Review },
          ...rs.filter((r) => !(r.kind === 'review' && r.head === head)),
        ]);
      } else if (answer.run) {
        await follow(pull, answer.run);
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setPending(null);
    }
  };

  /** Show a pull request's latest kept review again. */
  const showLast = (pull: OpenPullRequest, r: ReviewRecord) => {
    if (r.kind === 'review' && r.result) setReview({ pull, review: r.result });
    else if (r.run?.state === 'succeeded' && r.run.result)
      setReview({ pull, review: r.run.result as Review, cost: r.run.result.stats?.model_cost_usd });
    else if (r.run) setError(r.run.error ?? t('review_failed', { state: r.run.state }));
  };

  if (pulls === null) return <Skeleton className={styles.skeleton} />;
  if (absent) return <KitAbsentState absence={absent} compact />;
  const { mine, others } = pullsOf(pulls, repository);
  const last = latestByHead(records);
  return (
    <>
      <label className={styles.baseField}>
        {t('review_base')}
        <input className={styles.input} value={base} onChange={(e) => setBase(e.target.value)} />
      </label>
      {prepared === false && <p className={styles.muted}>{t('pulls_not_prepared')}</p>}
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
                <span className={styles.muted}>
                  {pending.model
                    ? pending.run
                      ? t('reviewing_model_at', { line: runLine(pending.run, t) })
                      : t('reviewing_model')
                    : t('reviewing')}
                  {pending.run && !ended(pending.run) && (
                    <Button
                      size="sm"
                      variant="link"
                      onClick={() => {
                        const run = pending.run;
                        if (run) void api.cancelRun(projectId, run.id).fetch({}).catch((e: unknown) => setError(message(e)));
                      }}
                    >
                      {t('run_cancel')}
                    </Button>
                  )}
                </span>
              )}
              {pending?.pull.id !== p.id &&
                review?.pull.id !== p.id &&
                p.source_branch &&
                (['review', 'model'] as const).map((kind) => {
                  const r = last.get(p.source_branch ?? '')?.[kind];
                  if (!r) return null;
                  const threads = r.result?.threads?.length ?? r.run?.result?.threads?.length;
                  const what =
                    r.kind === 'model' && r.run && !ended(r.run)
                      ? t('last_running')
                      : r.kind === 'model' && r.run?.state !== 'succeeded'
                        ? t(`state_${r.run?.state ?? 'failed'}`)
                        : t(threads === 1 ? 'threads_one' : 'threads_many', { count: threads ?? 0 });
                  return (
                    <Button key={kind} size="sm" variant="link" onClick={() => showLast(p, r)}>
                      {t(kind === 'model' ? 'last_model' : 'last_review', { what, at: (r.at ?? '').slice(0, 16).replace('T', ' ') })}
                    </Button>
                  );
                })}
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
