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

import React, { useEffect, useState } from 'react';
import type { ChildMfeBridge } from '@gears-frontx/react';
import {
  apiRegistry,
  useSharedProperty,
  FRONTX_SHARED_PROPERTY_THEME,
} from '@gears-frontx/react';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Skeleton } from '@gears-frontx/ui-kit';
import { STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT, useScreenAvailability } from '@constructor-studio/mfe-shared';
import { SpecGraphApiService } from '../../api/SpecGraphApiService';
import type { Decision, DocumentFindings, Finding, SpecGraphProject } from '../../api/types';
import { counts, documentsInOrder, place, without } from '../../model/findings';
import { findingNode } from '../../model/graph';
import { useSpecGraphTranslations } from '../../i18n';
import { GraphView } from './GraphView';
import { PullsView } from './PullsView';
import styles from './SpecGraphScreen.module.css';

const DARK_HOST_THEMES = ['dark', 'dracula', 'dracula-large'];

type Text = ReturnType<typeof useSpecGraphTranslations>['t'];
type View = 'now' | 'stored' | 'pulls' | 'graph';

/**
 * The domain type the Pull requests view shows (`sectionNeeds` in mfe.json):
 * project-git's `pull-request` (ADR-0071 §5). Without it the view is not
 * offered; the rest of the screen does not need it.
 */
export const PULL_REQUEST_TYPE = 'gts.cf.studio.domain.pull_request.v1~';
type FindingsView = Exclude<View, 'pulls' | 'graph'>;

/** One reading of the project, for one view and one ask. */
interface Reading {
  view: FindingsView;
  asked: number;
  docs: DocumentFindings[] | null;
  revision?: string;
  dismissed: number;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
    if (!setup?.registered || view === 'pulls' || view === 'graph') return undefined;
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
          <Button variant="ghost" disabled={busy || !findingsView} onClick={() => setAsked((n) => n + 1)}>
            {busy ? t('reading') : t('refresh')}
          </Button>
        </div>
      </header>
      <p className={styles.muted}>
        {view === 'now'
          ? t('now_hint')
          : view === 'stored'
            ? t('stored_hint')
            : view === 'pulls'
              ? t('pulls_hint')
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
      {view === 'graph' && <GraphView key={graphStart ?? ''} projectId={projectId} start={graphStart} t={t} />}
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
                t={t}
                onDecide={decide}
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
  t: Text;
  onDecide: (f: Finding, d: Decision) => Promise<void>;
  onShow: (node: string) => void;
}> = ({ path, finding: f, t, onDecide, onShow }) => {
  const node = findingNode(path, f);
  const [deciding, setDeciding] = useState(false);
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
      </div>
    </div>
  );
};

const SetupForm: React.FC<{ projectId: string; t: Text; onDone: (p: SpecGraphProject) => void }> = ({
  projectId,
  t,
  onDone,
}) => {
  const api = apiRegistry.getService(SpecGraphApiService);
  const [scope, setScope] = useState('--docs-root docs --name docs .');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await api.setup(projectId).fetch({ scope: scope.trim() }));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className={styles.document}>
      <CardHeader>
        <CardTitle>{t('setup_title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className={styles.muted}>{t('setup_hint')}</p>
        <form className={styles.setup} onSubmit={(e) => void submit(e)}>
          <label className={styles.label}>
            {t('setup_scope')}
            <input className={styles.input} value={scope} onChange={(e) => setScope(e.target.value)} />
          </label>
          <Button type="submit" disabled={busy || !scope.trim()}>
            {busy ? t('reading') : t('setup_submit')}
          </Button>
        </form>
        {error && <p className={styles.error}>{error}</p>}
      </CardContent>
    </Card>
  );
};
