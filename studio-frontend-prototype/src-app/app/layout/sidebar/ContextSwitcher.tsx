/**
 * The sidebar's place switcher: what the top bar's path (`ContextChain`)
 * does, folded into one control at the head of the sidebar — the
 * organization and the workspace in scope, and one menu to move to the
 * platform, another organization, another workspace or all of them. The
 * project is picked under Projects, below.
 */

import React from 'react';
import { eventBus, useAppSelector, useDomainExtensions, FRONTX_SCREEN_DOMAIN } from '@gears-frontx/react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@gears-frontx/ui-kit/dropdown-menu';
import { Skeleton } from '@gears-frontx/ui-kit/skeleton';
import { Building2, ChevronsUpDown, Layers, Server } from 'lucide-react';
import { APP_CONTEXT_SLICE_KEY, type AppContextState } from '@/app/slices/appContextSlice';
import { resolveLevelMenu, type ScreenLevel, type StudioScreenExtension } from '@/app/mfe/screenLevels';
import { useShellText } from '@/app/i18n/shellTranslations';
import { cn } from '@/app/lib/utils';
import { useOrgLogo } from '../orgLogo';
import { useScreenLevel } from '../useScreenLevel';
import styles from './ShellSidebar.module.css';

const requestLevel = (level: ScreenLevel) => eventBus.emit('app/context/level/requested', { level });

const OrgMark: React.FC<{ id: string | null | undefined; className?: string }> = ({ id, className }) => {
  const logo = useOrgLogo(id);
  return logo ? (
    <img src={logo} alt="" aria-hidden="true" className={cn('rounded-sm object-contain', className)} data-org-logo={id} />
  ) : (
    <Building2 aria-hidden="true" strokeWidth={1.5} className={className} />
  );
};

export const ContextSwitcher: React.FC<{ rail?: boolean }> = ({ rail = false }) => {
  const t = useShellText();
  const context = useAppSelector((state) => state[APP_CONTEXT_SLICE_KEY] as AppContextState | undefined);
  const level = useScreenLevel();
  const screens = useDomainExtensions(FRONTX_SCREEN_DOMAIN) as StudioScreenExtension[];
  const hasPlatform = resolveLevelMenu(screens, 'platform').length > 0;

  const org = context?.org ?? null;
  if (!org) {
    return context?.loading ? <Skeleton className="mx-1 h-10" /> : null;
  }
  const workspaces = context?.workspaces ?? [];
  // The platform and Admin sit beside the organizations: no workspace there.
  const workspace = level === 'platform' || level === 'admin' ? null : (context?.workspace ?? null);
  const where =
    level === 'platform' ? t('level_platform') : workspace ? workspace.name : t('chain_all_workspaces');
  const label = `${t('sidebar_switch_context')}: ${org.name} / ${where}`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={label}
            title={rail ? `${org.name} / ${where}` : undefined}
            className={rail ? styles.railButton : styles.switcher}
            data-context-switcher
          />
        }
      >
        <OrgMark id={org.id} className={rail ? 'size-5' : 'size-6 shrink-0'} />
        {!rail && (
          <>
            <span className={styles.switcherText}>
              <span className={styles.switcherOrg}>{org.name}</span>
              <span className={styles.switcherWhere}>{where}</span>
            </span>
            <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side={rail ? 'right' : 'bottom'} sideOffset={6} className="w-64 rounded-lg">
        {hasPlatform && (
          <>
            <DropdownMenuItem onClick={() => requestLevel('platform')}>
              <Server aria-hidden="true" />
              {t('level_platform')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-label text-muted-foreground">{t('sidebar_organizations')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={org.id}
            onValueChange={(id: string) => {
              if (id !== org.id) eventBus.emit('app/context/org/changed', { orgId: id });
            }}
          >
            {(context?.orgs ?? []).map((option) => (
              <DropdownMenuRadioItem
                key={option.id}
                value={option.id}
                closeOnClick
                // The organization already picked reports no change: from the
                // platform or Admin it goes to the organization itself.
                onClick={option.id === org.id && level !== 'organization' ? () => requestLevel('organization') : undefined}
              >
                <OrgMark id={option.id} className="size-4" />
                {option.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        {workspaces.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-label text-muted-foreground">{t('sidebar_workspaces')}</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => requestLevel('organization')}>
                <Layers aria-hidden="true" />
                {t('chain_all_workspaces')}
              </DropdownMenuItem>
              <DropdownMenuRadioGroup
                value={workspace?.id ?? ''}
                onValueChange={(id: string) =>
                  eventBus.emit('app/context/workspace/changed', { workspaceId: id, enter: true })
                }
              >
                {workspaces.map((option) => (
                  <DropdownMenuRadioItem
                    key={option.id}
                    value={option.id}
                    closeOnClick
                    onClick={
                      option.id === workspace?.id && level !== 'workspace' ? () => requestLevel('workspace') : undefined
                    }
                  >
                    <Layers aria-hidden="true" />
                    {option.name}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

ContextSwitcher.displayName = 'ContextSwitcher';
