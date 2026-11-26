/**
 * Project › Spec graph, the Spec graph kit's screen: the project's spec
 * findings from the spec-graph service (studio-spec-graph), by document.
 *
 * Two readings of one project:
 * - **Now**: the deterministic rules at the project's branch (a check, seconds);
 * - **Stored**: what the project's runs stored in its graph (contradictions the
 *   judges confirmed, with both passages; the other judges' findings).
 * Each finding is confirmed or dismissed: Project model's decision table keeps
 * the decision, and a dismissed finding leaves checks and reviews. A project
 * that is not set up gets a form for the documents to read.
 */

import React, { useCallback, useEffect, useState } from 'react';
import type { ChildMfeBridge } from '@gears-frontx/react';
import {
  apiRegistry,
  useSharedProperty,
  FRONTX_SHARED_PROPERTY_THEME,
} from '@gears-frontx/react';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Skeleton } from '@gears-frontx/ui-kit';
import { STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT, refusalText, useScreenAvailability } from '@constructor-studio/mfe-shared';
import { SpecGraphApiService } from '../../api/SpecGraphApiService';
import type { Decision, DocumentFindings, Finding, Ontology, SpecGraphProject, Verdict } from '../../api/types';
import { counts, documentsInOrder, place, without } from '../../model/findings';
import { findingNode } from '../../model/graph';
import { documentsOf, invalid, scopeOf, type Documents } from '../../model/scope';
import { useSpecGraphTranslations } from '../../i18n';
import { BuildChoice, DEFAULT_CAP, GraphStatus, startBuild, type BuildOptions } from './GraphStatus';
import { GraphView } from './GraphView';
import { OntologyView } from './OntologyView';
import { QualityView } from './QualityView';
import { PullsView } from './PullsView';
import styles from './SpecGraphScreen.module.css';

const DARK_HOST_THEMES = ['dark', 'dracula', 'dracula-large'];

type Text = ReturnType<typeof useSpecGraphTranslations>['t'];
type View = 'now' | 'stored' | 'pulls' | 'graph' | 'ontology' | 'quality';

/**
 * The domain type the Pull requests view shows (`sectionNeeds` in mfe.json):
 * project-git's `pull-request` (ADR-0071 §5). Without it the view is not
 * offered; the rest of the screen does not need it.
 */
export const PULL_REQUEST_TYPE = 'gts.cf.studio.domain.pull_request.v1~';
type FindingsView = Exclude<View, 'pulls' | 'graph' | 'ontology' | 'quality'>;

/** One reading of the project, for one view and one ask. */
interface Reading {
  view: FindingsView;
  asked: number;
  docs: DocumentFindings[] | null;
  revision?: string;
  dismissed: number;
}

// The gear's own sentence (a 503 names what to configure), not the transport's status line.
const message = (e: unknown) => refusalText(e) ?? (e instanceof Error ? e.message : String(e));

function useTheme(bridge: ChildMfeBridge): string {
  const read = () => {
    const v = bridge.getProperty(FRONTX_SHARED_PROPERTY_THEME)?.value;
    return typeof v === 'string' ? v : 'default';
  };
  const [value, setValue] = useState(read);
  useEffect(
    () =>
      bridge.subscribeToProperty(FRONTX_SHARED_PROPERTY_THEME, (p) => {
        if (typeof p.value === 'string') setValue(p.value);
      }),
    [bridge]
  );
  return value;
}

export const SpecGraphScreen: React.FC<{ bridge: ChildMfeBridge }> = ({ bridge }) => {
  const theme = useTheme(bridge);
  const { t, loading } = useSpecGraphTranslations();
  const project = useSharedProperty(STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT);
  const projectId = typeof project === 'string' && project ? project : null;

  return (
    <div className={styles.screen} data-theme={DARK_HOST_THEMES.includes(theme) ? 'dark' : 'light'}>
      {loading ? (
        <Skeleton className={styles.skeleton} />
      ) : !projectId ? (
        <p className={styles.muted}>{t('no_project')}</p>
      ) : (
        // Keyed by the project: another project is another read, from nothing.
        <ProjectSpecGraph key={projectId} projectId={projectId} t={t} />
      )}
    </div>
  );
};

