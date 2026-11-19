/**
 * How the product is assembled (ADR-0072, ADR-0074), on Project › Product
 * beside its header's action: the strategy the project uses and where that
 * comes from (its own choice, the organization's default, the kits'), the
 * choice itself, and "Propose gears", which asks the chosen strategy for picks.
 * The strategies offered are the ones the installed kits provide:
 *
 * - `spec_mapping` (the Spec mapping kit): what spec-mapping's plan offers for
 *   the capabilities no pick answers yet;
 * - `gears_matcher` (the Gears matcher kit): what the latest finished gear
 *   match proposes (its Project › Gear match runs it); usable only where the
 *   service is configured, otherwise the server falls back and this says why.
 *
 * With neither kit the product is assembled by hand in the configurator: no
 * proposals, and the panel says so and points to Kits. With one, it is the
 * strategy, with nothing to choose.
 *
 * Either way the proposals go through the engine's completion first, and into
 * the product only when the person confirms them (nothing applied silently).
 */

import { useEffect, useState } from 'react';
import { Badge, Button } from '@gears-frontx/ui-kit';
import { productApi, type GearConfig, type ProductChange, type ProjectProduct } from '../../../api/client';
import {
  isFinished,
  matcherProposals,
  matcherUnavailable,
  offeredStrategies,
  organizationStrategy,
  projectChoice,
  specMappingProposals,
  type AssemblyStrategy,
  type ProjectChoice,
  type Proposal,
  type StrategyId,
  type StrategyUsed,
} from '../../../model/assembly';
import { isRunning } from '../../../model/gear-match';
import { useAssemblyTranslations } from '../../../i18n';
import { openScreen } from '@constructor-studio/mfe-shared';
import { errText, openTab, Segmented, StatusChip, useScope } from '../../common';
import { catalogueNames, indexCatalogue, pickNames } from '../../../model/product-configurator';
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

