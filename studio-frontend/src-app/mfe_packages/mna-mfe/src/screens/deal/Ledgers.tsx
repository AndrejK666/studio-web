/**
 * The deal's three ledgers on the shared `ListGrid`: findings, risks and open
 * questions. Each has an Add button; a row click opens it in the same dialog,
 * where it is changed or deleted. After a write the list and the evidence
 * (which counts what is open) are read again.
 */

import React, { useMemo, useState } from 'react';
import { apiRegistry, useApiQuery, useQueryCache } from '@gears-frontx/react';
import {
  Badge,
  Button,
  DataGridRowClickPlugin,
  Skeleton,
  type DataGridItem,
  type DataGridTableColumn,
} from '@gears-frontx/ui-kit';
import { errorMessage } from '@constructor-studio/mfe-shared';
import {
  GridClearFilters,
  GridEmpty,
  GridFailed,
  ListGrid,
  NoData,
  createGridCells,
  useLocalGridLoad,
  type LocalGridOptions,
} from '@constructor-studio/mfe-shared/grid';
import { MnaApiService } from '../../api/MnaApiService';
import {
  FINDING_STATUSES,
  IMPACTS,
  LIKELIHOODS,
  QUESTION_STATUSES,
  RISK_STATUSES,
  SEVERITIES,
  type MnaFinding,
  type MnaLedger,
  type MnaLedgers,
  type MnaQuestion,
  type MnaRisk,
} from '../../api/types';
import { bodyOf, hasRequired, rank, toneOf, type RecordDraft } from '../../model/deal';
import { FormDialog, type FormField } from './FormDialog';
import { enumLabel, timeLabel, type Text } from './text';
import styles from './DealScreen.module.css';

const byText = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? '').localeCompare(b ?? '', undefined, { sensitivity: 'base', numeric: true });

interface Cells {
  t: Text;
  language: string;
  /** Finding titles by id: what a risk's related finding reads as. */
  findingTitles: ReadonlyMap<string, string>;
}

const [CellsProvider, useCells] = createGridCells<Cells>('MnaLedgers');

const Dash: React.FC = () => <NoData label={useCells().t('no_data')} />;

const TextCell: React.FC<{ value: string | null | undefined; wide?: boolean }> = ({ value, wide }) =>
  value ? <span className={wide ? styles.cellWide : styles.cellText}>{value}</span> : <Dash />;

const EnumBadge: React.FC<{ scale: string; tone: Parameters<typeof toneOf>[0]; value: string; data?: string }> = ({
  scale,
  tone,
  value,
  data,
}) => {
  const { t } = useCells();
  return (
    <Badge variant={toneOf(tone, value)} data-mna-badge={data ?? scale}>
      {enumLabel(t, scale, value)}
    </Badge>
  );
};

const Updated: React.FC<{ item: { updated_at: string } }> = ({ item }) => {
  const { language } = useCells();
  return <span className={styles.nowrap}>{timeLabel(item.updated_at, language)}</span>;
};

/* ── Findings ── */

const FindingTitle: React.FC<{ item: MnaFinding }> = ({ item }) => (
  <span className={styles.cellWide} data-mna-finding={item.id}>
    {item.title}
  </span>
);
const FindingSeverity: React.FC<{ item: MnaFinding }> = ({ item }) => (
  <EnumBadge scale="severity" tone="severity" value={item.severity} />
);
const FindingSource: React.FC<{ item: MnaFinding }> = ({ item }) => <TextCell value={item.source} />;
const FindingOrigin: React.FC<{ item: MnaFinding }> = ({ item }) => <TextCell value={item.origin} />;
const FindingStatus: React.FC<{ item: MnaFinding }> = ({ item }) => (
  <EnumBadge scale="finding_status" tone="finding_status" value={item.status} data="status" />
);

