/**
 * This MFE's translations, on the framework's own screen-level i18n with
 * English under every language (`loadScreenTranslations`). Call sites write
 * `t('title')` while the registry is asked for `screen.kits.home:title`.
 */

import { useCallback } from 'react';
import { useScreenTranslations, useTranslation } from '@gears-frontx/react';
import { loadScreenTranslations, type TranslationModules } from '@constructor-studio/mfe-shared';

const SCREENSET = 'kits';
const HOME_SCREEN = 'home';

export const HOME_NAMESPACE = `screen.${SCREENSET}.${HOME_SCREEN}`;

const homeModules = import.meta.glob('./screens/home/i18n/*.json') as TranslationModules;
const loadHomeTranslations = loadScreenTranslations(homeModules, './screens/home/i18n');

export type ScreenText = (
  key: string,
  params?: Record<string, string | number | boolean>
) => string;

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