/** Project › Kits, where a project installs a strategy kit for itself. */
const PROJECT_KITS_ROUTE = '/project-kits';

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
    if (a.strategy === 'manual') return;
    const strategy: StrategyId = a.strategy;
    setBusy('propose');
    setErr(null);
    setNote(null);
    setPending(null);
    try {
      // The catalogue the product reads: a gear outside it cannot be picked.
      // Unreadable, nothing is held back on its account.
      const [record, index] = await Promise.all([
        productApi.projectProduct(projectId),
        productApi
          .gearboxCatalogue()
          .then((r) => indexCatalogue(r.catalogue, r, projectId))
          .catch(() => null),
      ]);
      const names = index ? catalogueNames(index) : null;
      const saved = record?.gears ?? [];
      // Compared under every spelling (id or crate); what is saved stays as it was.
      const picks = pickNames(saved, index);
      let items: Proposal[];
      if (a.strategy === 'gears_matcher') {
        // The latest *finished* match (newest first): a run that is still
        // going, failed or was stopped since does not hide the one before it.
        const runs = (await productApi.gearMatches(projectId)).items;
        const finished = runs.find((m) => isFinished(m.state));
        if (!finished) {
          setNote(
            runs.length === 0
              ? t('no_match')
              : runs.some((m) => isRunning(m.state))
                ? t('match_not_finished')
                : t('no_finished_match', { state: t(`run_${runs[0].state}`) })
          );
          return;
        }
        const match = await productApi.gearMatch(projectId, finished.match_id);
        items = matcherProposals(match, picks, names);
        if (items.length === 0) {
          setNote(t('nothing_from_match', { date: new Date(finished.created_at).toLocaleString() }));
          return;
        }
      } else {
        items = specMappingProposals((await productApi.projectPlan(projectId)).items, picks, names);
      }
      if (items.length === 0) {
        setNote(t('nothing_to_propose'));
        return;
      }
      const done = await productApi.completeProduct([...saved, ...items.map((p) => p.gear)], record?.config ?? {});
      setPending({ strategy, items, record, gears: done.gears, config: done.config, changes: done.changes });
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

  const strategyLabel = (s: StrategyUsed) => t(`strategy_${s}`);
  const kits = offeredStrategies(a);
  // Why the matcher cannot be chosen, said under the choice rather than only
  // in the disabled button's tooltip, which a pointer-less reader never sees.
  // Only where its kit is installed: a strategy whose kit is not is not offered.
  const unavailable = a.strategies.includes('gears_matcher') ? matcherUnavailable(a) : null;
  const unavailableText = unavailable
    ? t(`unavailable_${unavailable}`, { reason: a.gears_matcher.missing ?? '' })
    : null;
  // The installed strategies; a project's earlier choice whose kit went stays
  // visible, disabled, so the fallback reads against something.
  const listed: StrategyId[] = [...a.strategies];
  const own = a.project ?? null;
  if (own && !listed.includes(own)) listed.push(own);
  const choices: { id: ProjectChoice; label: string; title?: string; disabled?: boolean }[] = [
    { id: 'default', label: t('choice_default', { strategy: strategyLabel(organizationStrategy(a)) }) },
    ...listed.map((s) => {
      const kit = kits.find((k) => k.id === s);
      return {
        id: s as ProjectChoice,
        label: strategyLabel(s),
        title: kit && !kit.offered ? (kit.reason ?? unavailableText ?? t('not_offered')) : t(`hint_${s}`),
        // Not usable here: still shown, so the person sees it exists and why not.
        disabled: (!kit || !kit.offered) && projectChoice(a) !== s,
      };
    }),
  ];
  // With no strategy kit: by hand, and where to get one.
  if (a.strategies.length === 0 && a.strategy === 'manual') {
    return (
      <div className={page.card} data-product-assembly="manual">
        <div className={page.row}>
          <b>{t('title')}</b>
          <StatusChip tone="neutral" data-product-assembly-effective="manual">
            {strategyLabel('manual')}
          </StatusChip>
          <Button type="button" size="sm" variant="ghost" onClick={() => openScreen(bridge, PROJECT_KITS_ROUTE)} data-product-assembly-kits>
            {t('open_kits')}
          </Button>
        </div>
        <span className={`${page.small} ${page.muted}`} data-product-assembly-manual>
          {t('manual_no_kits')}
        </span>
        {a.fallback && (
          <span className={`${page.small} ${page.error}`} data-product-assembly-fallback={a.fallback.code}>
            {t('fallback_manual', { chosen: strategyLabel(a.chosen), reason: a.fallback.reason })}
          </span>
        )}
      </div>
    );
  }
  // What the completion did beyond the proposals, with the engine's reason,
  // and which gears it kept that still want settings: confirming saves them
  // as they are, and the product will not resolve until they are given.
  const added = pending?.changes.filter((c) => c.added && !c.needs?.length) ?? [];
  const needs = pending?.changes.filter((c) => c.needs?.length) ?? [];

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
        {a.strategy !== 'manual' && (
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
        )}
        {a.strategy === 'gears_matcher' && (
          <Button type="button" size="sm" variant="ghost" onClick={() => openTab(bridge, 'gearMatch')}>
            {t('open_gear_match')}
          </Button>
        )}
      </div>
      {a.fallback && (
        <span className={`${page.small} ${page.error}`} data-product-assembly-fallback={a.fallback.code}>
          {a.strategy === 'manual'
            ? t('fallback_manual', { chosen: strategyLabel(a.chosen), reason: a.fallback.reason })
            : t('fallback', { chosen: strategyLabel(a.chosen), used: strategyLabel(a.strategy), reason: a.fallback.reason })}
        </span>
      )}
      {a.settable && listed.length > 1 && (
        <Segmented
          label={t('choice_label')}
          value={projectChoice(a)}
          onChange={(c) => void choose(c)}
          dataAttr="data-product-assembly-choice"
          items={choices.map((c) => ({ ...c, disabled: c.disabled || busy !== null }))}
        />
      )}
      {unavailableText && !a.fallback && (
        <span className={`${page.small} ${page.muted}`} data-product-assembly-unavailable={unavailable ?? ''}>
          {t('unavailable', { strategy: strategyLabel('gears_matcher'), reason: unavailableText })}
        </span>
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
          {added.map((c) => (
            <span key={c.gear} className={`${page.small} ${page.muted}`} data-product-assembly-change={c.gear}>
              {t('completion_adds', { gear: c.gear, reason: c.reason })}
            </span>
          ))}
          {needs.map((c) => (
            <span key={c.gear} className={`${page.small} ${page.error}`} data-product-assembly-needs={c.gear}>
              {t('completion_needs', { gear: c.gear, settings: (c.needs ?? []).join(', ') })}
            </span>
          ))}
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
