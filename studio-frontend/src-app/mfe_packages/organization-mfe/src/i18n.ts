/**
 * This MFE's translations, on the framework's own screen-level i18n — the same
 * shape projects-mfe uses, so that both MFEs' screens are read the same way.
 * What this module adds is the namespace: call sites write `t('col_projects')`
 * while the binding asks the registry for
 * `screen.organization.workspaces:col_projects`.
 */

import {
  useScreenTranslations,
  type UseScreenTranslationsReturn,
} from '@gears-frontx/react';
import {
  createScreenTranslations,
  createText,
  loadScreenTranslations,
  type TranslationModules,
} from '@constructor-studio/mfe-shared';

const SCREENSET = 'organization';
const WORKSPACES_SCREEN = 'workspaces';

export const WORKSPACES_NAMESPACE = `screen.${SCREENSET}.${WORKSPACES_SCREEN}`;

type ModuleMap = TranslationModules;

const workspacesModules = import.meta.glob('./screens/workspaces/i18n/*.json') as ModuleMap;
const homeModules = import.meta.glob('./screens/home/i18n/*.json') as ModuleMap;


const loadWorkspacesTranslations = loadScreenTranslations(workspacesModules, './screens/workspaces/i18n');

/** Loads the workspaces list's dictionary. One call, in `WorkspacesScreen`. */
export function useWorkspacesScreenTranslations(): UseScreenTranslationsReturn {
  return useScreenTranslations(SCREENSET, WORKSPACES_SCREEN, loadWorkspacesTranslations);
}

export const useWorkspacesText = createText(WORKSPACES_NAMESPACE);

/** The home screen's dictionary and its text function in one call. */
export const useHomeTranslations = createScreenTranslations(SCREENSET, 'home', homeModules, './screens/home/i18n');
