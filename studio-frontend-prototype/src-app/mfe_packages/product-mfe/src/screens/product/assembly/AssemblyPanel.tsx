/**
 * How the product is assembled (ADR-0072), on Project › Product beside its
 * header's action: the strategy the project uses and where that comes from
 * (its own choice, the organization's default, Studio's), the choice itself,
 * and "Propose gears", which asks the chosen strategy for picks.
 *
 * - `spec_mapping`: what spec-mapping's plan offers for the capabilities no
 *   pick answers yet;
 * - `gears_matcher`: what the latest finished gear match proposes (the Gears
 *   matcher kit's Project › Gear match runs it). Offered only where that kit
 *   is installed and the service configured; otherwise the server falls back
 *   to `spec_mapping` and this says why.
 *
 * Either way the proposals go through the engine's completion first, and into
 * the product only when the person confirms them (nothing applied silently).
 */

import { useEffect, useState } from 'react';
import { Badge, Button } from '@gears-frontx/ui-kit';
import { isNotFound } from '@constructor-studio/mfe-shared';
import { productApi, type GearConfig, type ProductChange, type ProjectProduct } from '../../../api/client';
import {
  isFinished,
  matcherProposals,
  organizationStrategy,
  projectChoice,
  specMappingProposals,
  type AssemblyStrategy,
  type ProjectChoice,
  type Proposal,
  type StrategyId,
} from '../../../model/assembly';
import { useAssemblyTranslations } from '../../../i18n';
import { errText, openTab, Segmented, StatusChip, useScope } from '../../common';
import { indexCatalogue } from '../../../model/product-configurator';
import page from '../../product.module.css';

/** What the strategy proposed, completed by the engine, waiting for the person. */
interface Pending {
  strategy: StrategyId;
  items: Proposal[];
  record: ProjectProduct | null;
  gears: string[];
  config: GearConfig;
  changes: ProductChange[];
}

