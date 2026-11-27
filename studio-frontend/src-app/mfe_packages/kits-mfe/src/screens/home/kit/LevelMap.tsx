/**
 * Where a kit appears (#1099): for each level it puts screens on, that level's
 * tab bar as the shell draws it, the shell's tabs muted and the kit's
 * highlighted. A kit tab is a real tab (arrow keys, Home, End): selecting it
 * shows the picture the newest build took of the screen, with its label and
 * route; a screen with no picture says so and shows its route.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ScreenPreview } from '../../../api/KitsApiService';
import { pictureFor, type LevelMap as Level, type LevelTab } from '../../../model/kitPage';
import type { Text } from './text';
import styles from './KitPage.module.css';

/** The pictures of one micro-frontend: still being read, read, or not readable. */
type Pictures = 'loading' | ScreenPreview[] | 'failed';

export interface LevelMapProps {
  levels: Level[];
  /** Reads a micro-frontend's pictures (`GET /screen-previews?component=`). */
  loadPreviews: (component: string) => Promise<ScreenPreview[]>;
  t: Text;
}

export const LevelMap: React.FC<LevelMapProps> = ({ levels, loadPreviews, t }) => {
  const [pictures, setPictures] = useState<Record<string, Pictures>>({});
  const asked = useRef(new Set<string>());
  const want = useCallback(
    (component: string | null) => {
      if (!component || asked.current.has(component)) return;
      asked.current.add(component);
      setPictures((p) => ({ ...p, [component]: 'loading' }));
      loadPreviews(component).then(
        (items) => setPictures((p) => ({ ...p, [component]: items })),
        () => setPictures((p) => ({ ...p, [component]: 'failed' }))
      );
    },
    [loadPreviews]
  );
  return (
    <div className={styles.columns} data-level-map>
      {levels.map((level) => (
        <LevelBar key={level.level} level={level} pictures={pictures} want={want} t={t} />
      ))}
    </div>
  );
};

LevelMap.displayName = 'LevelMap';

const LevelBar: React.FC<{
  level: Level;
  pictures: Record<string, Pictures>;
  want: (component: string | null) => void;
  t: Text;
}> = ({ level, pictures, want, t }) => {
  const mine = level.tabs.filter((tab) => tab.mine);
  const [selected, setSelected] = useState<string | null>(mine[0]?.key ?? null);
  const current = mine.find((tab) => tab.key === selected) ?? mine[0] ?? null;
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const id = `kit-level-${level.level}`;

  useEffect(() => {
    if (current) want(current.component);
  }, [current, want]);

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    const last = mine.length - 1;
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? index === last
          ? 0
          : index + 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? index === 0
            ? last
            : index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    const tab = mine[next];
    setSelected(tab.key);
    refs.current.get(tab.key)?.focus();
  };

  return (
    <section className={styles.level} aria-labelledby={`${id}-name`} data-level={level.level}>
      <h5 id={`${id}-name`} className={styles.levelName}>
        {t(`level_${level.level}`)}
      </h5>
      <div className={styles.tabBar} role="tablist" aria-label={t('map_bar', { level: t(`level_${level.level}`) })}>
        {level.tabs.map((tab) => {
          const at = mine.indexOf(tab);
          const classes = [styles.tab, tab.settings ? styles.tabSettings : ''];
          if (!tab.mine) {
            return (
              <span
                key={tab.key}
                className={classes.join(' ')}
                data-level-tab={tab.label}
                data-mine="false"
                title={t('map_shell_tab')}
              >
                {tab.label}
              </span>
            );
          }
          const isCurrent = tab === current;
          classes.push(styles.tabMine);
          if (tab.source !== 'screen') classes.push(styles.tabNew);
          return (
            <button
              key={tab.key}
              ref={(node) => {
                if (node) refs.current.set(tab.key, node);
                else refs.current.delete(tab.key);
              }}
              type="button"
              role="tab"
              id={`${id}-${tab.key}`}
              aria-selected={isCurrent}
              aria-controls={`${id}-panel`}
              tabIndex={isCurrent ? 0 : -1}
              className={classes.join(' ')}
              data-level-tab={tab.label}
              data-mine="true"
              title={tab.source === 'screen' ? undefined : t('map_tab_new')}
              onClick={() => setSelected(tab.key)}
              onKeyDown={(event) => onKeyDown(event, at)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {current && (
        <div
          id={`${id}-panel`}
          role="tabpanel"
          aria-labelledby={`${id}-${current.key}`}
          className={styles.panel}
          data-preview-panel={current.label}
        >
          <Preview tab={current} pictures={current.component ? pictures[current.component] : undefined} t={t} />
        </div>
      )}
      {level.sections.length > 0 && (
        <p className={styles.sections}>
          {t('map_sections', {
            list: level.sections.map((s) => (s.slot ? `${s.label} (${s.slot})` : s.label)).join(', '),
          })}
        </p>
      )}
    </section>
  );
};

const Preview: React.FC<{ tab: LevelTab; pictures: Pictures | undefined; t: Text }> = ({ tab, pictures, t }) => {
  const routeLine = tab.route ? (
    <code className={styles.mono}>{tab.route}</code>
  ) : tab.target ? (
    <span>{t('map_model_tab', { target: tab.target })}</span>
  ) : (
    <span>{t('map_no_route')}</span>
  );
  if (pictures === 'loading') {
    return (
      <div className={styles.placeholder} data-preview="loading">
        <span>{t('map_preview_loading')}</span>
        {routeLine}
      </div>
    );
  }
  const picture = Array.isArray(pictures) ? pictureFor(pictures, { route: tab.route, label: tab.label }) : null;
  if (!picture) {
    return (
      <div className={styles.placeholder} data-preview="none">
        <b>{tab.label}</b>
        <span>{t('map_no_picture')}</span>
        {routeLine}
      </div>
    );
  }
  return (
    <figure className={styles.preview} data-preview="picture">
      <img src={picture.image} alt={t('map_picture_alt', { label: tab.label })} loading="lazy" />
      <figcaption className={styles.caption}>
        <b>{picture.label ?? tab.label}</b> · <code className={styles.mono}>{picture.route}</code>
      </figcaption>
    </figure>
  );
};
