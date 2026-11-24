/**
 * The release map (owner feedback, 2026-11-24): Build → Images → Environment
 * → Deploy as four connected nodes, each with its state and the one fact
 * that says it -- the build and how it went, how many images and where they
 * live, the environment and where it runs, the deploy with the address it
 * answers at or why it failed. A node is the tab of its stage: picking one
 * shows that stage under the map.
 */

import React from 'react';
import { STATE_LABELS } from '../../model/environments';
import { RESEARCH_STEPS } from '../../model/research-progress';
import { STAGES, type ReleaseMap as Map, type StageId, type StageState } from '../../model/release-map';
import { environmentTarget, type TargetNames } from '../../model/environment-targets';
import { versionOf } from '../../model/releases';
import { TargetIcon } from './Targets';
import { relTime, useReleases, type Text } from './parts';
import styles from './ReleasesScreen.module.css';

const WHERE = ['studio', 'desktop', 'session', 'ci', 'research'];

const MARK: Record<StageState, string> = { done: '✓', running: '', failed: '✕', blocked: '!', todo: '' };

/** A step a build reported, in the screen's words. */
function stepWord(t: Text, step: string | null): string | null {
  if (!step) return null;
  return (RESEARCH_STEPS as readonly string[]).includes(step) ? t(`progress_step_${step}`) : step;
}

interface Node {
  fact: React.ReactNode;
  sub: React.ReactNode;
  /** A second line under `sub`: the address, the cause. */
  more?: React.ReactNode;
  icon?: React.ReactNode;
}

function nodes(map: Map, names: TargetNames, t: Text, language: string, productMissing: boolean): Record<StageId, Node> {
  const b = map.build.current;
  const when = (iso: string | null | undefined) => (iso ? relTime(iso, language) : null);
  const build: Node = productMissing
    ? { fact: t('map_no_product'), sub: t('no_product_short') }
    : !b
      ? { fact: t('map_build_none'), sub: t('map_build_none_sub') }
      : {
          fact: <code>{b.buildId}</code>,
          sub: [
            map.build.state === 'running'
              ? stepWord(t, b.step)
                ? t('map_build_running_at', { step: stepWord(t, b.step) ?? '' })
                : t('map_build_running')
              : map.build.state === 'failed'
                ? b.failureStep
                  ? t('map_build_failed_at', { step: stepWord(t, b.failureStep) ?? b.failureStep })
                  : t('map_build_failed')
                : t(`map_build_${b.status === 'passed' || b.status === 'cancelled' ? b.status : 'unknown'}`),
            WHERE.includes(b.where) ? t(`map_where_${b.where}`) : b.where,
            when(b.finishedAt ?? b.startedAt),
          ]
            .filter(Boolean)
            .join(' · '),
        };

  const i = map.images;
  const placeText = i.place
    ? i.place.kind === 'research'
      ? t('map_images_in_research')
      : i.place.host
        ? t('map_images_in_registry', { host: i.place.host })
        : t('map_images_in_default_registry')
    : null;
  const images: Node = !i.build
    ? { fact: t('map_images_none'), sub: t('map_images_none_sub') }
    : i.count === 0
      ? {
          fact: i.build.chartVersion ? t('map_images_chart', { version: i.build.chartVersion }) : t('map_images_none'),
          sub: i.state === 'running' ? t('map_images_waiting') : t('map_images_from', { build: i.build.buildId }),
        }
      : {
          fact: t('map_images_count', { done: i.count, total: i.count }),
          sub: [placeText, i.build.buildId !== b?.buildId ? t('map_images_from', { build: i.build.buildId }) : null]
            .filter(Boolean)
            .join(' · '),
          more:
            i.state === 'blocked'
              ? t('map_images_failed_build')
              : i.fits.length === 0
                ? t('map_images_nowhere')
                : null,
        };

  const s = map.environment.step;
  const target = s ? environmentTarget(s.environment, s.namespace, names) : null;
  const environment: Node = !s
    ? { fact: t('map_environment_none'), sub: t('map_environment_none_sub') }
    : {
        icon: target && <TargetIcon kind={target.kind} />,
        fact: s.environment.name,
        sub:
          target?.kind === 'kubernetes'
            ? `${t('target_kind_kubernetes')} · ${target.namespace}`
            : `${t('target_kind_research')} · ${target?.kind === 'research' ? (target.project ?? '—') : ''}`,
        more: map.environment.gap ? t(`map_gap_${map.environment.gap}`) : null,
      };

  const d = map.deploy.deployment;
  const deploy: Node = !d
    ? { fact: t('map_deploy_none'), sub: s ? t('map_deploy_none_sub', { environment: s.environment.name }) : t('map_environment_none') }
    : {
        fact: STATE_LABELS[d.state] ?? d.state,
        sub: [versionOf(d) ?? d.product, when(d.requested_at)].filter(Boolean).join(' · '),
        more: map.deploy.url ? (
          <span className={styles.mapUrl}>{map.deploy.url.replace(/^https?:\/\//, '')}</span>
        ) : (
          map.deploy.cause
        ),
      };
  return { build, images, environment, deploy };
}

export function ReleaseMap({
  map,
  names,
  selected,
  onSelect,
  productMissing,
}: {
  map: Map;
  names: TargetNames;
  selected: StageId;
  onSelect: (stage: StageId) => void;
  productMissing: boolean;
}) {
  const { t, language } = useReleases();
  const shown = nodes(map, names, t, language, productMissing);
  return (
    <nav className={styles.map} aria-label={t('map_label')} data-release-map>
      <ol className={styles.mapList} role="tablist" aria-orientation="horizontal">
        {STAGES.map((stage, n) => {
          const state = map[stage].state;
          const node = shown[stage];
          return (
            <li key={stage} className={styles.mapItem} data-map-item={stage}>
              {n > 0 && (
                <span
                  className={styles.mapLink}
                  data-map-link-state={map[STAGES[n - 1]].state}
                  aria-hidden="true"
                />
              )}
              <button
                type="button"
                role="tab"
                id={`release-stage-${stage}`}
                aria-selected={selected === stage}
                aria-controls="release-stage-panel"
                className={styles.mapNode}
                data-map-stage={stage}
                data-map-state={state}
                onClick={() => onSelect(stage)}
              >
                <span className={styles.mapHead}>
                  <span className={styles.mapMark} data-map-mark={state} aria-hidden="true">
                    {MARK[state] || n + 1}
                  </span>
                  <span className={styles.mapTitle}>{t(`stage_${stage}`)}</span>
                  <span className={styles.mapState}>{t(`stage_state_${state}`)}</span>
                </span>
                <span className={styles.mapFact} data-map-fact>
                  {node.icon}
                  <span className={styles.mapFactText}>{node.fact}</span>
                </span>
                <span className={styles.mapSub}>{node.sub}</span>
                {node.more && (
                  <span className={styles.mapMore} data-map-more>
                    {node.more}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
