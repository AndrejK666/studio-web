/**
 * Project › Gear match, the Gears matcher kit's (ADR-0072; it was a section
 * of Project › Product), docs/design/product-gear-match.md: ask the
 * gears-matcher service which gears cover the project's specifications, and
 * act on what it says, requirement by requirement —
 *
 * - a covered or partial requirement's candidate goes into the product only
 *   through "Add to product": the engine's completion with the pick added,
 *   then the product's save, as the configurator does; Accept/Reject is kept;
 * - a gap opens "Create a gear" (the Components tab's ScaffoldDialog), drafted
 *   from the requirement's passage;
 * - a question is answered here (and waits in the Inbox until it is); the
 *   next run reads the answer beside the requirement.
 *
 * Every run is kept (the matcher's results vary): the history lists them and
 * two can be compared.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Input, Skeleton, Textarea } from '@gears-frontx/ui-kit';
import { isNotFound, responseStatus } from '@constructor-studio/mfe-shared';
import { productApi } from '../../../api/client';
import {
  addability,
  byAction,
  coverageTone,
  filtered,
  gapDraft,
  isRunning,
  progressOf,
  shortId,
  specPlanGears,
  type GearMatch,
  type GearMatchCandidate,
  type GearMatchDiff,
  type GearMatchItem,
  type GearMatchQuestion,
  type GearMatchRequirement,
} from '../../../model/gear-match';
import { useMatchTranslations } from '../../../i18n';
import { EmptyState, errText, Segmented, StatusChip, useScope } from '../../common';
import { ScaffoldDialog } from '../../components/ScaffoldDialog';
import { useGearCatalogue } from '../catalogue';
import styles from './match.module.css';
import page from '../../product.module.css';

const POLL_MS = 4000;
const FILTERS = ['all', 'covered', 'partial', 'gap', 'clarification_needed', 'not_assessed'] as const;
type Filter = (typeof FILTERS)[number];

type T = (key: string, params?: Record<string, string>) => string;

export function GearMatchSection() {
  const { projectId } = useScope();
  const { t } = useMatchTranslations();
  const [history, setHistory] = useState<GearMatchItem[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [match, setMatch] = useState<GearMatch | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [paths, setPaths] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [diff, setDiff] = useState<GearMatchDiff | 'none' | null>(null);
  const [round, setRound] = useState(0);
  const [picks, setPicks] = useState<string[]>([]);
  const [planGears, setPlanGears] = useState<Set<string>>(new Set());
  const [scaffold, setScaffold] = useState<GearMatchRequirement | null>(null);
  const catalogue = useGearCatalogue(true, projectId);
  const catalogueNames = useMemo(
    () => (catalogue && 'index' in catalogue ? new Set(catalogue.index.gears.map((g) => catalogue.index.name(g))) : null),
    [catalogue]
  );

  // The history and the product's picks; the spec plan, to say where the two agree.
  useEffect(() => {
    let live = true;
    productApi.gearMatches(projectId).then(
      (r) => {
        if (!live) return;
        setHistory(r.items);
        setUnavailable(null);
      },
      (e: unknown) => {
        if (!live) return;
        if (responseStatus(e) === 503) setUnavailable(errText(e));
        else setError(errText(e));
        setHistory([]);
      }
    );
    productApi.projectProduct(projectId).then(
      (p) => live && setPicks(p?.gears ?? []),
      () => undefined
    );
    return () => {
      live = false;
    };
  }, [projectId, round]);

  useEffect(() => {
    let live = true;
    productApi.projectPlan(projectId).then(
      (p) => live && setPlanGears(specPlanGears(p.items)),
      () => undefined
    );
    return () => {
      live = false;
    };
  }, [projectId]);

  const shown = selected ?? history?.[0]?.match_id ?? null;

  // The match on screen, read again every few seconds while it runs.
  useEffect(() => {
    if (!shown) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () =>
      productApi.gearMatch(projectId, shown).then(
        (m) => {
          if (!live) return;
          setMatch(m);
          if (isRunning(m.summary.state)) timer = setTimeout(read, POLL_MS);
          else if (history?.some((h) => h.match_id === m.summary.match_id && isRunning(h.state))) setRound((r) => r + 1);
        },
        (e: unknown) => {
          if (live && !isNotFound(e)) setError(errText(e));
        }
      );
    void read();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [projectId, shown, history]);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const list = paths
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      const r = await productApi.startGearMatch(projectId, {
        paths: list.length ? list : undefined,
        idempotency_key: crypto.randomUUID(),
      });
      setSelected(r.match_id);
      setDiff(null);
      setRound((n) => n + 1);
    } catch (e) {
      if (responseStatus(e) === 503) setUnavailable(errText(e));
      else setError(errText(e));
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    if (!match) return;
    try {
      await productApi.cancelGearMatch(projectId, match.summary.match_id);
      setRound((n) => n + 1);
    } catch (e) {
      setError(errText(e));
    }
  };

  const compare = async () => {
    if (!match) return;
    try {
      setDiff(await productApi.gearMatchDiff(projectId, match.summary.match_id));
    } catch (e) {
      if (isNotFound(e)) setDiff('none');
      else setError(errText(e));
    }
  };

  const refresh = useCallback(() => setRound((n) => n + 1), []);

  if (history === null) return <Skeleton className={page.skeleton} />;

  const running = match ? isRunning(match.summary.state) : false;
  const reqs = match ? byAction(filtered(match.requirements, filter)) : [];
  const byRequirement = new Map((match?.questions ?? []).filter((q) => q.requirement_id).map((q) => [q.requirement_id!, q]));
  const general = (match?.questions ?? []).filter((q) => !q.requirement_id);

  return (
    <div className={styles.section} data-gear-match>
      <p className={page.muted}>{t('lead')}</p>
      {unavailable ? (
        <p className={page.error} data-gear-match-unavailable>
          {t('unavailable', { reason: unavailable })}
        </p>
      ) : (
        <div className={styles.bar}>
          <label className={styles.paths}>
            <span className={page.small}>{t('paths_label')}</span>
            <Input value={paths} onChange={(e) => setPaths(e.target.value)} placeholder={t('paths_hint')} />
          </label>
          <Button type="button" onClick={() => void start()} disabled={starting || running} data-gear-match-start>
            {starting ? t('starting') : history.length ? t('rerun') : t('start')}
          </Button>
          {running && match && (
            <Button type="button" variant="outline" onClick={() => void cancel()} disabled={match.summary.state === 'cancelling'}>
              {match.summary.state === 'cancelling' ? t('cancelling') : t('cancel')}
            </Button>
          )}
        </div>
      )}
      {error && <p className={page.error}>{t('error', { error })}</p>}
      {history.length === 0 && !unavailable ? (
        <EmptyState title={t('none_title')} body={t('none_body')} />
      ) : (
        <div className={styles.layout}>
          <div className={styles.section}>
            {match && <MatchHeader match={match} t={t} />}
            {diff && <DiffView diff={diff} history={history} t={t} />}
            {match && !running && match.requirements.length > 0 && (
              <Segmented
                label={t('filter_label')}
                value={filter}
                onChange={setFilter}
                dataAttr="data-gear-match-filter"
                items={FILTERS.map((f) => ({
                  id: f,
                  label:
                    f === 'all'
                      ? t('filter_all')
                      : `${t(`coverage_${f}`)} ${match.requirements.filter((r) => r.coverage === f).length}`,
                }))}
              />
            )}
            {reqs.map((r) => (
              <RequirementCard
                key={r.requirement_id}
                r={r}
                match={match!}
                question={byRequirement.get(r.requirement_id)}
                picks={picks}
                catalogue={catalogueNames}
                planGears={planGears}
                onPicks={setPicks}
                onCreateGear={setScaffold}
                onChanged={refresh}
                t={t}
              />
            ))}
            {general.length > 0 && (
              <div className={page.card}>
                <b>{t('report_questions')}</b>
                {general.map((q) => (
                  <QuestionForm key={q.id} q={q} matchId={match!.summary.match_id} t={t} />
                ))}
              </div>
            )}
          </div>
          <aside className={styles.history} data-gear-match-history>
            <b>{t('history')}</b>
            {history.map((h) => (
              <button
                key={h.match_id}
                type="button"
                className={styles.run}
                data-on={h.match_id === shown}
                onClick={() => {
                  setSelected(h.match_id);
                  setDiff(null);
                }}
              >
                <span>{new Date(h.created_at).toLocaleString()}</span>
                <span className={page.small}>
                  {t(`state_${h.state}`)}
                  {h.totals ? ` · ${t('totals', { requirements: String(h.totals.requirements) })}` : ''}
                </span>
              </button>
            ))}
            {match && !running && history.length > 1 && (
              <Button type="button" variant="outline" size="sm" onClick={() => void compare()} data-gear-match-compare>
                {t('compare')}
              </Button>
            )}
          </aside>
        </div>
      )}
      {scaffold && (
        <ScaffoldDialogFor r={scaffold} onClose={() => setScaffold(null)} />
      )}
    </div>
  );
}

function ScaffoldDialogFor({ r, onClose }: { r: GearMatchRequirement; onClose: () => void }) {
  const { projectId, container } = useScope();
  const draft = gapDraft(r);
  return (
    <ScaffoldDialog
      capability={draft.name}
      projectId={projectId}
      problem={draft.problem}
      lead={r.requirement_id}
      container={container}
      onClose={onClose}
    />
  );
}

function MatchHeader({ match, t }: { match: GearMatch; t: T }) {
  const s = match.summary;
  const progress = progressOf(s);
  return (
    <div className={page.card} data-gear-match-summary={s.state}>
      <div className={styles.head}>
        <StatusChip tone={isRunning(s.state) ? 'running' : s.state === 'failed' ? 'danger' : s.state === 'succeeded' ? 'ok' : 'warn'}>
          {t(`state_${s.state}`)}
        </StatusChip>
        {isRunning(s.state) && (
          <span className={page.muted}>
            {progress ? t('progress', { done: String(progress.done), total: String(progress.total) }) : t('waiting')}
          </span>
        )}
        {s.totals && (
          <>
            <span>{t('totals', { requirements: String(s.totals.requirements) })}</span>
            {(['covered', 'partial', 'gap', 'clarification_needed', 'not_assessed'] as const).map((k) =>
              s.totals && s.totals[k] > 0 ? (
                <StatusChip key={k} tone={coverageTone(k)} data-gear-match-total={k}>
                  {`${t(`coverage_${k}`)} ${s.totals[k]}`}
                </StatusChip>
              ) : null
            )}
          </>
        )}
      </div>
      {s.error && <p className={page.error}>{t('failed', { error: s.error })}</p>}
      <div className={`${page.row} ${page.small} ${page.muted}`}>
        <span>{t('documents')}</span>
        {match.documents.map((d) => (
          <code key={d.path} className={page.code} title={`${d.sha256}${d.commit ? ` @ ${d.commit}` : ''}`}>
            {d.path}
            {d.commit ? `@${d.commit.slice(0, 7)}` : ''}
          </code>
        ))}
        {match.catalogue_commit && <span>{t('catalogue', { commit: match.catalogue_commit.slice(0, 8) })}</span>}
        {match.usage?.calls != null && <span>{t('usage', { calls: String(match.usage.calls) })}</span>}
      </div>
    </div>
  );
}

function DiffView({ diff, history, t }: { diff: GearMatchDiff | 'none'; history: GearMatchItem[]; t: T }) {
  if (diff === 'none') return <p className={page.muted}>{t('compare_none')}</p>;
  const base = history.find((h) => h.match_id === diff.base);
  return (
    <div className={page.card} data-gear-match-diff>
      <b>{t('diff_title', { date: base ? new Date(base.created_at).toLocaleString() : diff.base })}</b>
      {diff.changes.length === 0 ? (
        <span>{t('diff_none')}</span>
      ) : (
        diff.changes.map((c) => (
          <span key={c.requirement_id} className={page.small}>
            {t('diff_line', {
              id: shortId(c.requirement_id),
              before: c.before ? t(`coverage_${c.before}`) : '—',
              after: c.after ? t(`coverage_${c.after}`) : '—',
            })}
            {c.gears_after.join(',') !== c.gears_before.join(',') &&
              ` (${c.gears_before.map((g) => g.split('/').pop()).join(', ') || '—'} → ${c.gears_after.map((g) => g.split('/').pop()).join(', ') || '—'})`}
          </span>
        ))
      )}
      <span className={page.muted}>{t('diff_same', { count: String(diff.same) })}</span>
    </div>
  );
}

function RequirementCard({
  r,
  match,
  question,
  picks,
  catalogue,
  planGears,
  onPicks,
  onCreateGear,
  onChanged,
  t,
}: {
  r: GearMatchRequirement;
  match: GearMatch;
  question?: GearMatchQuestion;
  picks: string[];
  catalogue: Set<string> | null;
  planGears: Set<string>;
  onPicks: (p: string[]) => void;
  onCreateGear: (r: GearMatchRequirement) => void;
  onChanged: () => void;
  t: T;
}) {
  return (
    <div className={styles.requirement} data-gear-match-requirement={r.requirement_id} data-action={r.action}>
      <div className={styles.head}>
        <code className={styles.id} title={r.requirement_id}>
          {shortId(r.requirement_id)}
        </code>
        <StatusChip tone={coverageTone(r.coverage)}>{t(`coverage_${r.coverage}`)}</StatusChip>
        {r.action !== 'none' && <span className={page.muted}>{t(`action_${r.action}`)}</span>}
        {r.action === 'create_gear' && (
          <Button type="button" size="sm" variant="outline" onClick={() => onCreateGear(r)} data-gear-match-create>
            {t('create_gear')}
          </Button>
        )}
      </div>
      {r.reason && <span className={page.small}>{r.reason}</span>}
      {r.passage ? (
        <details>
          <summary className={page.small}>{t('passage', { path: r.passage.path, line: String(r.passage.line) })}</summary>
          <pre className={styles.passage}>{r.passage.text}</pre>
        </details>
      ) : (
        <span className={`${page.small} ${page.muted}`}>{t('no_passage')}</span>
      )}
      {r.candidates.length > 0 &&
        r.candidates
          .filter((c) => c.verdict !== 'none' || r.candidates.length === 1)
          .map((c) => (
            <CandidateRow
              key={c.gear_id}
              c={c}
              r={r}
              match={match}
              picks={picks}
              catalogue={catalogue}
              inPlan={planGears.has(c.pick)}
              onPicks={onPicks}
              onChanged={onChanged}
              t={t}
            />
          ))}
      {question && <QuestionForm q={question} matchId={match.summary.match_id} t={t} />}
    </div>
  );
}

function CandidateRow({
  c,
  r,
  match,
  picks,
  catalogue,
  inPlan,
  onPicks,
  onChanged,
  t,
}: {
  c: GearMatchCandidate;
  r: GearMatchRequirement;
  match: GearMatch;
  picks: string[];
  catalogue: Set<string> | null;
  inPlan: boolean;
  onPicks: (p: string[]) => void;
  onChanged: () => void;
  t: T;
}) {
  const { projectId } = useScope();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const can = addability(c, picks, catalogue);

  const decide = (decision: 'accepted' | 'rejected' | 'undecided') =>
    productApi.putGearMatchDecision(projectId, {
      requirement_id: r.requirement_id,
      gear_id: c.gear_id,
      decision,
      match_id: match.summary.match_id,
    });

  // The product's own completion with the pick added, then its save: what the
  // configurator does when a gear is picked.
  const add = async () => {
    setBusy(true);
    setErr(null);
    try {
      const record = await productApi.projectProduct(projectId);
      const current = record?.gears ?? [];
      const done = await productApi.completeProduct([...current, c.pick], record?.config ?? {});
      await productApi.saveProjectProduct(projectId, {
        product_id: record?.product_id ?? match.product,
        name: record?.name,
        gears: done.gears,
        config: done.config,
      });
      await decide('accepted');
      onPicks(done.gears);
      const changes = done.changes.filter((x) => x.gear !== c.pick).map((x) => `${x.added ? '+' : '−'}${x.gear}`);
      setNote(changes.length ? t('added', { gear: c.pick, changes: changes.join(', ') }) : t('added_plain', { gear: c.pick }));
      onChanged();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const reject = async (decision: 'rejected' | 'undecided') => {
    setBusy(true);
    try {
      await decide(decision);
      onChanged();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.candidate} data-gear-match-candidate={c.gear_id}>
      <div className={styles.head}>
        <b>{c.name ?? c.pick}</b>
        <code className={page.small}>{c.gear_id}</code>
        <Badge variant={c.verdict === 'covered' ? 'success' : c.verdict === 'partial' ? 'warning' : 'secondary'}>{c.verdict}</Badge>
        {c.confidence != null && <span className={page.small}>{t('confidence', { value: c.confidence.toFixed(2) })}</span>}
        {c.in_code === false && <Badge variant="secondary">{t('future_part')}</Badge>}
        {inPlan && <Badge variant="info">{t('in_spec_plan')}</Badge>}
        {c.decision === 'accepted' && <Badge variant="success">{t('accepted')}</Badge>}
        {c.decision === 'rejected' && <Badge variant="secondary">{t('rejected')}</Badge>}
        {c.proposed && (
          <>
            {can === 'in' ? (
              <span className={page.muted}>{t('in_product')}</span>
            ) : can === 'add' ? (
              <Button type="button" size="sm" onClick={() => void add()} disabled={busy} data-gear-match-add>
                {busy ? t('adding') : t('add')}
              </Button>
            ) : (
              <span className={page.muted}>{t('not_in_catalogue')}</span>
            )}
            {c.decision ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => void reject('undecided')} disabled={busy}>
                {t('undo')}
              </Button>
            ) : (
              <Button type="button" size="sm" variant="outline" onClick={() => void reject('rejected')} disabled={busy} data-gear-match-reject>
                {t('reject')}
              </Button>
            )}
          </>
        )}
      </div>
      <dl className={styles.facts}>
        {c.evidence && (
          <>
            <dt>{t('evidence')}</dt>
            <dd>{c.evidence}</dd>
          </>
        )}
        {c.covers && (
          <>
            <dt>{t('covers')}</dt>
            <dd>{c.covers}</dd>
          </>
        )}
        {c.missing && (
          <>
            <dt>{t('missing')}</dt>
            <dd>{c.missing}</dd>
          </>
        )}
        {c.rationale && (
          <>
            <dt>{t('rationale')}</dt>
            <dd>{c.rationale}</dd>
          </>
        )}
      </dl>
      {note && <span className={page.small}>{note}</span>}
      {err && <span className={page.error}>{err}</span>}
    </div>
  );
}

function QuestionForm({ q, matchId, t }: { q: GearMatchQuestion; matchId: string; t: T }) {
  const { projectId } = useScope();
  const [text, setText] = useState(q.answer ?? '');
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setErr(null);
    try {
      await productApi.putGearMatchAnswer(projectId, {
        question_id: q.id,
        text,
        topic: q.requirement_id ? undefined : q.topic,
        match_id: matchId,
      });
      setSaved(true);
    } catch (e) {
      setErr(errText(e));
    }
  };
  return (
    <div className={styles.answer} data-gear-match-question={q.id}>
      <span className={page.small}>
        <b>{t('question')}</b> {q.requirement_id ? q.reason : `${q.topic}: ${q.reason}`}
      </span>
      {!q.requirement_id && q.quote && <pre className={styles.passage}>{q.quote}</pre>}
      <Textarea rows={2} value={text} aria-label={t('answer_label')} onChange={(e) => setText(e.target.value)} />
      <div className={page.row}>
        <Button type="button" size="sm" onClick={() => void save()} disabled={!text.trim()} data-gear-match-answer>
          {t('answer_save')}
        </Button>
        {saved && <span className={page.muted}>{t('answer_saved')}</span>}
        {q.answered_by && !saved && <span className={page.muted}>{t('answered_by')}</span>}
        {err && <span className={page.error}>{err}</span>}
      </div>
    </div>
  );
}
