/**
 * This MFE's translations, on the framework's own screen-level i18n.
 * This module adds one thing on top: the namespace. Call sites keep writing
 * `t('title')` while the binding asks the registry for
 * `screen.projects.list:title`, so all 72 locale files and every call site stay
 * as they are.
 */

import { useCallback } from 'react';
import {
  useScreenTranslations,
  useTranslation,
  type UseScreenTranslationsReturn,
} from '@gears-frontx/react';
import { loadScreenTranslations, type TranslationModules } from '@constructor-studio/mfe-shared';


const SCREENSET = 'projects';
const LIST_SCREEN = 'list';
const PROJECT_SCREEN = 'project';
const CREATE_SCREEN = 'create';
const WORKSPACE_SCREEN = 'workspace';

export const PROJECT_LIST_NAMESPACE = `screen.${SCREENSET}.${LIST_SCREEN}`;
export const PROJECT_NAMESPACE = `screen.${SCREENSET}.${PROJECT_SCREEN}`;
export const PROJECT_CREATE_NAMESPACE = `screen.${SCREENSET}.${CREATE_SCREEN}`;
export const WORKSPACE_CREATE_NAMESPACE = `screen.${SCREENSET}.${WORKSPACE_SCREEN}`;

type ModuleMap = TranslationModules;


const listModules = import.meta.glob('./screens/project-list/i18n/*.json') as ModuleMap;
const projectModules = import.meta.glob('./screens/project/i18n/*.json') as ModuleMap;
const createModules = import.meta.glob('./screens/project-create/i18n/*.json') as ModuleMap;
const workspaceModules = import.meta.glob('./screens/workspace-create/i18n/*.json') as ModuleMap;


const loadListTranslations = loadScreenTranslations(listModules, './screens/project-list/i18n');
const loadProjectTranslations = loadScreenTranslations(projectModules, './screens/project/i18n');
const loadCreateTranslations = loadScreenTranslations(createModules, './screens/project-create/i18n');
const loadWorkspaceTranslations = loadScreenTranslations(workspaceModules, './screens/workspace-create/i18n');

/** Loads the list screen's dictionary. One call, in `ProjectListScreen`. */
export function useProjectListScreenTranslations(): UseScreenTranslationsReturn {
  return useScreenTranslations(SCREENSET, LIST_SCREEN, loadListTranslations);
}

/** Loads the project screen's dictionary. One call, in `ProjectScreen`. */
export function useProjectScreenTranslations(): UseScreenTranslationsReturn {
  return useScreenTranslations(SCREENSET, PROJECT_SCREEN, loadProjectTranslations);
}

/**
 * Loads the New project wizard's dictionary. One call, in `NewProjectWizard`.
 * The wizard is a second mounted root with its own shadow root, but the i18n
 * registry is the MFE app's and `init.ts` builds that once for any entry — so
 * this is the same registry the screens use, not a second one.
 */
export function useProjectCreateScreenTranslations(): UseScreenTranslationsReturn {
  return useScreenTranslations(SCREENSET, CREATE_SCREEN, loadCreateTranslations);
}

/** Loads the New workspace form's dictionary. One call, in `NewWorkspaceForm`. */
export function useWorkspaceCreateScreenTranslations(): UseScreenTranslationsReturn {
  return useScreenTranslations(SCREENSET, WORKSPACE_SCREEN, loadWorkspaceTranslations);
}

export type ScreenText = (
  key: string,
  params?: Record<string, string | number | boolean>
) => string;

function createText(namespace: string): () => ScreenText {
  return function useScreenText(): ScreenText {
    const { t } = useTranslation();
    return useCallback<ScreenText>(
      (key, params) => t(`${namespace}:${key}`, params),
      [t]
    );
  };
}

export const useProjectListText = createText(PROJECT_LIST_NAMESPACE);
export const useProjectText = createText(PROJECT_NAMESPACE);
export const useProjectCreateText = createText(PROJECT_CREATE_NAMESPACE);
export const useWorkspaceCreateText = createText(WORKSPACE_CREATE_NAMESPACE);
