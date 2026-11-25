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
 *
 * The report itself is on the kit's DataGrid (MatchReportGrids), by
 * requirement or by gear; the view is kept in the address (`gmv.f.view`).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, NativeSelect, NativeSelectOption, Skeleton, Textarea } from '@gears-frontx/ui-kit';
import { isNotFound, readListState, responseStatus, writeListState } from '@constructor-studio/mfe-shared';
import {
  coverageTone,
  failureHint,
  gapDraft,
  isRunning,
  progressOf,
  shortId,
  specPlanGears,
  type GearMatch,
  type GearMatchDiff,
  type GearMatchItem,
  type GearMatchQuestion,
  type GearMatchRequirement,
} from '../../../model/gear-match';
import { MATCH_VIEWS, viewOf, type MatchView } from '../../../model/gear-match-grid';
import { offeredStrategies, SHIPPED_SERVICE, type StrategyKit } from '../../../model/assembly';
import { useMatchTranslations } from '../../../i18n';
import { EmptyState, errText, Segmented, StatusChip, useScope, useProductApi } from '../../common';
import { ScaffoldDialog } from '../../components/ScaffoldDialog';
import { catalogueNames, pickNames } from '../../../model/product-configurator';
import { useGearCatalogue } from '../catalogue';
import { GearGrid, RequirementGrid, type MatchCells, type MatchDecision } from './MatchReportGrids';
import styles from './match.module.css';
import page from '../../product.module.css';

const POLL_MS = 4000;

/** The address prefix the chosen view is kept under, as a list keeps its filters. */
export const VIEW_PREFIX = 'gmv.';

