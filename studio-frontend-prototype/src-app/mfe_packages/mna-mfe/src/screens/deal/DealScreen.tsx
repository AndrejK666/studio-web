/**
 * Project › Deal — the `mna` kit's tab (ADR-0073: a deal is a project of the
 * kit's project type). Top to bottom: the target, its phase and the
 * investment committee's date; the technical recommendation, its conditions
 * and the deal lead's sign-off; the thesis; what Studio already knows of the
 * target (evidence); and the deal's findings, risks and open questions.
 *
 * Everything is `studio-kits` `/mna/*` for this project. A deal write answers
 * the deal, which replaces the cached one; a ledger write reads its list and
 * the evidence again.
 */

import React, { useState } from 'react';
import { apiRegistry, useApiQuery, useQueryCache, useSharedProperty } from '@gears-frontx/react';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Skeleton, Textarea } from '@gears-frontx/ui-kit';
import {
  STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT,
  errorMessage,
  refusalText,
  responseStatus,
  useHostChrome,
} from '@constructor-studio/mfe-shared';
import { MnaApiService } from '../../api/MnaApiService';
import type { MnaDeal, MnaDealPatch } from '../../api/types';
import {
  canSignOff,
  clearsSignOff,
  dealPatch,
  draftOf,
  signerOf,
  toneOf,
  type DealDraft,
  type RecordDraft,
} from '../../model/deal';
import { useMnaTranslations } from '../../i18n';
import { Evidence } from './Evidence';
import { FormDialog } from './FormDialog';
import { Ledgers } from './Ledgers';
import { dayLabel, enumLabel, timeLabel, type Text } from './text';
import styles from './DealScreen.module.css';

export const DealScreen: React.FC = () => {
  const project = useSharedProperty(STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT);
  const projectId = typeof project === 'string' && project ? project : null;
  const { containerRef, dataTheme, language } = useHostChrome();
  const { t, loading } = useMnaTranslations();

  return (
    <div ref={containerRef} className={styles.screen} data-theme={dataTheme}>
      {loading ? (
        <Skeleton className={styles.skeleton} />
      ) : !projectId ? (
        <p className={styles.muted}>{t('no_project')}</p>
      ) : (
        // Keyed by the project: another project is another read, from nothing.
        <DealView key={projectId} projectId={projectId} t={t} language={language} container={containerRef} />
      )}
    </div>
  );
};

DealScreen.displayName = 'DealScreen';

type Dialog = 'header' | 'recommendation' | null;

