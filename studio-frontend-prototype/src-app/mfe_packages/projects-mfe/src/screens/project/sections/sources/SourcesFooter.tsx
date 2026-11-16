import React from 'react';
import { useSourcesText } from '../../../../i18n';
import type { SourcesFooter as FooterCounts } from '../../../../model/sourceRows';
import styles from './SourcesSection.module.css';

const MISSING = '—';

/**
 * The project's counts. `synced`, when given, adds the prototype's sync chip:
 * "N never synced", or "all synced" once every repository that can sync has.
 */
export const SourcesFooter: React.FC<{
  footer: FooterCounts;
  synced?: { repositories: number; neverSynced: number; syncing?: number; cloneFailed?: number };
}> = ({ footer, synced }) => {
  const t = useSourcesText();
  const counted = (key: string, count: number | null) =>
    count === null ? t(`${key}_many`, { count: MISSING }) : t.count(key, count);

  const parts = [
    t.count('footer_sources', footer.sources),
    counted('footer_specs', footer.specs),
    footer.openPullRequests === null
      ? t('prs_unavailable')
      : t.count('footer_open_prs', footer.openPullRequests),
  ];
  if (synced && synced.repositories > 0) {
    // "all synced" only when no row says otherwise: not beside a row that is syncing or could not be cloned.
    const syncing = synced.syncing ?? 0;
    const cloneFailed = synced.cloneFailed ?? 0;
    if (synced.neverSynced > 0) parts.push(t.count('footer_never_synced', synced.neverSynced));
    if (syncing > 0) parts.push(t.count('footer_syncing', syncing));
    if (cloneFailed > 0) parts.push(t.count('footer_clone_failed', cloneFailed));
    if (synced.neverSynced === 0 && syncing === 0 && cloneFailed === 0) parts.push(t('footer_all_synced'));
  }

  return <p className={styles.footer}>{parts.join(' · ')}</p>;
};

SourcesFooter.displayName = 'SourcesFooter';