const ProjectSpecGraph: React.FC<{ projectId: string; t: Text }> = ({ projectId, t }) => {
  const api = apiRegistry.getService(SpecGraphApiService);
  const [setup, setSetup] = useState<SpecGraphProject | null>(null);
  const [chosen, setView] = useState<View>('now');
  // Unknown counts as installed, as on Tests.
  const pullsShown = useScreenAvailability().type(PULL_REQUEST_TYPE);
  const view: View = chosen === 'pulls' && !pullsShown ? 'now' : chosen;
  // The node Graph opens on: a finding's, when it was opened from one.
  const [graphStart, setGraphStart] = useState<string | null>(null);
  // Each read is numbered: "Read again" asks for the next one.
  const [asked, setAsked] = useState(0);
  const [result, setResult] = useState<Reading | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The graph's ontology with the project's counts: how many nodes it holds, read again after a run.
  const [ontology, setOntology] = useState<Ontology | null>(null);
  const [graphRead, setGraphRead] = useState(0);
  const graphChanged = useCallback(() => setGraphRead((n) => n + 1), []);
  const nodes = ontology?.counts ? Object.values(ontology.counts).reduce((a, b) => a + b, 0) : null;

  useEffect(() => {
    if (!setup?.registered) return undefined;
    let live = true;
    api
      .ontology({ projectId })
      .fetch({ staleTime: 0 })
      .then((r) => live && setOntology(r.answer))
      .catch(() => live && setOntology(null));
    return () => {
      live = false;
    };
  }, [api, projectId, setup?.registered, graphRead]);

  useEffect(() => {
    let live = true;
    api
      .project({ projectId })
      .fetch({ staleTime: 0 })
      .then((p) => live && setSetup(p))
      .catch((e: unknown) => live && setError(message(e)));
    return () => {
      live = false;
    };
  }, [api, projectId]);

  useEffect(() => {
    if (!setup?.registered || view === 'pulls' || view === 'graph' || view === 'ontology' || view === 'quality')
      return undefined;
    let live = true;
    const reading: Promise<Reading> =
      view === 'now'
        ? api
            .check(projectId)
            .fetch({})
            .then((c) => ({ view, asked, docs: c.documents, revision: c.revision, dismissed: c.dismissed }))
        : api
            .findings({ projectId })
            .fetch({ staleTime: 0 })
            .then((l) => ({ view, asked, docs: l.items, dismissed: l.dismissed }));
    reading
      .then((r) => {
        if (!live) return;
        setResult(r);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setResult({ view, asked, docs: null, dismissed: 0 });
        setError(message(e));
      });
    return () => {
      live = false;
    };
  }, [api, projectId, setup?.registered, view, asked]);

  const findingsView = view === 'now' || view === 'stored';
  const busy = !!setup?.registered && findingsView && (result?.view !== view || result.asked !== asked);
  const current = result && result.view === view ? result : null;
  const docs = current?.docs ?? null;

  const decide = async (f: Finding, decision: Decision) => {
    try {
      await api.decide(projectId, f.id).fetch({ decision, rule: f.rule });
      // Left out at once; the next read says what holds.
      setResult((r) =>
        r && r.docs
          ? { ...r, docs: without(r.docs, f.id), dismissed: r.dismissed + (decision === 'dismissed' ? 1 : 0) }
          : r
      );
    } catch (e) {
      setError(message(e));
    }
  };

  if (!setup) {
    return error ? <p className={styles.error}>{error}</p> : <Skeleton className={styles.skeleton} />;
  }
  if (!setup.registered) {
    return <SetupForm projectId={projectId} t={t} onDone={setSetup} />;
  }

  const shown = docs ? documentsInOrder(docs) : [];
  const n = counts(shown);
  return (
    <>
      <header className={styles.header}>
        <h1 className={styles.title}>{t('title')}</h1>
        <div className={styles.chips}>
          {setup.project?.repository && (
            <Badge variant="outline">
              {setup.project.repository.ref}
              {current?.revision ? ` @ ${current.revision.slice(0, 12)}` : ''}
            </Badge>
          )}
          {docs && <Badge variant={n.blocking ? 'destructive' : 'secondary'}>{t(n.blocking === 1 ? 'blocking_one' : 'blocking_many', { count: n.blocking })}</Badge>}
          {docs && <Badge variant="secondary">{t(n.total === 1 ? 'findings_one' : 'findings_many', { count: n.total })}</Badge>}
          {(current?.dismissed ?? 0) > 0 && (
            <Badge variant="outline">
              {t(current?.dismissed === 1 ? 'dismissed_one' : 'dismissed_many', { count: current?.dismissed ?? 0 })}
            </Badge>
          )}
        </div>
        <div className={styles.actions}>
          <Button variant={view === 'now' ? undefined : 'outline'} onClick={() => setView('now')}>
            {t('view_now')}
          </Button>
          <Button variant={view === 'stored' ? undefined : 'outline'} onClick={() => setView('stored')}>
            {t('view_stored')}
          </Button>
          {pullsShown && (
            <Button variant={view === 'pulls' ? undefined : 'outline'} onClick={() => setView('pulls')}>
              {t('view_pulls')}
            </Button>
          )}
          <Button variant={view === 'graph' ? undefined : 'outline'} onClick={() => setView('graph')}>
            {t('view_graph')}
          </Button>
          <Button variant={view === 'ontology' ? undefined : 'outline'} onClick={() => setView('ontology')}>
            {t('view_ontology')}
          </Button>
          <Button variant={view === 'quality' ? undefined : 'outline'} onClick={() => setView('quality')}>
            {t('view_quality')}
          </Button>
          <Button variant="ghost" disabled={busy || !findingsView} onClick={() => setAsked((n) => n + 1)}>
            {busy ? t('reading') : t('refresh')}
          </Button>
        </div>
      </header>
      <GraphStatus projectId={projectId} nodes={nodes} onChanged={graphChanged} t={t} />
      <p className={styles.muted}>
        {view === 'now'
          ? t('now_hint')
          : view === 'stored'
            ? t('stored_hint')
            : view === 'pulls'
              ? t('pulls_hint')
              : view === 'ontology'
                ? t('ontology_hint')
                : view === 'quality'
                  ? t('quality_hint')
                  : t('graph_view_hint')}
      </p>
      {view === 'pulls' && (
        <PullsView
          projectId={projectId}
          repository={setup.repository ?? null}
          defaultBase={setup.project?.repository?.ref ?? 'main'}
          t={t}
        />
      )}
      {view === 'graph' && (
        <GraphView
          key={`${graphStart ?? ''}|${graphRead}`}
          projectId={projectId}
          start={graphStart}
          counts={ontology?.counts ?? null}
          t={t}
        />
      )}
      {view === 'ontology' && (ontology ? <OntologyView ontology={ontology} t={t} /> : <Skeleton className={styles.skeleton} />)}
      {view === 'quality' && <QualityView key={graphRead} projectId={projectId} t={t} />}
      {error && <p className={styles.error}>{error}</p>}
      {findingsView && busy && !docs && <Skeleton className={styles.skeleton} />}
      {findingsView && docs && shown.length === 0 && <p className={styles.muted}>{t('nothing')}</p>}
      {(findingsView ? shown : []).map((d) => (
        <Card key={d.path ?? '(corpus)'} className={styles.document}>
          <CardHeader>
            <CardTitle className={styles.path}>{d.path ?? t('corpus')}</CardTitle>
          </CardHeader>
          <CardContent className={styles.list}>
            {d.findings.map((f) => (
              <FindingRow
                key={f.id}
                path={d.path}
                finding={f}
                graphBuilt={!!nodes}
                t={t}
                onDecide={decide}
                onLabel={(f, verdict, note) => api.label(projectId, f.id).fetch({ verdict, rule: f.rule, note })}
                onShow={(node) => {
                  setGraphStart(node);
                  setView('graph');
                }}
              />
            ))}
          </CardContent>
        </Card>
      ))}
    </>
  );
};

