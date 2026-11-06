import React, { useEffect, useRef, useState } from 'react';
import type { ChildMfeBridge } from '@gears-frontx/react';
import {
  apiRegistry,
  useApiQuery,
  FRONTX_SHARED_PROPERTY_THEME,
  FRONTX_SHARED_PROPERTY_LANGUAGE,
} from '@gears-frontx/react';
import { Empty, EmptyDescription, Skeleton } from '@gears-frontx/ui-kit';
import { KitsApiService, type CatalogKit } from '../../api/KitsApiService';
import { useHomeTranslations } from '../../i18n';
import styles from './HomeScreen.module.css';


const RTL_LANGUAGES = ['ar', 'he', 'fa', 'ur'];

/**
 * A host theme is a full palette, not a light/dark bit, so it bridges to the
 * kit's two scopes by explicit enumeration. `dracula` therefore lands in the
 * kit's dark greys, not Dracula's purples — a stated residual limitation.
 * The screen root always carries data-theme so the kit's
 * prefers-color-scheme fallback cannot leak through.
 */
const DARK_HOST_THEMES = ['dark', 'dracula', 'dracula-large'];

function toKitTheme(hostTheme: string): 'dark' | 'light' {
  return DARK_HOST_THEMES.includes(hostTheme) ? 'dark' : 'light';
}

function readBridgeProperty(bridge: ChildMfeBridge, property: string, fallback: string): string {
  const current = bridge.getProperty(property);
  return current && typeof current.value === 'string' ? current.value : fallback;
}

/**
 * Props for the HomeScreen component.
 */
interface HomeScreenProps {
  bridge: ChildMfeBridge;
}

/**
 * Platform › Kits: the kit library (ADR-0068 §4, ADR-0069 §4). Lists the
 * catalogue the `studio-kits` gear keeps; installing a kit as a base kit
 * arrives with the installer.
 */
export const HomeScreen: React.FC<HomeScreenProps> = ({ bridge }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  // Initial value read directly from the bridge's lazy useState initializer (runs once,
  // synchronously, during the first render) instead of via setState in a mount effect —
  // this avoids an extra render and the set-state-in-effect anti-pattern. The effect
  // below only subscribes for subsequent property changes.
  const [theme, setTheme] = useState<string>(() =>
    readBridgeProperty(bridge, FRONTX_SHARED_PROPERTY_THEME, 'default')
  );
  const [language, setLanguage] = useState<string>(() =>
    readBridgeProperty(bridge, FRONTX_SHARED_PROPERTY_LANGUAGE, 'en')
  );
  // The lazy initializers above run only on mount; if the host swaps the bridge
  // instance, re-read its current properties during render ("adjusting state
  // during render") — the subscription effect only delivers future changes.
  const [prevBridge, setPrevBridge] = useState(bridge);
  if (prevBridge !== bridge) {
    setPrevBridge(bridge);
    setTheme(readBridgeProperty(bridge, FRONTX_SHARED_PROPERTY_THEME, 'default'));
    setLanguage(readBridgeProperty(bridge, FRONTX_SHARED_PROPERTY_LANGUAGE, 'en'));
  }

  const { t, loading } = useHomeTranslations();
  const catalog = useApiQuery(apiRegistry.getService(KitsApiService).catalog);
  const kits: CatalogKit[] = catalog.data?.items ?? [];

  useEffect(() => {
    const themeUnsubscribe = bridge.subscribeToProperty(
      FRONTX_SHARED_PROPERTY_THEME,
      (property) => {
        if (typeof property.value === 'string') {
          setTheme(property.value);
        }
      }
    );

    const languageUnsubscribe = bridge.subscribeToProperty(
      FRONTX_SHARED_PROPERTY_LANGUAGE,
      (property) => {
        if (typeof property.value === 'string') {
          setLanguage(property.value);
        }
      }
    );

    return () => {
      themeUnsubscribe();
      languageUnsubscribe();
    };
  }, [bridge]);

  // Keep the Shadow DOM host's text direction in sync with the active language.
  // An effect keyed by `language` (rather than logic inside the subscription
  // callback) also covers the initial language, which never fires a callback.
  useEffect(() => {
    const rootNode = containerRef.current?.getRootNode();
    if (rootNode && 'host' in rootNode) {
      (rootNode.host as HTMLElement).dir = RTL_LANGUAGES.includes(language) ? 'rtl' : 'ltr';
    }
  }, [language]);

  // Show skeleton while translations are loading
  if (loading) {
    return (
      <div ref={containerRef} className={styles.screen} data-theme={toKitTheme(theme)}>
        <Skeleton className={styles.skeletonTitle} />
        <Skeleton className={styles.skeletonLine} />
      </div>
    );
  }

  return (
    <div ref={containerRef} className={styles.screen} data-theme={toKitTheme(theme)}>
      <h2 className={styles.title}>{t('title')}</h2>
      <p className={styles.description}>{t('description')}</p>
      {catalog.isLoading ? (
        <Skeleton className={styles.skeletonLine} />
      ) : catalog.isError ? (
        <p role="alert" className={styles.error}>
          {t('loading_failed', { error: String(catalog.error) })}
        </p>
      ) : kits.length === 0 ? (
        <Empty className={styles.empty}>
          <EmptyDescription>{t('empty')}</EmptyDescription>
        </Empty>
      ) : (
        <ul className={styles.grid}>
          {kits.map((kit) => (
            <li key={kit.slug} className={styles.card} data-kit={kit.slug}>
              <h3 className={styles.cardTitle}>{kit.name}</h3>
              <p className={styles.cardText}>{kit.description}</p>
              <dl className={styles.facts}>
                <dt>{t('publisher')}</dt>
                <dd>{kit.publisher}</dd>
                <dt>{t('version')}</dt>
                <dd>{kit.default_version}</dd>
                <dt>{t('repository')}</dt>
                <dd>
                  <a href={kit.repository_url} target="_blank" rel="noreferrer">
                    {kit.repository_url.replace('https://', '')}
                  </a>
                </dd>
              </dl>
              <p className={styles.note}>{t('base_kit_pending')}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

HomeScreen.displayName = 'HomeScreen';
