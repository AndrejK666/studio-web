/**
 * The Product page's first step: what the product is (the prototype's
 * `product-kind-view.tsx`, model product-kind.ts). Studio proposes a kind from
 * the project's specs, its own components and the product record, with the
 * reasons it read; a member confirms it or picks another, and the choice is
 * kept in the project's configuration. Marked experimental: the proposal is
 * read in the portal, by word matches and counts, until a backend route
 * proposes one. The kinds, their descriptions and the reasons are the model's
 * English sentences.
 */

import { useEffect, useState } from 'react';
import { Button } from '@gears-frontx/ui-kit';
import { productApi } from '../../../api/client';
import { FRONTX_TYPE, GEAR_TYPE, SERVICE_TYPE, tierOf } from '../../../model/catalogue-levels';
import {
  KIND_TITLE,
  PRODUCT_KINDS,
  kindStatus,
  proposeKind,
  readKindChoice,
  withKind,
  type KindFacts,
  type KindProposal,
  type ProductKind,
  type ProductKindChoice,
} from '../../../model/product-kind';
import { useFlowTranslations } from '../../../i18n';
import { errText, StatusChip, useScope } from '../../common';
import common from '../../product.module.css';
import styles from './flow.module.css';

/** Reads what the proposal needs; each read on its own, a failed one `null`. */
export async function readKindFacts(projectId: string): Promise<{ facts: KindFacts; choice: ProductKindChoice | null }> {
  const [cfg, caps, reqs, comps, product] = await Promise.all([
    productApi.projectConfig(projectId).catch(() => null),
    productApi
      .declaredCapabilities(projectId)
      .then((r) => r.items)
      .catch(() => null),
    productApi
      .declaredRequirements(projectId)
      .then((r) => r.items)
      .catch(() => null),
    productApi
      .listComponents(projectId)
      .then((r) => r.nodes ?? [])
      .catch(() => null),
    productApi.projectProduct(projectId).catch(() => null),
  ]);
  const own = comps?.filter((n) => tierOf(n) === 'project') ?? null;
  return {
    choice: readKindChoice(cfg?.product_kind),
    facts: {
      brief: cfg?.brief ?? null,
      capabilities: caps?.map((c) => ({ key: c.key, from: [...new Set(c.sources.map((s) => s.label))] })) ?? null,
      requirements: reqs?.map((r) => r.text) ?? null,
      ownComponents: own
        ? {
            gears: own.filter((n) => n.type_id === GEAR_TYPE).length,
            frontx: own.filter((n) => n.type_id === FRONTX_TYPE).length,
            services: own.filter((n) => n.type_id === SERVICE_TYPE).length,
          }
        : null,
      product: product ? { gears: product.gears?.length ?? 0, frontend: !!product.frontend } : null,
    },
  };
}

export function ProductKindStep() {
  const { projectId } = useScope();
  const { t } = useFlowTranslations();
  const [read, setRead] = useState<{ proposal: KindProposal; choice: ProductKindChoice | null } | null>(null);
  const [readErr, setReadErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<ProductKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    readKindFacts(projectId)
      .then(({ facts, choice }) => {
        if (!live) return;
        setRead({ proposal: proposeKind(facts), choice });
        // Open on a project that has not decided: it is the first step.
        setOpen(!choice);
      })
      .catch((e) => live && setReadErr(errText(e)));
    return () => {
      live = false;
    };
  }, [projectId, round]);

  if (readErr) return <div className={common.error}>{t('kind_read_failed', { error: readErr })}</div>;
  if (!read) return null;
  const { proposal, choice } = read;
  const status = kindStatus(choice, proposal);
  const chosen = picked ?? choice?.kind ?? proposal.kind;

  const confirm = async () => {
    setBusy(true);
    setErr(null);
    try {
      // Read fresh, set the one field, write back: as the sources do.
      const cfg = (await productApi.projectConfig(projectId).catch(() => null)) ?? {};
      await productApi.putProjectConfig(projectId, withKind(cfg, chosen, proposal.kind, null));
      setPicked(null);
      setOpen(false);
      setRound((r) => r + 1);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={common.card} data-product-kind={choice?.kind ?? 'undecided'}>
      <div className={common.row}>
        <span className={styles.strong}>{t('kind_title')}</span>
        <StatusChip tone="warn" title={t('experimental_title')}>
          {t('experimental')}
        </StatusChip>
        {choice ? (
          <StatusChip tone="ok" data-product-kind-confirmed="">
            {KIND_TITLE[choice.kind]}
          </StatusChip>
        ) : (
          <StatusChip tone="info" data-product-kind-proposed={proposal.kind}>
            {t('proposed', { kind: KIND_TITLE[proposal.kind] })}
          </StatusChip>
        )}
        <span className={`${common.muted} ${common.small} ${common.grow}`}>{status.text}</span>
        <Button
          type="button"
          size="sm"
          variant={choice ? 'ghost' : 'default'}
          onClick={() => setOpen((o) => !o)}
          data-product-kind-open
        >
          {open ? t('close') : choice ? t('change') : t('decide')}
        </Button>
      </div>
      {open && (
        <div className={common.stack}>
          <div>
            <div className={`${styles.strong} ${common.small}`}>{t('why', { kind: KIND_TITLE[proposal.kind] })}</div>
            <ul className={styles.reasons} data-product-kind-reasons>
              {proposal.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
          <div role="radiogroup" aria-label={t('kind_title')} className={common.stack}>
            {[proposal.kind, ...proposal.alternatives].map((id) => {
              const k = PRODUCT_KINDS.find((x) => x.id === id)!;
              return (
                <label key={k.id} className={`${styles.kindOption} ${chosen === k.id ? styles.kindChosen : ''}`}>
                  <input
                    type="radio"
                    name={`pkind-${projectId}`}
                    checked={chosen === k.id}
                    onChange={() => setPicked(k.id)}
                    data-product-kind-option={k.id}
                  />
                  <span>
                    <div className={styles.strong}>
                      {k.title}
                      {k.id === proposal.kind && <span className={common.muted}> · {t('proposed_mark')}</span>}
                    </div>
                    <div className={common.small}>{k.what}</div>
                    <div className={`${common.muted} ${common.small}`}>{k.builds}</div>
                  </span>
                </label>
              );
            })}
          </div>
          {err && <div className={common.error}>{err}</div>}
          <div className={common.row}>
            <Button
              type="button"
              size="sm"
              disabled={busy || (!!choice && chosen === choice.kind)}
              onClick={() => void confirm()}
              data-product-kind-confirm
            >
              {busy
                ? t('saving')
                : chosen === proposal.kind
                  ? t('confirm', { kind: KIND_TITLE[chosen] })
                  : t('use', { kind: KIND_TITLE[chosen] })}
            </Button>
            <span className={`${common.muted} ${common.small}`}>{t('kept_note')}</span>
          </div>
        </div>
      )}
    </section>
  );
}