const FindingRow: React.FC<{
  path: string | null;
  finding: Finding;
  /** Show in graph only once the graph is built: before, it opens on nothing. */
  graphBuilt: boolean;
  t: Text;
  onDecide: (f: Finding, d: Decision) => Promise<void>;
  /** A label for the rule's calibration: it neither hides the finding nor records a decision. */
  onLabel: (f: Finding, verdict: Verdict, note: string) => Promise<unknown>;
  onShow: (node: string) => void;
}> = ({ path, finding: f, graphBuilt, t, onDecide, onLabel, onShow }) => {
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
        <Button size="sm" variant="outline" disabled={deciding} onClick={() => void act('confirmed')}>
          {t('confirm')}
        </Button>
        <Button size="sm" variant="ghost" disabled={deciding} onClick={() => void act('dismissed')}>
          {t('dismiss')}
        </Button>
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

const SetupForm: React.FC<{ projectId: string; t: Text; onDone: (p: SpecGraphProject) => void }> = ({
  projectId,
  t,
  onDone,
}) => {
  const api = apiRegistry.getService(SpecGraphApiService);
  const [docs, setDocs] = useState<Documents>(documentsOf(undefined));
  const [named, setNamed] = useState(false);
  const [buildNow, setBuildNow] = useState(true);
  const [build, setBuild] = useState<BuildOptions>({ facts: false, contradictions: false, cap: DEFAULT_CAP });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The label defaults to the first source's name (the repository the graph reads).
  useEffect(() => {
    let live = true;
    api
      .sources({ projectId })
      .fetch({ staleTime: 0 })
      .then((r) => {
        const name = r.items?.find((s) => s.name && s.name !== '_root')?.name;
        if (live && name && !named) setDocs((d) => ({ ...d, name }));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  const why = invalid(docs);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (why) return;
    setBusy(true);
    setError(null);
    try {
      const done = await api.setup(projectId).fetch({ scope: scopeOf(docs) });
      if (buildNow) await startBuild(api, projectId, build);
      onDone(done);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };
  const set = (patch: Partial<Documents>) => setDocs((d) => ({ ...d, ...patch }));
  return (
    <Card className={styles.document}>
      <CardHeader>
        <CardTitle>{t('setup_title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className={styles.muted}>{t('setup_hint')}</p>
        <form className={styles.setup} onSubmit={(e) => void submit(e)}>
          <fieldset className={styles.modes}>
            <legend className={styles.label}>{t('setup_layout')}</legend>
            <label className={styles.radio}>
              <input type="radio" name="layout" checked={docs.layout === 'docs'} onChange={() => set({ layout: 'docs' })} />
              {t('setup_layout_docs')}
            </label>
            <label className={styles.radio}>
              <input type="radio" name="layout" checked={docs.layout === 'gears'} onChange={() => set({ layout: 'gears' })} />
              {t('setup_layout_gears')}
            </label>
          </fieldset>
          {docs.layout === 'docs' ? (
            <>
              <label className={styles.label}>
                {t('setup_root')}
                <input className={styles.input} value={docs.root} onChange={(e) => set({ root: e.target.value })} />
              </label>
              <label className={styles.label}>
                {t('setup_name')}
                <input
                  className={styles.input}
                  value={docs.name}
                  onChange={(e) => {
                    setNamed(true);
                    set({ name: e.target.value });
                  }}
                />
                <span className={styles.muted}>{t('setup_name_hint')}</span>
              </label>
            </>
          ) : (
            <label className={styles.label}>
              {t('setup_gears')}
              <textarea
                className={styles.input}
                rows={4}
                value={docs.gears}
                placeholder={'gears/file-storage\ngears/system/oagw'}
                onChange={(e) => set({ gears: e.target.value })}
              />
              <span className={styles.muted}>{t('setup_gears_hint')}</span>
            </label>
          )}
          <p className={styles.muted}>
            {t('setup_scope_preview')} <code>{why ? t(why) : scopeOf(docs)}</code>
          </p>
          <div className={styles.modes}>
            <label className={styles.radio}>
              <input type="checkbox" checked={buildNow} onChange={(e) => setBuildNow(e.target.checked)} />
              {t('setup_build')}
            </label>
            {buildNow && <BuildChoice value={build} onChange={setBuild} t={t} />}
          </div>
          <Button type="submit" disabled={busy || !!why}>
            {busy ? t('reading') : t('setup_submit')}
          </Button>
        </form>
        {error && <p className={styles.error}>{error}</p>}
      </CardContent>
    </Card>
  );
};
