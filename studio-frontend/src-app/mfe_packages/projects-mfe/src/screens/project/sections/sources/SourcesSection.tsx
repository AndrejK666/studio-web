import React from 'react';
import { useEverLoaded } from '@constructor-studio/mfe-shared';
import { useProjectText, useSourcesSectionTranslations, useSourcesText } from '../../../../i18n';
import { PlaceholderSection, PlaceholderSkeleton } from '../PlaceholderSection';

export const SourcesSection: React.FC = () => {
  const { isLoaded, error } = useSourcesSectionTranslations();
  const everLoaded = useEverLoaded(isLoaded);
  const t = useSourcesText();
  const projectText = useProjectText();

  if (!everLoaded && !error) return <PlaceholderSkeleton />;
  return <PlaceholderSection title={projectText('section_sources')} note={t('placeholder')} />;
};

SourcesSection.displayName = 'SourcesSection';
