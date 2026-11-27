/**
 * This kit's translations, on the framework's own screen-level i18n with
 * English under every language (`loadScreenTranslations`). Call sites write
 * `t('title')` while the registry is asked for `screen.mna.main:title`.
 */

import { createScreenTranslations, type TranslationModules } from '@constructor-studio/mfe-shared';

const modules = import.meta.glob('./screens/deal/i18n/*.json') as TranslationModules;

export const useMnaTranslations = createScreenTranslations('mna', 'main', modules, './screens/deal/i18n');