function DealView({
  projectId,
  t,
  language,
  container,
}: {
  projectId: string;
  t: Text;
  language: string;
  container: React.RefObject<HTMLDivElement | null>;
}) {
  const api = apiRegistry.getService(MnaApiService);
  const cache = useQueryCache();
  const deal = useApiQuery(api.deal({ projectId }));
  const evidence = useApiQuery(api.evidence({ projectId }));
  const [dialog, setDialog] = useState<Dialog>(null);

  /** A deal write answers the deal: it replaces the cached one. */
  const update = async (patch: MnaDealPatch) => {
    if (Object.keys(patch).length === 0) return;
    const next = await api.updateDeal(projectId).fetch(patch);
    cache.set(api.deal({ projectId }), next);
  };

  if (deal.isLoading) {
    return (
      <div className={styles.loading} aria-busy="true">
        <Skeleton className={styles.skeleton} />
        <Skeleton className={styles.cardSkeleton} />
      </div>
    );
  }
  if (deal.error || !deal.data) {
    return (
      <div className={styles.section}>
        <p className={styles.error} role="alert" data-mna-error>
          {t('deal_failed', { error: errorMessage(deal.error) })}
        </p>
        <Button variant="outline" size="sm" className={styles.start} onClick={() => void deal.refetch()}>
          {t('retry')}
        </Button>
      </div>
    );
  }
  const d = deal.data;
  if (!d.installed) {
    return (
      <p className={styles.muted} data-mna-not-installed>
        {t('not_installed')}
      </p>
    );
  }

  return (
    <>
      <header className={styles.header} data-mna-header>
        <div className={styles.headline}>
          <h2 className={styles.title}>{d.target || t('no_target')}</h2>
          <div className={styles.chips}>
            {d.deal_phase && (
              <Badge variant="info" data-mna-phase={d.deal_phase}>
                {enumLabel(t, 'phase', d.deal_phase)}
              </Badge>
            )}
            <span className={styles.muted}>
              {d.ic_date ? t('ic_date', { date: dayLabel(d.ic_date, language) }) : t('no_ic_date')}
            </span>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => setDialog('header')} data-mna-edit-header>
          {t('edit')}
        </Button>
      </header>
      <p className={styles.about}>{t('about')}</p>

      <div className={styles.cards}>
        <RecommendationCard
          deal={d}
          projectId={projectId}
          t={t}
          language={language}
          onEdit={() => setDialog('recommendation')}
          onSigned={(next) => cache.set(api.deal({ projectId }), next)}
        />
        <ThesisCard key={d.thesis ?? ''} deal={d} t={t} save={(thesis) => update({ thesis })} />
      </div>

      <Evidence
        evidence={evidence.data}
        loading={evidence.isLoading}
        error={evidence.error}
        refreshing={evidence.isFetching}
        onRefresh={() => void evidence.refetch()}
        t={t}
        language={language}
      />

      <Ledgers
        projectId={projectId}
        t={t}
        language={language}
        container={container}
        onWritten={() => void cache.invalidate(api.evidence({ projectId }))}
      />

      {dialog === 'header' && (
        <FormDialog
          t={t}
          container={container}
          name="deal-header"
          title={t('edit_deal')}
          fields={[
            { name: 'target', label: t('field_target'), kind: 'text' },
            {
              name: 'deal_phase',
              label: t('field_phase'),
              kind: 'select',
              optional: true,
              options: d.phases.map((p) => ({ value: p, label: enumLabel(t, 'phase', p) })),
            },
            { name: 'ic_date', label: t('field_ic_date'), kind: 'date' },
          ]}
          initial={draftOf(d) as unknown as RecordDraft}
          canSave={() => true}
          onSave={async (draft) => {
            await update(dealPatch(d, draft as unknown as DealDraft, ['target', 'deal_phase', 'ic_date']));
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'recommendation' && (
        <FormDialog
          t={t}
          container={container}
          name="deal-recommendation"
          title={t('edit_recommendation')}
          note={(draft) =>
            d.signed_off_by &&
            clearsSignOff(dealPatch(d, draft as unknown as DealDraft, ['recommendation', 'conditions']))
              ? t('clears_sign_off')
              : null
          }
          fields={[
            {
              name: 'recommendation',
              label: t('field_recommendation'),
              kind: 'select',
              optional: true,
              options: d.recommendations.map((r) => ({ value: r, label: enumLabel(t, 'recommendation', r) })),
            },
            { name: 'conditions', label: t('field_conditions'), kind: 'textarea', hint: t('field_conditions_hint') },
          ]}
          initial={draftOf(d) as unknown as RecordDraft}
          canSave={() => true}
          onSave={async (draft) => {
            await update(dealPatch(d, draft as unknown as DealDraft, ['recommendation', 'conditions']));
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}

function RecommendationCard({
  deal,
  projectId,
  t,
  language,
  onEdit,
  onSigned,
}: {
  deal: MnaDeal;
  projectId: string;
  t: Text;
  language: string;
  onEdit: () => void;
  onSigned: (deal: MnaDeal) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const signer = signerOf(deal);

  const signOff = async () => {
    setBusy(true);
    setFailed(null);
    try {
      onSigned(await apiRegistry.getService(MnaApiService).signOff(projectId).fetch(undefined));
    } catch (e) {
      const why = refusalText(e) ?? errorMessage(e);
      setFailed(responseStatus(e) === 403 ? t('sign_off_forbidden') : t('sign_off_failed', { error: why }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card data-mna-recommendation>
      <CardHeader className={styles.cardHead}>
        <CardTitle>{t('recommendation_title')}</CardTitle>
        <Button variant="outline" size="sm" onClick={onEdit} data-mna-edit-recommendation>
          {t('edit')}
        </Button>
      </CardHeader>
      <CardContent className={styles.cardBody}>
        {deal.recommendation ? (
          <Badge
            variant={toneOf('recommendation', deal.recommendation)}
            className={styles.start}
            data-mna-recommendation-value={deal.recommendation}
          >
            {enumLabel(t, 'recommendation', deal.recommendation)}
          </Badge>
        ) : (
          <span className={styles.muted}>{t('no_recommendation')}</span>
        )}
        {deal.conditions.length > 0 && (
          <>
            <span className={styles.label}>{t('conditions')}</span>
            <ul className={styles.conditions} data-mna-conditions>
              {deal.conditions.map((c, i) => (
                <li key={`${i}:${c}`}>{c}</li>
              ))}
            </ul>
          </>
        )}
        <div className={styles.signOff}>
          {signer ? (
            <span data-mna-signed-off>
              <Badge variant="success">{t('signed_off')}</Badge>{' '}
              {t('signed_off_by', {
                who: signer.who === 'you' ? t('you') : signer.who === 'lead' ? t('deal_lead_id', { id: signer.id }) : signer.id,
                when: timeLabel(deal.signed_off_at, language),
              })}
            </span>
          ) : (
            <span className={styles.muted}>{t('not_signed_off')}</span>
          )}
          {signer && <span className={styles.muted}>{t('clears_sign_off')}</span>}
          {deal.may_sign_off ? (
            <Button
              size="sm"
              className={styles.start}
              onClick={() => void signOff()}
              disabled={busy || !canSignOff(deal)}
              title={deal.recommendation ? undefined : t('sign_off_needs_recommendation')}
              data-mna-sign-off
            >
              {busy ? t('signing') : signer ? t('sign_off_again') : t('sign_off')}
            </Button>
          ) : (
            <>
              <Button size="sm" className={styles.start} disabled data-mna-sign-off>
                {t('sign_off')}
              </Button>
              <span className={styles.muted} data-mna-lead-only>
                {t('sign_off_lead_only')}
              </span>
            </>
          )}
          {failed && (
            <p className={styles.error} role="alert">
              {failed}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ThesisCard({ deal, t, save }: { deal: MnaDeal; t: Text; save: (thesis: string) => Promise<void> }) {
  const saved = deal.thesis ?? '';
  const [text, setText] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setFailed(null);
    try {
      await save(text);
    } catch (e) {
      setFailed(t('save_failed', { error: refusalText(e) ?? errorMessage(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card data-mna-thesis>
      <CardHeader>
        <CardTitle>{t('thesis_title')}</CardTitle>
      </CardHeader>
      <CardContent className={styles.cardBody}>
        <span className={styles.muted}>{t('thesis_about')}</span>
        <Textarea
          rows={6}
          value={text}
          aria-label={t('thesis_title')}
          placeholder={t('thesis_placeholder')}
          onChange={(e) => setText(e.target.value)}
          data-mna-thesis-text
        />
        <Button
          size="sm"
          className={styles.start}
          onClick={() => void submit()}
          disabled={busy || text === saved}
          data-mna-thesis-save
        >
          {busy ? t('saving') : t('save')}
        </Button>
        {failed && (
          <p className={styles.error} role="alert">
            {failed}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
