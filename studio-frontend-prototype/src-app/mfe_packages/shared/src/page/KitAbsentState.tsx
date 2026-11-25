/**
 * What a screen shows where the kit a part of it comes with is absent
 * (`kitAbsent`): "<Kit> is not installed here", the gear's own sentence when
 * it sent one, and a way to Kits for whoever may open them. Not an error: a
 * Studio without that kit is a Studio as it was meant (ADR-0079 §1).
 */

import React from 'react';
import { useMfeBridge } from '@gears-frontx/react';
import { Button } from '@gears-frontx/ui-kit';
import { PackageOpen } from 'lucide-react';
import type { KitAbsence } from '../errors/kitAbsent';
import { openScreen } from '../host/hostActions';
import { useScreenAvailability } from '../host/screens';
import { createScreenTranslations } from '../i18n/screenText';
import type { TranslationModules } from '../i18n/screenTranslations';
import { PageEmpty } from './PageStates';

const useText = createScreenTranslations(
  'shared',
  'kit-absent',
  import.meta.glob('./i18n/*.json') as TranslationModules,
  './i18n'
);

/** Where a level's Kits screen is (kits-mfe `mfe.json`). */
export const KITS_ROUTE = { project: '/project-kits', organization: '/organization-kits' } as const;

/** `project-git` → `Project git`: the slug as a name, when the caller has none. */
export function kitDisplayName(slug: string): string {
  const words = slug.replace(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : slug;
}

export interface KitAbsentStateProps {
  /** The classifier's answer, or the kit's slug when the screen knows it is absent without a call. */
  absence: KitAbsence | string;
  /** The kit's name as people read it; the slug made readable when absent. */
  name?: string;
  /** Which level's Kits the link opens; the project's by default. */
  level?: keyof typeof KITS_ROUTE;
  /**
   * Whether the viewer may install kits here. Unset, the link shows where the
   * shell lists the Kits screen for the viewer.
   */
  canInstall?: boolean;
  /** Drawn smaller, inside a card or a section rather than as the tab's body. */
  compact?: boolean;
}

export const KitAbsentState: React.FC<KitAbsentStateProps> = ({ absence, name, level = 'project', canInstall, compact }) => {
  const { t } = useText();
  const bridge = useMfeBridge();
  const available = useScreenAvailability();
  const state: KitAbsence = typeof absence === 'string' ? { kit: absence, reason: 'not_installed', detail: null } : absence;
  const kit = name ?? (state.kit ? kitDisplayName(state.kit) : '');
  const route = KITS_ROUTE[level];
  const linked = canInstall ?? available.route(route);
  const note = state.detail ?? t(state.reason === 'gear_absent' ? 'note_gear' : 'note', { kit });

  return (
    <div data-kit-absent={state.kit ?? ''} data-kit-absent-reason={state.reason}>
      <PageEmpty
        icon={compact ? undefined : <PackageOpen aria-hidden />}
        title={t('title', { kit })}
        note={note}
        actions={
          linked ? (
            <Button variant="outline" size="sm" onClick={() => openScreen(bridge, route)} data-kit-absent-open>
              {t('open_kits')}
            </Button>
          ) : undefined
        }
      />
    </div>
  );
};

KitAbsentState.displayName = 'KitAbsentState';
