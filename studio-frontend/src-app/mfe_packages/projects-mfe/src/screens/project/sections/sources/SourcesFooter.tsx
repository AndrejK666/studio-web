import React from 'react';
import { useSourcesText } from '../../../../i18n';
import type { SourcesFooter as FooterCounts } from '../../../../model/sourceRows';

const MISSING = '—';

export const SourcesFooter: React.FC<{ footer: FooterCounts }> = ({ footer }) => {
  const t = useSourcesText();
  const counted = (key: string, count: number | null) =>
    count === null ? t(`${key}_many`, { count: MISSING }) : t.count(key, count);

  return (
    <>
      {[
        t.count('footer_sources', footer.sources),
        counted('footer_specs', footer.specs),
        footer.openPullRequests === null
          ? t('prs_unavailable')
          : t.count('footer_open_prs', footer.openPullRequests),
      ].join(' · ')}
    </>
  );
};

SourcesFooter.displayName = 'SourcesFooter';
