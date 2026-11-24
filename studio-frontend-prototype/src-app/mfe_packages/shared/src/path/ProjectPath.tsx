/**
 * The project's path as one strip of stage chips: the same component, the
 * same numbers and the same words on Overview (the whole path), Product
 * (Product to Deploy) and Releases (Build to Deploy).
 *
 * Each chip: its number, its name, its state in colour (design tokens); its
 * cause on hover and in the line under the strip, which also carries what
 * moves it on. A click goes to the tab that holds the stage's evidence
 * through the shell (`openScreen`), unless the screen keeps that stage
 * itself (`onSelect`): Releases shows a stage under the strip, Product opens
 * its save. A tab that is not here, or whose kit is not installed, gets no
 * navigation rather than a dead one.
 */

import React, { useState } from 'react';
import { useMfeBridge } from '@gears-frontx/react';
import { Button } from '@gears-frontx/ui-kit';
import { openScreen } from '../host/hostActions';
import { useScreenAvailability } from '../host/screens';
import { createScreenTranslations } from '../i18n/screenText';
import type { TranslationModules } from '../i18n/screenTranslations';
import { STAGE_TAB_ROUTE, type PathStage, type StageState } from './stages';
import styles from './ProjectPath.module.css';

const useText = createScreenTranslations(
  'shared',
  'project-path',
  import.meta.glob('./i18n/*.json') as TranslationModules,
  './i18n'
);

/** A state drawn as a sign in place of the number; the number then leads the name. Running is a turning ring. */
const MARK: Partial<Record<StageState, string>> = { done: '✓', failed: '✕', blocked: '!', unknown: '?', running: '' };

/** Whether the dictionary had `key`: a missing one comes back as the key. */
const has = (value: string, key: string) => value !== key && !value.endsWith(`:${key}`);

export interface ProjectPathProps {
  stages: readonly PathStage[];
  /** The stages this screen shows (numbered as on the whole path); all when absent. */
  only?: readonly string[];
  /** The stage the screen shows below the strip: the chips are its tabs. */
  selected?: string | null;
  /** A stage the screen keeps itself: return true when handled here. */
  onSelect?: (stage: PathStage) => boolean;
  /** The line's button for a stage the screen acts on itself (Build, Deploy, Save): true when handled. */
  onAction?: (stage: PathStage) => boolean;
  /** With `selected`: the chips are tabs with these ids (`<prefix><stage>`) controlling `panelId`. */
  tabIdPrefix?: string;
  panelId?: string;
  /** Opens a route; the shell's `openScreen` by default. */
  onOpen?: (route: string) => void;
  /** Still reading: the strip says so rather than nothing. */
  reading?: boolean;
}

export const ProjectPath: React.FC<ProjectPathProps> = ({
  stages,
  only,
  selected = null,
  onSelect,
  onAction,
  tabIdPrefix,
  panelId,
  onOpen,
  reading = false,
}) => {
  const { t } = useText();
  const bridge = useMfeBridge();
  const screens = useScreenAvailability();
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  // The screen moved to another stage itself: the line follows it.
  const [seen, setSeen] = useState(selected);
  if (seen !== selected) {
    setSeen(selected);
    setPinned(null);
    setHovered(null);
  }
  const shown = only ? stages.filter((s) => only.includes(s.id)) : [...stages];
  const tabs = !!tabIdPrefix && selected !== null;

  const label = (s: PathStage) => {
    const key = `stage_${s.id}`;
    const v = t(key);
    return has(v, key) ? v : (s.title ?? s.id);
  };
  const stateWord = (s: PathStage) => t(`state_${s.state}`);
  const routeOf = (s: PathStage) => {
    const route = STAGE_TAB_ROUTE[s.tab] ?? null;
    return route && screens.route(route) && screens.kit(s.kit ?? null) ? route : null;
  };
  const open = (route: string) => (onOpen ? onOpen(route) : openScreen(bridge, route));
  const pick = (s: PathStage) => {
    setPinned(s.id);
    setHovered(null);
    if (onSelect?.(s)) return;
    const route = routeOf(s);
    if (route) open(route);
  };

  const detail =
    shown.find((s) => s.id === hovered) ??
    shown.find((s) => s.id === pinned) ??
    shown.find((s) => s.id === selected) ??
    shown.find((s) => s.focus) ??
    null;
  const done = shown.filter((s) => s.state === 'done').length;

  const actionLabel = (s: PathStage) => {
    const a = s.action;
    if (!a) return null;
    const key = a.kind === 'open' ? `open_${s.tab}` : `action_${a.kind}`;
    const v = t(key);
    return has(v, key) ? v : a.label;
  };
  const act = (s: PathStage) => {
    if (onAction?.(s)) return;
    if (onSelect?.(s)) return;
    const route = routeOf(s);
    if (route) open(route);
  };
  const detailAction = detail && detail.state !== 'done' ? actionLabel(detail) : null;
  const detailRoute = detail ? routeOf(detail) : null;
  const canAct = !!detail && (!!onAction || !!onSelect || !!detailRoute);

  return (
    <nav className={styles.path} aria-label={t('label')} data-project-path>
      <div className={styles.head}>
        <h3 className={styles.title}>{t('title')}</h3>
        {shown.length > 0 && (
          <span
            className={`${styles.progress} ${done === shown.length ? styles.progressDone : ''}`}
            data-path-progress={`${done}/${shown.length}`}
          >
            {t.count('progress', shown.length, { done })}
          </span>
        )}
      </div>
      {shown.length === 0 ? (
        <p className={styles.muted} data-path-empty>
          {reading ? t('reading') : t('not_known')}
        </p>
      ) : (
        <ol className={styles.stages} role={tabs ? 'tablist' : undefined} aria-orientation={tabs ? 'horizontal' : undefined}>
          {shown.map((s) => {
            const isSelected = tabs ? selected === s.id : undefined;
            return (
              <li key={s.id} className={styles.item}>
                <button
                  type="button"
                  role={tabs ? 'tab' : undefined}
                  id={tabs ? `${tabIdPrefix}${s.id}` : undefined}
                  aria-selected={isSelected}
                  aria-controls={tabs ? panelId : undefined}
                  aria-current={s.focus ? 'step' : undefined}
                  className={styles.stage}
                  data-stage={s.id}
                  data-stage-state={s.state}
                  data-focus={s.focus ? '' : undefined}
                  title={`${s.number}. ${label(s)} — ${stateWord(s)}: ${s.cause}`}
                  onClick={() => pick(s)}
                  onMouseEnter={() => setHovered(s.id)}
                  onFocus={() => setHovered(s.id)}
                >
                  <span className={styles.number} data-mark={s.state} aria-hidden="true">
                    {MARK[s.state] ?? s.number}
                  </span>
                  <span className={styles.name}>
                    {MARK[s.state] !== undefined ? `${s.number}. ` : ''}
                    {label(s)}
                  </span>
                  <span className={styles.srOnly}>, {stateWord(s)}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {detail && (
        <div className={styles.detail} data-stage-detail={detail.id} aria-live="polite">
          <span className={styles.detailHead} data-stage-state={detail.state}>
            {detail.number}. {label(detail)} · {stateWord(detail)}
          </span>
          <span className={styles.cause}>{detail.cause}</span>
          {detailAction && canAct && (
            <Button
              size="sm"
              variant={detail.focus ? 'default' : 'outline'}
              data-stage-action={detail.action?.kind}
              onClick={() => act(detail)}
            >
              {detailAction}
            </Button>
          )}
        </div>
      )}
    </nav>
  );
};

ProjectPath.displayName = 'ProjectPath';
