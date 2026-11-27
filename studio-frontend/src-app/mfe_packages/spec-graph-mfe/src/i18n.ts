/**
 * This kit's translations, on the framework's own screen-level i18n with
 * English under every language (`loadScreenTranslations`). Call sites write
 * `t('title')` while the registry is asked for `screen.spec-graph.main:title`.
 */

import { createScreenTranslations, type TranslationModules } from '@constructor-studio/mfe-shared';

const modules = import.meta.glob('./screens/spec-graph/i18n/*.json') as TranslationModules;

export const useSpecGraphTranslations = createScreenTranslations(
  'spec-graph',
  'main',
  modules,
  './screens/spec-graph/i18n'
);