export function AssemblyPanel({ round, onChanged }: { round: number; onChanged: () => void }) {
  const { projectId, bridge } = useScope();
  const { t } = useAssemblyTranslations();
  const [a, setA] = useState<AssemblyStrategy | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  useEffect(() => {
    let live = true;
    productApi.assemblyStrategy(projectId).then(
      (r) => {
        if (!live) return;
        setA(r);
        setReadError(null);
      },
      (e: unknown) => live && setReadError(errText(e))
    );
    return () => {
      live = false;
    };
  }, [projectId, round]);

  // A server without the strategy (an older backend) leaves the page as it was.
  if (readError && !a) return null;
  if (!a) return null;

  const choose = async (choice: ProjectChoice) => {
    setBusy('choose');
    setErr(null);
    try {
      setA(await productApi.setAssemblyStrategy(projectId, choice === 'default' ? null : choice));
      setPending(null);
      setNote(null);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const propose = async () => {
    setBusy('propose');
    setErr(null);
    setNote(null);
    setPending(null);
    try {
      // The catalogue the product reads: a gear outside it cannot be picked.
      // Unreadable, nothing is held back on its account.
      const [record, names] = await Promise.all([
        productApi.projectProduct(projectId),
        productApi
          .gearboxCatalogue()
          .then((r) => {
            const index = indexCatalogue(r.catalogue, r, projectId);
            return new Set(index.gears.map((g) => index.name(g)));
          })
          .catch(() => null),
      ]);
      const picks = record?.gears ?? [];
      let items: Proposal[];
      if (a.strategy === 'gears_matcher') {
        const match = await productApi.gearMatch(projectId, 'latest').catch((e: unknown) => {
          if (isNotFound(e)) return null;
          throw e;
        });
        if (!match) {
          setNote(t('no_match'));
          return;
        }
        if (!isFinished(match.summary.state)) {
          setNote(t('match_not_finished'));
          return;
        }
        items = matcherProposals(match, picks, names);
      } else {
        items = specMappingProposals((await productApi.projectPlan(projectId)).items, picks, names);
      }
      if (items.length === 0) {
        setNote(t('nothing_to_propose'));
        return;
      }
      const done = await productApi.completeProduct([...picks, ...items.map((p) => p.gear)], record?.config ?? {});
      setPending({ strategy: a.strategy, items, record, gears: done.gears, config: done.config, changes: done.changes });
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const confirm = async () => {
    if (!pending) return;
    setBusy('confirm');
    setErr(null);
    try {
      const r = pending.record;
      await productApi.saveProjectProduct(projectId, {
        ...(r?.product_id ? { product_id: r.product_id } : {}),
        ...(r?.name ? { name: r.name } : {}),
        gears: pending.gears,
        config: pending.config,
      });
      // The matcher's proposals that went in are accepted, as Gear match's "Add" does.
      if (pending.strategy === 'gears_matcher') {
        await Promise.all(
          pending.items.flatMap((p) =>
            p.decisions.map((d) => productApi.putGearMatchDecision(projectId, { ...d, decision: 'accepted' }).catch(() => undefined))
          )
        );
      }
      setNote(t('added', { count: String(pending.items.length) }));
      setPending(null);
      onChanged();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const strategyLabel = (s: StrategyId) => t(`strategy_${s}`);
  const offered = a.gears_matcher.offered;
  const choices: { id: ProjectChoice; label: string; title?: string; disabled?: boolean }[] = [
    { id: 'default', label: t('choice_default', { strategy: strategyLabel(organizationStrategy(a)) }) },
    { id: 'spec_mapping', label: strategyLabel('spec_mapping'), title: t('hint_spec_mapping') },
    {
      id: 'gears_matcher',
      label: strategyLabel('gears_matcher'),
      title: offered ? t('hint_gears_matcher') : (a.gears_matcher.missing ?? t('not_offered')),
      // Not offered here: still shown, so the person sees it exists and why not.
      disabled: !offered && projectChoice(a) !== 'gears_matcher',
    },
  ];
  const added = pending?.changes.filter((c) => c.added && !pending.items.some((p) => p.gear === c.gear)) ?? [];

  return (
    <div className={page.card} data-product-assembly={a.strategy}>
      <div className={page.row}>
        <b>{t('title')}</b>
        <StatusChip tone={a.fallback ? 'warn' : 'neutral'} data-product-assembly-effective={a.strategy}>
          {strategyLabel(a.strategy)}
        </StatusChip>
        <span className={`${page.small} ${page.muted}`} data-product-assembly-source={a.source}>
          {t(`source_${a.source}`)}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void propose()}
          disabled={busy !== null}
          data-product-assembly-propose
        >
          {busy === 'propose' ? t('proposing') : t('propose')}
        </Button>
        {a.strategy === 'gears_matcher' && (
          <Button type="button" size="sm" variant="ghost" onClick={() => openTab(bridge, 'gearMatch')}>
            {t('open_gear_match')}
          </Button>
        )}
      </div>
      {a.fallback && (
        <span className={`${page.small} ${page.error}`} data-product-assembly-fallback={a.fallback.code}>
          {t('fallback', { chosen: strategyLabel(a.chosen), reason: a.fallback.reason })}
        </span>
      )}
      {a.settable && (
        <Segmented
          label={t('choice_label')}
          value={projectChoice(a)}
          onChange={(c) => void choose(c)}
          dataAttr="data-product-assembly-choice"
          items={choices.map((c) => ({ ...c, disabled: c.disabled || busy !== null }))}
        />
      )}
      {pending && (
        <div className={page.stack} data-product-assembly-pending>
          <span className={page.small}>{t('pending', { strategy: strategyLabel(pending.strategy) })}</span>
          {pending.items.map((p) => (
            <span key={p.gear} className={page.row} data-product-assembly-proposal={p.gear}>
              <Badge variant="info">{p.gear}</Badge>
              <span className={`${page.small} ${page.muted}`}>{p.answers.join(', ')}</span>
            </span>
          ))}
          {added.length > 0 && (
            <span className={`${page.small} ${page.muted}`}>
              {t('completion_adds', { gears: added.map((c) => c.gear).join(', ') })}
            </span>
          )}
          <span className={page.row}>
            <Button type="button" size="sm" onClick={() => void confirm()} disabled={busy !== null} data-product-assembly-confirm>
              {busy === 'confirm' ? t('adding') : t('confirm', { count: String(pending.items.length) })}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setPending(null)} disabled={busy !== null}>
              {t('discard')}
            </Button>
          </span>
        </div>
      )}
      {note && <span className={`${page.small} ${page.muted}`}>{note}</span>}
      {err && <span className={`${page.small} ${page.error}`}>{err}</span>}
    </div>
  );
}
