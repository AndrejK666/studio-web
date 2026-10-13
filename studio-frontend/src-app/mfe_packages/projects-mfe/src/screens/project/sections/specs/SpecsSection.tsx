// @cpt-dod:cpt-studiofrontend-dod-project-specs-section:p1
import React from 'react';
import { useEverLoaded } from '@constructor-studio/mfe-shared';
import { useProjectText, useSpecsSectionTranslations, useSpecsText } from '../../../../i18n';
import { PlaceholderSection, PlaceholderSkeleton } from '../PlaceholderSection';

export const SpecsSection: React.FC = () => {
  const { isLoaded, error } = useSpecsSectionTranslations();
  const everLoaded = useEverLoaded(isLoaded);
  const t = useSpecsText();
  const projectText = useProjectText();

  if (!everLoaded && !error) return <PlaceholderSkeleton />;
  return <PlaceholderSection title={projectText('section_specs')} note={t('placeholder')} />;
};

SpecsSection.displayName = 'SpecsSection';