const FINDING_OPTIONS = {
  search: (f: MnaFinding) => [f.title, f.source, f.evidence, f.origin],
  compare: {
    severity: (a: MnaFinding, b: MnaFinding) => rank(SEVERITIES, a.severity) - rank(SEVERITIES, b.severity),
    title: (a: MnaFinding, b: MnaFinding) => byText(a.title, b.title),
    source: (a: MnaFinding, b: MnaFinding) => byText(a.source, b.source),
    origin: (a: MnaFinding, b: MnaFinding) => byText(a.origin, b.origin),
    status: (a: MnaFinding, b: MnaFinding) => rank(FINDING_STATUSES, a.status) - rank(FINDING_STATUSES, b.status),
    updated: (a: MnaFinding, b: MnaFinding) => byText(a.updated_at, b.updated_at),
  },
};

/* ── Risks ── */

const RiskTitle: React.FC<{ item: MnaRisk }> = ({ item }) => (
  <span className={styles.cellWide} data-mna-risk={item.id}>
    {item.title}
  </span>
);
const RiskLikelihood: React.FC<{ item: MnaRisk }> = ({ item }) => (
  <EnumBadge scale="level" tone="level" value={item.likelihood} data="likelihood" />
);
const RiskImpact: React.FC<{ item: MnaRisk }> = ({ item }) => (
  <EnumBadge scale="level" tone="level" value={item.impact} data="impact" />
);
const RiskOwner: React.FC<{ item: MnaRisk }> = ({ item }) => <TextCell value={item.owner} />;
const RiskFinding: React.FC<{ item: MnaRisk }> = ({ item }) => {
  const { findingTitles } = useCells();
  return <TextCell value={item.finding_id ? (findingTitles.get(item.finding_id) ?? item.finding_id) : null} />;
};
const RiskStatus: React.FC<{ item: MnaRisk }> = ({ item }) => (
  <EnumBadge scale="risk_status" tone="risk_status" value={item.status} data="status" />
);

const RISK_OPTIONS = {
  search: (r: MnaRisk) => [r.title, r.owner, r.mitigation],
  compare: {
    title: (a: MnaRisk, b: MnaRisk) => byText(a.title, b.title),
    likelihood: (a: MnaRisk, b: MnaRisk) => rank(LIKELIHOODS, a.likelihood) - rank(LIKELIHOODS, b.likelihood),
    impact: (a: MnaRisk, b: MnaRisk) => rank(IMPACTS, a.impact) - rank(IMPACTS, b.impact),
    owner: (a: MnaRisk, b: MnaRisk) => byText(a.owner, b.owner),
    status: (a: MnaRisk, b: MnaRisk) => rank(RISK_STATUSES, a.status) - rank(RISK_STATUSES, b.status),
    updated: (a: MnaRisk, b: MnaRisk) => byText(a.updated_at, b.updated_at),
  },
};

/* ── Open questions ── */

const QuestionWhat: React.FC<{ item: MnaQuestion }> = ({ item }) => (
  <span className={styles.cellWide} data-mna-question={item.id}>
    {item.what}
  </span>
);
const QuestionWho: React.FC<{ item: MnaQuestion }> = ({ item }) => <TextCell value={item.who} />;
const QuestionAnswer: React.FC<{ item: MnaQuestion }> = ({ item }) => <TextCell value={item.answer} wide />;
const QuestionStatus: React.FC<{ item: MnaQuestion }> = ({ item }) => (
  <EnumBadge scale="question_status" tone="question_status" value={item.status} data="status" />
);

const QUESTION_OPTIONS = {
  search: (q: MnaQuestion) => [q.what, q.who, q.answer],
  compare: {
    what: (a: MnaQuestion, b: MnaQuestion) => byText(a.what, b.what),
    who: (a: MnaQuestion, b: MnaQuestion) => byText(a.who, b.who),
    status: (a: MnaQuestion, b: MnaQuestion) =>
      rank(QUESTION_STATUSES, a.status) - rank(QUESTION_STATUSES, b.status),
    updated: (a: MnaQuestion, b: MnaQuestion) => byText(a.updated_at, b.updated_at),
  },
};

