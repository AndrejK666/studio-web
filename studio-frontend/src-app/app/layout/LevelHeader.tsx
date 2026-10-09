/** LevelHeader Component — names the level in scope, above its tabs. */

// @cpt-dod:cpt-studiofrontend-dod-shell-levels-header:p1
// @cpt-dod:cpt-studiofrontend-dod-shell-levels-counts:p2
import React, { useCallback } from 'react';
import { useAppSelector, eventBus } from '@gears-frontx/react';
import { Button } from '@gears-frontx/ui-kit/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@gears-frontx/ui-kit/dropdown-menu';
import { ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@gears-frontx/ui-kit/item';
import { Skeleton } from '@gears-frontx/ui-kit/skeleton';
import { ArrowLeft, ArrowLeftRight, Building2 } from 'lucide-react';
import { APP_CONTEXT_SLICE_KEY, type AppContextState } from '@/app/slices/appContextSlice';
import { useShellText } from '@/app/i18n/shellTranslations';
import { useScreenLevel } from './useScreenLevel';
import styles from './LevelHeader.module.css';

const pickOrg = (id: string) => eventBus.emit('app/context/org/changed', { orgId: id });

// TODO: the popup radius is the kit's own --radius-lg written out
const SWITCH_MENU_CLASS =
  '!min-w-72 [--radius-md:calc(var(--radius-lg)+4px)] [--radius-sm:var(--radius-lg)] [--space-1:var(--space-2)]';

const OrganizationSwitch: React.FC<{ context: AppContextState }> = ({ context }) => {
  const t = useShellText();
  const orgs = context.orgs ?? [];
  if (!context.org || orgs.length < 2) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="sm" icon={<ArrowLeftRight />} className={styles.switch} />
        }
      >
        {t('level_switch_organization')}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className={SWITCH_MENU_CLASS}>
        <DropdownMenuRadioGroup value={context.org.id} onValueChange={pickOrg}>
          {orgs.map((org) => (
            <DropdownMenuRadioItem key={org.id} value={org.id} closeOnClick className="group">
              <ItemMedia
                variant="icon"
                className="text-muted-foreground group-focus:text-current group-data-[highlighted]:text-current"
              >
                <Building2 strokeWidth={1.5} aria-hidden="true" />
              </ItemMedia>
              <ItemContent className="!gap-0">
                <ItemTitle className="!block !w-auto text-label">{org.name}</ItemTitle>
                {org.count !== undefined && (
                  <ItemDescription className="group-focus:text-current group-data-[highlighted]:text-current">
                    {t.count('level_workspaces', org.count)}
                  </ItemDescription>
                )}
              </ItemContent>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export const LevelHeader: React.FC = () => {
  const t = useShellText();
  const level = useScreenLevel();
  const context = useAppSelector(
    (state) => state[APP_CONTEXT_SLICE_KEY] as AppContextState | undefined
  );

  const backToProjects = useCallback(() => {
    eventBus.emit('app/context/level/requested', { level: 'workspace' });
  }, []);

  if (!context?.org) {
    return context?.loading ? (
      <div className={styles.header} aria-hidden="true">
        <Skeleton className={styles.pending} />
      </div>
    ) : null;
  }

  if (level === 'project' && context.project) {
    return (
      <div className={`${styles.header} ${styles.project}`}>
        <Button
          variant="ghost"
          size="sm"
          icon={<ArrowLeft />}
          aria-label={t('level_back_to_projects')}
          title={t('level_back_to_projects')}
          onClick={backToProjects}
        />
        {context.project.name ? (
          <h1 className={styles.name}>{context.project.name}</h1>
        ) : (
          // A linked project is open before its name is read (ADR-0028).
          <Skeleton className={styles.pending} data-testid="level-header-pending" />
        )}
      </div>
    );
  }

  if (level !== 'organization') {
    if (!context.workspace) {
      return context.workspacesStatus === 'pending' ? (
        <div className={styles.header} aria-hidden="true" data-testid="level-header-pending">
          <Skeleton className={styles.pending} />
        </div>
      ) : null;
    }
    return (
      <div className={styles.header}>
        <div className={styles.stack}>
          <span className={styles.eyebrow}>{context.org.name}</span>
          <h1 className={`${styles.name} ${styles.display}`}>{context.workspace.name}</h1>
        </div>
      </div>
    );
  }

  return (
    <div className={`${styles.header} ${styles.organization}`}>
      <h1 className={`${styles.name} ${styles.display}`}>{context.org.name}</h1>
      <OrganizationSwitch context={context} />
    </div>
  );
};

LevelHeader.displayName = 'LevelHeader';
