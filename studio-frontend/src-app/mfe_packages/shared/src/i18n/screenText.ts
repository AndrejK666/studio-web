/**
 * `t('key')` bound to one namespace: a call site writes `t('title')` while
 * the registry is asked for `<namespace>:title`.
 */

import { useCallback } from 'react';
import { useScreenTranslations, useTranslation } from '@gears-frontx/react';
import { loadScreenTranslations, type TranslationModules } from './screenTranslations';

export type ScreenText = (key: string, params?: Record<string, string | number | boolean>) => string;

export function createText(namespace: string): () => ScreenText {
  return function useScreenText(): ScreenText {
    const { t } = useTranslation();
    return useCallback<ScreenText>((key, params) => t(`${namespace}:${key}`, params), [t]);
  };
}

/** One screen's dictionary and its text function in one hook — `{ t, loading }` */
export function createScreenTranslations(
  screenset: string,
  screen: string,
  modules: TranslationModules,
  directory: string
): () => { t: ScreenText; loading: boolean } {
  const load = loadScreenTranslations(modules, directory);
  const useText = createText(`screen.${screenset}.${screen}`);
  return function useTranslations() {
    const { isLoaded } = useScreenTranslations(screenset, screen, load);
    return { t: useText(), loading: !isLoaded };
  };
}
