import React, { useEffect, useRef, useState } from 'react';
import type { ChildMfeBridge } from '@gears-frontx/react';
import {
  apiRegistry,
  useApiQuery,
  useSharedProperty,
  FRONTX_SHARED_PROPERTY_THEME,
  FRONTX_SHARED_PROPERTY_LANGUAGE,
} from '@gears-frontx/react';
import { Badge, Button, Empty, EmptyDescription, Skeleton } from '@gears-frontx/ui-kit';
import { STUDIO_SHARED_PROPERTY_CONTEXT_ORGANIZATION } from '@constructor-studio/mfe-shared';
import { KitsApiService, type CatalogKit, type InstalledKits } from '../../api/KitsApiService';
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
 * Platform › Kits: the kit library and the installer (ADR-0068 §4–5,
 * ADR-0069 §4). Every kit of the catalogue, and for each whether it is a base
 * kit (the platform's, for every organization) and whether the organization in
 * view installed it for itself. A platform administrator makes a kit a base
 * kit or takes it back; an organization administrator installs one for the
 * organization. The gear refuses what the person may not do, and the card
 * says why.
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
  const api = apiRegistry.getService(KitsApiService);
  const catalog = useApiQuery(api.catalog);
  const kits: CatalogKit[] = catalog.data?.items ?? [];
  const organization = useSharedProperty(STUDIO_SHARED_PROPERTY_CONTEXT_ORGANIZATION, { bridge }) as
    | { id: string; name: string }
    | null
    | undefined;
  const orgId = organization?.id ?? null;
  const [installed, setInstalled] = useState<InstalledKits | null>(null);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ slug: string; text: string } | null>(null);

  useEffect(() => {
    if (!orgId) return;
    let alive = true;
    api
      .installed({ organizationId: orgId })
      .fetch({ staleTime: 0 })
      .then(
        (r) => alive && setInstalled(r),
        () => alive && setInstalled(null)
      );
    return () => {
      alive = false;
    };
  }, [api, orgId, tick]);

  const act = async (slug: string, run: () => Promise<unknown>) => {
    setBusy(slug);
    setProblem(null);
    try {
      await run();
    } catch (e) {
      setProblem({ slug, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
      setTick((n) => n + 1);
    }
  };

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
                {kit.repository_url && (
                  <>
                    <dt>{t('repository')}</dt>
                    <dd>
                      <a href={kit.repository_url} target="_blank" rel="noreferrer">
                        {kit.repository_url.replace('https://', '')}
                      </a>
                    </dd>
                  </>
                )}
                {kit.levels && kit.levels.length > 0 && (
                  <>
                    <dt>{t('levels')}</dt>
                    <dd>{kit.levels.join(', ')}</dd>
                  </>
                )}
              </dl>
              <KitControls
                kit={kit}
                installed={installed}
                organization={organization ?? null}
                busy={busy === kit.slug}
                problem={problem?.slug === kit.slug ? problem.text : null}
                t={t}
                onMakeBase={() => void act(kit.slug, () => api.installBase(kit.slug).fetch({}))}
                onRemoveBase={() => void act(kit.slug, () => api.removeBase(kit.slug).fetch(undefined))}
                onInstall={(org) => void act(kit.slug, () => api.installForOrganization(kit.slug, org).fetch({}))}
                onRemove={(org) => void act(kit.slug, () => api.removeFromOrganization(kit.slug, org).fetch(undefined))}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

HomeScreen.displayName = 'HomeScreen';

type Text = ReturnType<typeof useHomeTranslations>['t'];

/** What one kit is here, and what may be done with it. */
function KitControls({
  kit,
  installed,
  organization,
  busy,
  problem,
  t,
  onMakeBase,
  onRemoveBase,
  onInstall,
  onRemove,
}: {
  kit: CatalogKit;
  installed: InstalledKits | null;
  organization: { id: string; name: string } | null;
  busy: boolean;
  problem: string | null;
  t: Text;
  onMakeBase: () => void;
  onRemoveBase: () => void;
  onInstall: (organizationId: string) => void;
  onRemove: (organizationId: string) => void;
}) {
  const base = installed?.base.find((k) => k.kit_slug === kit.slug);
  const own = installed?.organization.find((k) => k.kit_slug === kit.slug);
  const name = organization?.name ?? '';
  return (
    <>
      <div className={styles.badges}>
        {kit.shelf && <Badge variant="secondary">{t('shelf_' + kit.shelf)}</Badge>}
        {base && (
          <Badge variant="success" dot>
            {base.by_default ? t('base_default') : t('base')}
          </Badge>
        )}
        {own && (
          <Badge variant="info" dot>
            {t('installed_for', { organization: name })}
          </Badge>
        )}
        {installed && !base && !own && <Badge variant="outline">{t('not_installed')}</Badge>}
      </div>
      {installed && (
        <div className={styles.actions}>
          {base ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={onRemoveBase}>
              {t('remove_base')}
            </Button>
          ) : (
            <Button size="sm" disabled={busy} onClick={onMakeBase}>
              {t('make_base')}
            </Button>
          )}
          {organization && !base && !own && (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => onInstall(organization.id)}>
              {t('install_for', { organization: name })}
            </Button>
          )}
          {organization && own && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => onRemove(organization.id)}>
              {t('remove_from', { organization: name })}
            </Button>
          )}
        </div>
      )}
      {problem && (
        <p role="alert" className={styles.error}>
          {problem}
        </p>
      )}
    </>
  );
}
