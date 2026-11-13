import type { useHomeTranslations } from '../../../i18n';

/** The home screen's text function, as a kit's page takes it. */
export type Text = ReturnType<typeof useHomeTranslations>['t'];