/* ── Empty states, one per ledger ── */

const emptyOf = (note: string): React.FC => {
  const Empty: React.FC = () => {
    const { t } = useCells();
    return (
      <GridEmpty
        note={t(note)}
        noMatches={t('no_match')}
        noMatchesActions={<GridClearFilters label={t('clear_search')} />}
      />
    );
  };
  return Empty;
};
const FindingsEmpty = emptyOf('findings_empty');
const RisksEmpty = emptyOf('risks_empty');
const QuestionsEmpty = emptyOf('questions_empty');

/* ── The dialogs' fields ── */

const choices = (t: Text, scale: string, values: readonly string[]) =>
  values.map((value) => ({ value, label: enumLabel(t, scale, value) }));

function findingFields(t: Text): FormField[] {
  return [
    { name: 'title', label: t('field_title'), kind: 'text', required: true },
    { name: 'severity', label: t('field_severity'), kind: 'select', required: true, options: choices(t, 'severity', SEVERITIES) },
    { name: 'source', label: t('field_source'), kind: 'text', hint: t('field_source_hint') },
    { name: 'evidence', label: t('field_evidence'), kind: 'textarea' },
    { name: 'origin', label: t('field_origin'), kind: 'text', hint: t('field_origin_hint') },
    { name: 'status', label: t('field_status'), kind: 'select', options: choices(t, 'finding_status', FINDING_STATUSES) },
  ];
}

function riskFields(t: Text, findings: readonly MnaFinding[]): FormField[] {
  return [
    { name: 'title', label: t('field_title'), kind: 'text', required: true },
    { name: 'likelihood', label: t('field_likelihood'), kind: 'select', required: true, options: choices(t, 'level', LIKELIHOODS) },
    { name: 'impact', label: t('field_impact'), kind: 'select', required: true, options: choices(t, 'level', IMPACTS) },
    { name: 'owner', label: t('field_owner'), kind: 'text' },
    { name: 'mitigation', label: t('field_mitigation'), kind: 'textarea' },
    {
      name: 'finding_id',
      label: t('field_finding'),
      kind: 'select',
      optional: true,
      options: findings.map((f) => ({ value: f.id, label: f.title })),
    },
    { name: 'status', label: t('field_status'), kind: 'select', options: choices(t, 'risk_status', RISK_STATUSES) },
  ];
}

function questionFields(t: Text): FormField[] {
  return [
    { name: 'what', label: t('field_what'), kind: 'textarea', required: true },
    { name: 'who', label: t('field_who'), kind: 'text', hint: t('field_who_hint') },
    { name: 'answer', label: t('field_answer'), kind: 'textarea' },
    { name: 'status', label: t('field_status'), kind: 'select', options: choices(t, 'question_status', QUESTION_STATUSES) },
  ];
}

/** What a new record starts as. */
export const NEW_DRAFTS: Record<MnaLedger, RecordDraft> = {
  findings: { severity: 'medium', origin: 'manual', status: 'open' },
  risks: { likelihood: 'medium', impact: 'medium', status: 'open' },
  'open-questions': { status: 'open' },
};

const REQUIRED: Record<MnaLedger, readonly string[]> = {
  findings: ['title', 'severity'],
  risks: ['title', 'likelihood', 'impact'],
  'open-questions': ['what'],
};

/** A row as the dialog's text draft. */
export function draftOfRow(row: object): RecordDraft {
  const draft: RecordDraft = {};
  for (const [k, v] of Object.entries(row)) if (typeof v === 'string') draft[k] = v;
  return draft;
}

/* ── One ledger ── */

type Row = DataGridItem & { id: string };

