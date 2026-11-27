/**
 * The Gears matcher kit (ADR-0072): the second entry of this MFE, switched on
 * the `section` the shell publishes for the mounted screen —
 *
 * - Project › Gear match (`gear-match`): what the gears-matcher service read
 *   in the project's specifications, and acting on it
 *   (docs/design/product-gear-match.md); it was a section of Project › Product;
 * - Organization › Gears matcher (`gears-matcher`): the service's state and
 *   the organization's default way of assembling a product.
 *
 * Its own entry, not a section of the Product kit's: the shell shows these
 * screens only where the Gears matcher kit is installed.
 */

import React, { useMemo } from 'react';
import { useSharedProperty, type ChildMfeBridge } from '@gears-frontx/react';
import {
  STUDIO_SHARED_PROPERTY_CONTEXT_ORGANIZATION,
  STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT,
  STUDIO_SHARED_PROPERTY_CONTEXT_SECTION,
  STUDIO_SHARED_PROPERTY_CONTEXT_WORKSPACE,
  useHostChrome,
} from '@constructor-studio/mfe-shared';
import { useMatchTranslations } from './i18n';
import { PageEmpty, PageLoading, ProjectPage } from '@constructor-studio/mfe-shared/page';
import { ScopeContext, type Scope } from './screens/common';
import { GearMatchSection } from './screens/product/match/GearMatchSection';
import { GearsMatcherSettings } from './screens/matcher/GearsMatcherSettings';
import styles from './screens/product.module.css';

export type GearsMatcherView = 'gear-match' | 'gears-matcher';

/** Which of the kit's screens the shell mounted: by its section, else by its extension id. */
export function matcherViewOf(extensionId: string | undefined, section: unknown): GearsMatcherView {
  if (section === 'gear-match' || section === 'gears-matcher') return section;
  return extensionId?.endsWith('.screens.gears_matcher.v1') ? 'gears-matcher' : 'gear-match';
}

const idOf = (v: unknown): string | null =>
  typeof v === 'string' && v
    ? v
    : v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' && (v as { id: string }).id
      ? (v as { id: string }).id
      : null;

export const GearsMatcherRoot: React.FC<{ bridge: ChildMfeBridge }> = ({ bridge }) => {
  const section = useSharedProperty(STUDIO_SHARED_PROPERTY_CONTEXT_SECTION);
  const projectId = idOf(useSharedProperty(STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT));
  const workspaceId = idOf(useSharedProperty(STUDIO_SHARED_PROPERTY_CONTEXT_WORKSPACE));
  const orgId = idOf(useSharedProperty(STUDIO_SHARED_PROPERTY_CONTEXT_ORGANIZATION));
  const view = matcherViewOf(bridge.extensionId, section);
  const { containerRef, dataTheme, language } = useHostChrome();
  const { t, loading } = useMatchTranslations();


  const scope: Scope | null = useMemo(
    () => (projectId ? { projectId, workspaceId, orgId, language, bridge, container: containerRef } : null),
    [projectId, workspaceId, orgId, language, bridge, containerRef]
  );

  return (
    <div ref={containerRef} className={styles.screen} data-theme={dataTheme} data-gears-matcher-view={view}>
      {loading || (view === 'gears-matcher' && !orgId) ? (
        <ProjectPage title={null} busy>
          <PageLoading />
        </ProjectPage>
      ) : view === 'gears-matcher' && orgId ? (
        <GearsMatcherSettings key={orgId} orgId={orgId} bridge={bridge} language={language} />
      ) : !scope ? (
        <ProjectPage title={t('title')}>
          <PageEmpty title={t('no_project')} />
        </ProjectPage>
      ) : (
        <ScopeContext.Provider value={scope}>
          <ProjectPage title={t('title')}>
            {/* Keyed by the scope: another project is another read, from nothing. */}
            <GearMatchSection key={`${projectId}:${orgId ?? ''}`} />
          </ProjectPage>
        </ScopeContext.Provider>
      )}
    </div>
  );
};

GearsMatcherRoot.displayName = 'GearsMatcherRoot';