function replaceSearch(search: string): void {
  if (search === window.location.search) return;
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${search}${window.location.hash}`);
}

/** The view the address names, and a setter that writes it back (taken out again when the screen goes). */
function useAddressView(): [MatchView, (v: MatchView) => void] {
  const [view, setView] = useState<MatchView>(() =>
    typeof window === 'undefined' ? 'requirement' : viewOf(readListState(window.location.search, VIEW_PREFIX).filters.view)
  );
  const choose = useCallback((v: MatchView) => {
    setView(v);
    const state = readListState(window.location.search, VIEW_PREFIX);
    const filters = { ...state.filters };
    if (v === 'requirement') delete filters.view;
    else filters.view = v;
    replaceSearch(writeListState(window.location.search, { ...state, filters }, VIEW_PREFIX));
  }, []);
  useEffect(
    () => () => replaceSearch(writeListState(window.location.search, readListState('', VIEW_PREFIX), VIEW_PREFIX)),
    []
  );
  return [view, choose];
}

type T = (key: string, params?: Record<string, string>) => string;

export function GearMatchSection() {
  const { projectId } = useScope();
  return <ProjectGearMatch key={projectId} projectId={projectId} />;
}

function ProjectGearMatch({ projectId }: { projectId: string }) {
  const productApi = useProductApi();
  const { t } = useMatchTranslations();
  const [strategies, setStrategies] = useState<StrategyKit[]>([]);
  const [strategy, setStrategy] = useState(SHIPPED_SERVICE);
  const [history, setHistory] = useState<GearMatchItem[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [match, setMatch] = useState<GearMatch | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [paths, setPaths] = useState('');
  const [view, setView] = useAddressView();
  const [answering, setAnswering] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [diff, setDiff] = useState<GearMatchDiff | 'none' | null>(null);
  const [round, setRound] = useState(0);
  const [picks, setPicks] = useState<string[]>([]);
  const [planGears, setPlanGears] = useState<Set<string>>(new Set());
  const [scaffold, setScaffold] = useState<GearMatchRequirement | null>(null);
  const catalogue = useGearCatalogue(true, projectId);
  const index = catalogue && 'index' in catalogue ? catalogue.index : null;
  const knownNames = useMemo(() => (index ? catalogueNames(index) : null), [index]);
  // The product's picks under every spelling the catalogue has (id or crate).
  const pickedNames = useMemo(() => pickNames(picks, index), [picks, index]);
  // Omitting the shipped strategy preserves older servers' default route.
  const strategyParam = strategy === SHIPPED_SERVICE ? undefined : strategy;

  useEffect(() => {
    let live = true;
    productApi.assemblyStrategy(projectId).then(
      (settings) => live && setStrategies(offeredStrategies(settings).filter((kit) => kit.service)),
      () => undefined
    );
    return () => {
      live = false;
    };
  }, [projectId, productApi]);

  // The history and the product's picks; the spec plan, to say where the two agree.
  useEffect(() => {
    let live = true;
    productApi.gearMatches(projectId, strategyParam).then(
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
  }, [projectId, round, strategyParam, productApi]);

  useEffect(() => {
    let live = true;
    productApi.projectPlan(projectId).then(
      (p) => live && setPlanGears(specPlanGears(p.items)),
      () => undefined
    );
    return () => {
      live = false;
    };
  }, [projectId, productApi]);

  const shown = selected ?? history?.[0]?.match_id ?? null;

  // The match on screen, read again every few seconds while it runs.
  useEffect(() => {
    if (!shown) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () =>
      productApi.gearMatch(projectId, shown, strategyParam).then(
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
  }, [projectId, shown, history, strategyParam, productApi]);

  const start = async () => {
    setStarting(true);
    setError(null);
    // The run on screen gives way to the new one: its failure must not read
    // as the new run's while it starts.
    setMatch(null);
    try {
      const list = paths
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      const r = await productApi.startGearMatch(
        projectId,
        { paths: list.length ? list : undefined, idempotency_key: crypto.randomUUID() },
        strategyParam
      );
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

  // Add to product: the product's own completion with the pick added, then its
  // save, as the configurator does; the decisions it answers are accepted.
  const add = useCallback(
    async (key: string, pick: string, decisions: MatchDecision[]) => {
      if (!match) return;
      setBusy(`add:${key}`);
      setStatus(null);
      try {
        const record = await productApi.projectProduct(projectId);
        const current = record?.gears ?? [];
        const done = await productApi.completeProduct([...current, pick], record?.config ?? {});
        await productApi.saveProjectProduct(projectId, {
          product_id: record?.product_id ?? match.product,
          name: record?.name,
          gears: done.gears,
          config: done.config,
        });
        await Promise.all(
          decisions.map((d) =>
            productApi.putGearMatchDecision(projectId, { ...d, decision: 'accepted', match_id: match.summary.match_id })
          )
        );
        setPicks(done.gears);
        const changes = done.changes.filter((x) => x.gear !== pick).map((x) => `${x.added ? '+' : '−'}${x.gear}`);
        setStatus({
          ok: true,
          text: changes.length ? t('added', { gear: pick, changes: changes.join(', ') }) : t('added_plain', { gear: pick }),
        });
        refresh();
      } catch (e) {
        setStatus({ ok: false, text: errText(e) });
      } finally {
        setBusy(null);
      }
    },
    [match, projectId, t, refresh, productApi]
  );

  const decide = useCallback(
    async (key: string, decisions: MatchDecision[], decision: 'rejected' | 'undecided') => {
      if (!match) return;
      setBusy(`decide:${key}`);
      setStatus(null);
      try {
        await Promise.all(
          decisions.map((d) => productApi.putGearMatchDecision(projectId, { ...d, decision, match_id: match.summary.match_id }))
        );
        refresh();
      } catch (e) {
        setStatus({ ok: false, text: errText(e) });
      } finally {
        setBusy(null);
      }
    },
    [match, projectId, refresh, productApi]
  );

  const cells = useMemo<MatchCells>(
    () => ({
      t,
      picks: pickedNames,
      catalogue: knownNames,
      planGears,
      busy,
      add: (key, pick, decisions) => void add(key, pick, decisions),
      decide: (key, decisions, decision) => void decide(key, decisions, decision),
      createGear: setScaffold,
      answer: (r) => setAnswering(r.requirement_id),
    }),
    [t, pickedNames, knownNames, planGears, busy, add, decide]
  );

  if (history === null) return <Skeleton className={page.skeleton} />;

  const running = match ? isRunning(match.summary.state) : false;
  const byRequirement = new Map((match?.questions ?? []).filter((q) => q.requirement_id).map((q) => [q.requirement_id!, q]));
  const general = (match?.questions ?? []).filter((q) => !q.requirement_id);
  const question = answering ? byRequirement.get(answering) : undefined;
  const report = match && !running && match.requirements.length > 0;
  const otherStrategies = strategies.filter((kit) => kit.id !== SHIPPED_SERVICE);
  const activeStrategy = strategies.find((kit) => kit.id === strategy);

  return (
    <div className={styles.section} data-gear-match>
      <p className={page.muted}>{t('lead')}</p>
      {otherStrategies.length > 0 && (
        <label className={styles.paths}>
          <span className={page.small}>{t('strategy_label')}</span>
          <NativeSelect
            value={strategy}
            onChange={(e) => {
              setStrategy(e.target.value);
              setHistory(null);
              setSelected(null);
              setMatch(null);
              setUnavailable(null);
              setError(null);
              setStatus(null);
              setDiff(null);
              setAnswering(null);
              setScaffold(null);
            }}
            disabled={starting || busy !== null}
          >
            <NativeSelectOption value={SHIPPED_SERVICE}>{t('strategy_shipped')}</NativeSelectOption>
            {otherStrategies.map((kit) => (
              <NativeSelectOption key={kit.id} value={kit.id} disabled={!kit.offered}>
                {kit.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      )}
      {activeStrategy?.offered === false && activeStrategy.reason && (
        <p className={page.muted}>{activeStrategy.reason}</p>
      )}
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
          <Button
            type="button"
            onClick={() => void start()}
            disabled={starting || running || activeStrategy?.offered === false}
            data-gear-match-start
          >
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
          <div className={styles.main}>
            {match && <MatchHeader match={match} t={t} />}
            {diff && <DiffView diff={diff} history={history} t={t} />}
          </div>
          <aside className={styles.history} data-gear-match-history>
            <b>{t('history')}</b>
            {history.map((h) => {
              // The run on screen is read every few seconds; its row says what that read says.
              const live = match?.summary.match_id === h.match_id ? match.summary : h;
              return (
                <button
                  key={h.match_id}
                  type="button"
                  className={styles.run}
                  data-on={h.match_id === shown}
                  onClick={() => {
                    setSelected(h.match_id);
                    setDiff(null);
                    setAnswering(null);
                  }}
                >
                  <span>{new Date(h.created_at).toLocaleString()}</span>
                  <span className={page.small}>
                    {t(`state_${live.state}`)}
                    {live.totals ? ` · ${t('totals', { requirements: String(live.totals.requirements) })}` : ''}
                  </span>
                </button>
              );
            })}
            {match && !running && history.length > 1 && (
              <Button type="button" variant="outline" size="sm" onClick={() => void compare()} data-gear-match-compare>
                {t('compare')}
              </Button>
            )}
          </aside>
          {/* The report spans the page under the header and the runs: the grid needs the width. */}
          <div className={styles.full}>
            {report && (
              <Segmented
                label={t('view_label')}
                value={view}
                onChange={setView}
                dataAttr="data-gear-match-view"
                items={MATCH_VIEWS.map((v) => ({ id: v, label: t(`view_${v}`) }))}
              />
            )}
            {status && (
              <p className={status.ok ? page.small : page.error} data-gear-match-status>
                {status.text}
              </p>
            )}
            {report &&
              (view === 'gear' ? (
                <GearGrid key={`gear:${match.summary.match_id}`} match={match} cells={cells} />
              ) : (
                <RequirementGrid key={`req:${match.summary.match_id}`} match={match} cells={cells} />
              ))}
            {question && match && (
              <div className={page.card} data-gear-match-answering={question.requirement_id ?? ''}>
                <div className={page.row}>
                  <code className={styles.id}>{shortId(question.requirement_id ?? question.topic)}</code>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setAnswering(null)}>
                    {t('answer_close')}
                  </Button>
                </div>
                <QuestionForm key={question.id} q={question} matchId={match.summary.match_id} t={t} />
              </div>
            )}
            {general.length > 0 && match && (
              <div className={page.card}>
                <b>{t('report_questions')}</b>
                {general.map((q) => (
                  <QuestionForm key={q.id} q={q} matchId={match.summary.match_id} t={t} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {scaffold && <ScaffoldDialogFor r={scaffold} onClose={() => setScaffold(null)} />}
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
  const hint = s.state === 'failed' ? failureHint(s.error) : null;
  const facts = [
    match.catalogue_commit ? t('catalogue', { commit: match.catalogue_commit.slice(0, 8) }) : null,
    match.usage?.calls != null ? t('usage', { calls: String(match.usage.calls) }) : null,
  ].filter((f): f is string => !!f);
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
      {hint && (
        <p className={page.small} data-gear-match-hint={hint}>
          {t(`hint_${hint}`)}
        </p>
      )}
      {match.documents.length > 0 && (
        <div className={styles.documents}>
          <span className={`${page.small} ${page.muted}`}>{t('documents')}</span>
          <ul className={styles.docList} data-gear-match-documents>
            {match.documents.map((d) => (
              <li key={d.path} title={d.sha256}>
                <code className={styles.docPath}>{d.path}</code>
                {d.commit && <code className={styles.meta}>{d.commit.slice(0, 7)}</code>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {facts.length > 0 && (
        <p className={`${page.small} ${page.muted}`} data-gear-match-facts>
          {facts.join(' · ')}
        </p>
      )}
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

function QuestionForm({ q, matchId, t }: { q: GearMatchQuestion; matchId: string; t: T }) {
  const productApi = useProductApi();
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