interface LedgerProps<R extends Row> {
  ledger: MnaLedger;
  projectId: string;
  t: Text;
  container: React.RefObject<HTMLDivElement | null>;
  title: string;
  about: string;
  addLabel: string;
  read: { data?: { items: R[]; total: number }; isLoading: boolean; error: unknown; refetch: () => unknown };
  columns: DataGridTableColumn<R>[];
  options: LocalGridOptions<R>;
  empty: React.ComponentType;
  unsortable?: string[];
  fields: FormField[];
  titleOf: (row: R) => string;
  onWritten: () => void;
}

function Ledger<R extends Row>({
  ledger,
  projectId,
  t,
  container,
  title,
  about,
  addLabel,
  read,
  columns,
  options,
  empty,
  unsortable,
  fields,
  titleOf,
  onWritten,
}: LedgerProps<R>) {
  const [editing, setEditing] = useState<R | 'new' | null>(null);
  const rows = useMemo(() => read.data?.items ?? [], [read.data]);
  const { load, reloadBridge } = useLocalGridLoad<R>(rows, options);
  const api = apiRegistry.getService(MnaApiService);
  const names = fields.map((f) => f.name);

  const save = async (draft: RecordDraft) => {
    const body = bodyOf(draft, names) as unknown as MnaLedgers[MnaLedger]['body'];
    if (editing === 'new') await api.create(ledger, projectId).fetch(body);
    else if (editing) await api.update(ledger, projectId, editing.id).fetch(body);
    setEditing(null);
    onWritten();
  };

  const remove = async () => {
    if (!editing || editing === 'new') return;
    await api.remove(ledger, projectId, editing.id).fetch(undefined);
    setEditing(null);
    onWritten();
  };

  return (
    <section className={styles.section} data-mna-ledger={ledger}>
      <div className={styles.sectionHead}>
        <h3 className={styles.sectionTitle}>
          {title}
          {read.data && <span className={styles.count}>{read.data.total}</span>}
        </h3>
        <Button size="sm" className={styles.push} onClick={() => setEditing('new')} data-mna-add={ledger}>
          {addLabel}
        </Button>
      </div>
      <p className={styles.about}>{about}</p>
      {read.isLoading ? (
        <Skeleton className={styles.gridSkeleton} />
      ) : read.error ? (
        <GridFailed
          message={t('list_failed', { error: errorMessage(read.error) })}
          retry={t('retry')}
          onRetry={() => void read.refetch()}
        />
      ) : (
        <ListGrid<R>
          name={`mna-${ledger}`}
          label={title}
          columns={columns}
          load={load}
          search={t('search')}
          empty={empty}
          unsortable={unsortable}
          minWidth="48rem"
        >
          <DataGridRowClickPlugin<R> click={(row: R) => setEditing(row)} />
          {reloadBridge}
        </ListGrid>
      )}
      {editing && (
        <FormDialog
          t={t}
          container={container}
          name={ledger}
          title={editing === 'new' ? addLabel : t('edit_title', { title: titleOf(editing) })}
          fields={fields}
          initial={editing === 'new' ? NEW_DRAFTS[ledger] : draftOfRow(editing)}
          canSave={(draft) => hasRequired(draft, REQUIRED[ledger])}
          onSave={save}
          onDelete={editing === 'new' ? undefined : remove}
          deleteQuestion={t('delete_question')}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

/** The three ledgers, read once each; a write reads its list and the evidence again. */
export const Ledgers: React.FC<{
  projectId: string;
  t: Text;
  language: string;
  container: React.RefObject<HTMLDivElement | null>;
  /** The evidence counts what is open: read it again after a write. */
  onWritten: () => void;
}> = ({ projectId, t, language, container, onWritten }) => {
  const api = apiRegistry.getService(MnaApiService);
  const cache = useQueryCache();
  const findings = useApiQuery(api.findings({ projectId }));
  const risks = useApiQuery(api.risks({ projectId }));
  const questions = useApiQuery(api.questions({ projectId }));

  const findingTitles = useMemo(
    () => new Map((findings.data?.items ?? []).map((f) => [f.id, f.title])),
    [findings.data]
  );
  const cells = useMemo<Cells>(() => ({ t, language, findingTitles }), [t, language, findingTitles]);

  const findingColumns = useMemo<DataGridTableColumn<MnaFinding>[]>(
    () => [
      { id: 'severity', label: t('col_severity'), component: FindingSeverity, width: 120 },
      { id: 'title', label: t('col_title'), component: FindingTitle },
      { id: 'source', label: t('col_source'), component: FindingSource, width: 180 },
      { id: 'origin', label: t('col_origin'), component: FindingOrigin, width: 130 },
      { id: 'status', label: t('col_status'), component: FindingStatus, width: 120 },
      { id: 'updated', label: t('col_updated'), component: Updated, width: 170 },
    ],
    [t]
  );
  const riskColumns = useMemo<DataGridTableColumn<MnaRisk>[]>(
    () => [
      { id: 'title', label: t('col_risk'), component: RiskTitle },
      { id: 'likelihood', label: t('col_likelihood'), component: RiskLikelihood, width: 120 },
      { id: 'impact', label: t('col_impact'), component: RiskImpact, width: 120 },
      { id: 'owner', label: t('col_owner'), component: RiskOwner, width: 150 },
      { id: 'finding', label: t('col_finding'), component: RiskFinding, width: 200 },
      { id: 'status', label: t('col_status'), component: RiskStatus, width: 120 },
      { id: 'updated', label: t('col_updated'), component: Updated, width: 170 },
    ],
    [t]
  );
  const questionColumns = useMemo<DataGridTableColumn<MnaQuestion>[]>(
    () => [
      { id: 'what', label: t('col_question'), component: QuestionWhat },
      { id: 'who', label: t('col_who'), component: QuestionWho, width: 160 },
      { id: 'answer', label: t('col_answer'), component: QuestionAnswer },
      { id: 'status', label: t('col_status'), component: QuestionStatus, width: 120 },
      { id: 'updated', label: t('col_updated'), component: Updated, width: 170 },
    ],
    [t]
  );

  const written = (ledger: MnaLedger) => () => {
    if (ledger === 'findings') void cache.invalidate(api.findings({ projectId }));
    if (ledger === 'risks') void cache.invalidate(api.risks({ projectId }));
    if (ledger === 'open-questions') void cache.invalidate(api.questions({ projectId }));
    onWritten();
  };

  return (
    <CellsProvider value={cells}>
      <Ledger<MnaFinding>
        ledger="findings"
        projectId={projectId}
        t={t}
        container={container}
        title={t('findings_title')}
        about={t('findings_about')}
        addLabel={t('add_finding')}
        read={findings}
        columns={findingColumns}
        options={FINDING_OPTIONS}
        empty={FindingsEmpty}
        fields={findingFields(t)}
        titleOf={(f) => f.title}
        onWritten={written('findings')}
      />
      <Ledger<MnaRisk>
        ledger="risks"
        projectId={projectId}
        t={t}
        container={container}
        title={t('risks_title')}
        about={t('risks_about')}
        addLabel={t('add_risk')}
        read={risks}
        columns={riskColumns}
        options={RISK_OPTIONS}
        empty={RisksEmpty}
        unsortable={['finding']}
        fields={riskFields(t, findings.data?.items ?? [])}
        titleOf={(r) => r.title}
        onWritten={written('risks')}
      />
      <Ledger<MnaQuestion>
        ledger="open-questions"
        projectId={projectId}
        t={t}
        container={container}
        title={t('questions_title')}
        about={t('questions_about')}
        addLabel={t('add_question')}
        read={questions}
        columns={questionColumns}
        options={QUESTION_OPTIONS}
        empty={QuestionsEmpty}
        unsortable={['answer']}
        fields={questionFields(t)}
        titleOf={(q) => q.what}
        onWritten={written('open-questions')}
      />
    </CellsProvider>
  );
};

Ledgers.displayName = 'Ledgers';
