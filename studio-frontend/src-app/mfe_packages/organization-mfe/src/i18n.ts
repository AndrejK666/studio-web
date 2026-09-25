/**
 * This MFE's translations, on the framework's own screen-level i18n — the same
 * shape projects-mfe uses, so that both MFEs' screens are read the same way.
 * What this module adds is the namespace: call sites write `t('col_projects')`
 * while the binding asks the registry for
 * `screen.organization.workspaces:col_projects`.
 */

import { useCallback } from 'react';
import {
  useScreenTranslations,
  useTranslation,
  type UseScreenTranslationsReturn,
} from '@gears-frontx/react';
import { loadScreenTranslations, type TranslationModules } from '@constructor-studio/mfe-shared';

const SCREENSET = 'organization';
const OVERVIEW_SCREEN = 'overview';
const WORKSPACES_SCREEN = 'workspaces';

export const OVERVIEW_NAMESPACE = `screen.${SCREENSET}.${OVERVIEW_SCREEN}`;
export const WORKSPACES_NAMESPACE = `screen.${SCREENSET}.${WORKSPACES_SCREEN}`;
const HOME_SCREEN = 'home';
export const HOME_NAMESPACE = `screen.${SCREENSET}.${HOME_SCREEN}`;

type ModuleMap = TranslationModules;

const overviewModules = import.meta.glob('./screens/overview/i18n/*.json') as ModuleMap;
const workspacesModules = import.meta.glob('./screens/workspaces/i18n/*.json') as ModuleMap;
const homeModules = import.meta.glob('./screens/home/i18n/*.json') as ModuleMap;


const loadOverviewTranslations = loadScreenTranslations(overviewModules, './screens/overview/i18n');
const loadWorkspacesTranslations = loadScreenTranslations(workspacesModules, './screens/workspaces/i18n');
const loadHomeTranslations = loadScreenTranslations(homeModules, './screens/home/i18n');

/** Loads the overview's dictionary. One call, in `OverviewScreen`. */
export function useOverviewScreenTranslations(): UseScreenTranslationsReturn {
  return useScreenTranslations(SCREENSET, OVERVIEW_SCREEN, loadOverviewTranslations);
}

/** Loads the workspaces list's dictionary. One call, in `WorkspacesScreen`. */
export function useWorkspacesScreenTranslations(): UseScreenTranslationsReturn {
  return useScreenTranslations(SCREENSET, WORKSPACES_SCREEN, loadWorkspacesTranslations);
}

export type ScreenText = (
  key: string,
  params?: Record<string, string | number | boolean>
) => string;

function createText(namespace: string): () => ScreenText {
  return function useScreenText(): ScreenText {
    const { t } = useTranslation();
    return useCallback<ScreenText>((key, params) => t(`${namespace}:${key}`, params), [t]);
  };
}

export const useOverviewText = createText(OVERVIEW_NAMESPACE);
export const useWorkspacesText = createText(WORKSPACES_NAMESPACE);

/**
 * The home screen's dictionary and its text function in one call — the shape
 * the scaffold's own hook had, so `HomeScreen` reads the same.
 */
export function useHomeTranslations(): { t: ScreenText; loading: boolean } {
  const { isLoaded } = useScreenTranslations(SCREENSET, HOME_SCREEN, loadHomeTranslations);
  const { t } = useTranslation();
  const text = useCallback<ScreenText>(
    (key, params) => t(`${HOME_NAMESPACE}:${key}`, params),
    [t]
  );
  return { t: text, loading: !isLoaded };
}
