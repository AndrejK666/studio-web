/**
 * The sidebar layout's navigation (the designer's prototype): the product,
 * the place switcher and Search at the head; Inbox, Projects (the open
 * project and its tabs, the recent ones), Components, Platform and
 * Administration; the pins; the person,
 * the bell and the fold at the foot.
 *
 * Nothing here is a kit's: every list is a level's tabs as `useLevelTabs`
 * resolves them for the top bar's row too, so a kit's tab shows in both
 * layouts or in neither. Folded (`rail`), only the icons stay; the bar over
 * the screen then carries the path and the level's tabs (`SidebarLayout`).
 */

import React, { useEffect, useId, useRef, useState } from 'react';
import { eventBus, useAppSelector } from '@gears-frontx/react';
import {
  Building2,
  ChevronRight,
  Clock,
  FolderKanban,
  Inbox,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Server,
  Shield,
  Star,
  X,
  Folder,
  Layers,
} from 'lucide-react';
import { APP_CONTEXT_SLICE_KEY, type AppContextState } from '@/app/slices/appContextSlice';
import { entryPointOf, type ScreenLevel, type StudioScreenExtension } from '@/app/mfe/screenLevels';
import { useShellText } from '@/app/i18n/shellTranslations';
import { usePins } from '@/app/pins/usePins';
import { pinKey } from '@/app/pins/pins';
import { tokenOf } from '@/app/routing/screenTokens';
import { cn } from '@/app/lib/utils';
import { BundledIcon } from '@/app/icons/BundledIcon';
import { ProductMenu } from '../ProductMenu';
import { UserMenu } from '../UserMenu';
import { WorkInbox } from '../WorkInbox';
import { PinsMenu } from '../PinsMenu';
import { useInboxEntry } from '../useInboxEntry';
import { useSearchEntry } from '../useSearchEntry';
import { useDecidesRequests } from '../OrganizationRequests';
import { chooseTab, type LevelTabsModel } from '../useLevelTabs';
import { ContextSwitcher } from './ContextSwitcher';
import { useRecentProjects, type RecentProject } from './recentProjects';
import styles from './ShellSidebar.module.css';

/** The workspace's project list, what Projects opens inside a workspace. */
export const PROJECTS_ROUTE = '/projects';
/** The organization's workspaces and their projects, what Projects opens above a workspace. */
export const WORKSPACES_ROUTE = '/organization/workspaces';

export interface SidebarModels {
  platform: LevelTabsModel;
  organization: LevelTabsModel;
  workspace: LevelTabsModel;
  project: LevelTabsModel;
  admin: LevelTabsModel;
}

const routeOf = (ext: StudioScreenExtension | undefined) => ext?.presentation?.route;
/** The name a raised item answers to in the DOM: its route's last segment. */
const sidebarItemOf = (ext: StudioScreenExtension) => routeOf(ext)?.split('/').filter(Boolean).pop() ?? ext.id;
const findTab = (model: LevelTabsModel, route: string) =>
  model.ordered.find((tab) => routeOf(tab.extension) === route)?.extension;

type Group = 'projects' | 'project' | 'organization' | 'workspaces' | 'workspace' | 'platform' | 'admin' | 'pinned';

/** A group's open state: what the person chose, else open where the level on screen is. */
function useGroups(level: ScreenLevel) {
  const [chosen, setChosen] = useState<Partial<Record<Group, boolean>>>({});
  const defaults: Record<Group, boolean> = {
    projects: true,
    project: true,
    // Inside a project its tabs come first; the organization's fold away.
    organization: level === 'organization',
    workspaces: level === 'workspace',
    workspace: level === 'workspace',
    platform: level === 'platform',
    admin: true,
    pinned: true,
  };
  const isOpen = (group: Group) => chosen[group] ?? defaults[group];
  const toggle = (group: Group) => setChosen((current) => ({ ...current, [group]: !isOpen(group) }));
  return { isOpen, toggle };
}

interface RowProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  /** This row is the screen on display. */
  active?: boolean;
  /** Something under this row is. */
  holdsActive?: boolean;
  badge?: React.ReactNode;
  /** Folds what is under the row; absent: nothing to fold. */
  expanded?: boolean;
  onToggle?: () => void;
  controls?: string;
  rail?: boolean;
  sub?: boolean;
  children?: React.ReactNode;
  data?: Record<string, string>;
}

const Row: React.FC<RowProps> = ({
  icon,
  label,
  onClick,
  active = false,
  holdsActive = false,
  badge,
  expanded,
  onToggle,
  controls,
  rail = false,
  sub = false,
  children,
  data,
}) => {
  const t = useShellText();
  return (
    <li className={styles.item}>
      <div className={cn(styles.row, sub && styles.subRow)}>
        <button
          type="button"
          className={cn(styles.link, rail && styles.railLink)}
          aria-current={active ? 'page' : undefined}
          aria-label={rail ? label : undefined}
          title={rail ? label : undefined}
          data-active={active || undefined}
          data-holds-active={(!active && holdsActive) || undefined}
          onClick={onClick}
          {...data}
        >
          <span className={styles.glyph}>{icon}</span>
          {!rail && <span className={styles.label}>{label}</span>}
          {badge}
        </button>
        {!rail && onToggle && (
          <button
            type="button"
            className={styles.toggle}
            aria-expanded={expanded}
            aria-controls={controls}
            aria-label={t('sidebar_toggle', { label })}
            title={t('sidebar_toggle', { label })}
            onClick={onToggle}
          >
            <ChevronRight aria-hidden="true" className={cn(styles.chevron, expanded && styles.chevronOpen)} />
          </button>
        )}
      </div>
      {!rail && children}
    </li>
  );
};

/** A level's tabs as a list under its row. */
const TabList: React.FC<{ id: string; model: LevelTabsModel; without?: readonly (string | undefined)[]; label: string }> = ({
  id,
  model,
  without = [],
  label,
}) => {
  const tabs = model.ordered.filter((tab) => !without.includes(tab.extension.id));
  if (tabs.length === 0) return null;
  return (
    <ul id={id} className={styles.sub} aria-label={label} data-level-tabs={model.level}>
      {tabs.map(({ id: tabId, extension }) => {
        const active = model.isActive(extension);
        return (
          <li key={extension.id} className={styles.item}>
            <button
              type="button"
              className={cn(styles.link, styles.subLink)}
              aria-current={active ? 'page' : undefined}
              data-active={active || undefined}
              data-tab={tabId}
              onClick={() => chooseTab(extension)}
            >
              {/* No icon, as in the designer's list; its kit's icon stays in the top bar's row. */}
              <span className={styles.label}>{extension.presentation?.label}</span>
              {extension.presentation?.experimental && <span className={styles.exp}>EXP</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
};

const Count: React.FC<{ value: number | null; rail: boolean }> = ({ value, rail }) =>
  value ? (
    <span className={cn(styles.count, rail && styles.countRail)} data-inbox-count>
      {value}
    </span>
  ) : null;

export interface ShellSidebarProps {
  models: SidebarModels;
  level: ScreenLevel;
  /** Folded to the icon rail. */
  rail?: boolean;
  onToggleRail?: () => void;
  /** Drawn as the narrow window's drawer: a close button instead of the fold. */
  onClose?: () => void;
  screens: readonly StudioScreenExtension[];
}

export const ShellSidebar: React.FC<ShellSidebarProps> = ({ models, level, rail = false, onToggleRail, onClose, screens }) => {
  const t = useShellText();
  const ids = useId();
  const context = useAppSelector((state) => state[APP_CONTEXT_SLICE_KEY] as AppContextState | undefined);
  const inbox = useInboxEntry();
  const search = useSearchEntry();
  const recent = useRecentProjects();
  const { pins, toggle: togglePin } = usePins();
  const platformAdmin = useDecidesRequests();
  const { isOpen, toggle } = useGroups(level);
  const mounted = models.organization.mounted;
  const root = useRef<HTMLElement | null>(null);
  const activeKey = `${level}|${mounted?.id ?? ''}|${context?.section ?? ''}`;
  // The item on screen stays in view: a project's list can be taller than the window.
  useEffect(() => {
    root.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [activeKey]);

  const org = context?.org ?? null;
  // A workspace is in scope below the organization only; above it the address names none.
  const workspace = level === 'workspace' || level === 'project' ? (context?.workspace ?? null) : null;
  const project = level === 'project' ? (context?.project ?? null) : null;

  // Projects is a tab of a level, raised to the top of the list; so is every
  // organization tab whose manifest asks for it (`presentation.sidebar`): the
  // shell names none of them, the kit that brings one does.
  const raised = models.organization.ordered.map((tab) => tab.extension).filter((ext) => ext.presentation?.sidebar);
  const workspaceProjects = workspace ? findTab(models.workspace, PROJECTS_ROUTE) : undefined;
  const orgWorkspaces = findTab(models.organization, WORKSPACES_ROUTE);
  const projectsTarget = workspaceProjects ?? orgWorkspaces;
  const projectsActive = !!projectsTarget && routeOf(mounted) === routeOf(projectsTarget) && level !== 'project';
  const inboxActive = !!inbox.screen && mounted?.id === inbox.screen.id;

  const projectEntry = entryPointOf(screens, 'project');
  const openRecent = (entry: RecentProject) => {
    const token = projectEntry ? tokenOf(projectEntry) : undefined;
    if (!token) return;
    eventBus.emit('app/pins/open', {
      route: { token, org: entry.org.id, workspace: entry.workspace.id, project: entry.project.id },
    });
  };
  const others = recent.filter((entry) => entry.project.id !== project?.id && entry.org.id === org?.id);

  const showPlatform = platformAdmin || level === 'platform';

  return (
    <nav ref={root} className={cn(styles.sidebar, rail && styles.rail)} aria-label={t('sidebar')} data-sidebar={rail ? 'rail' : 'open'}>
      <div className={styles.head}>
        <div className={styles.brand}>
          {rail ? (
            <ProductMenu trigger="logo" />
          ) : (
            <>
              <img src="/brand/constructor-weave.svg" alt="" width={28} height={28} className="size-7 shrink-0" />
              <ProductMenu trigger="sidebar" />
            </>
          )}
          {onClose && (
            <button type="button" className={cn(styles.iconButton, 'ml-auto')} aria-label={t('sidebar_close')} title={t('sidebar_close')} onClick={onClose}>
              <X aria-hidden="true" className="size-4" />
            </button>
          )}
        </div>
        <ContextSwitcher rail={rail} />
        <button
          type="button"
          className={cn(styles.search, rail && styles.railButton)}
          aria-label={rail ? t('sidebar_search') : undefined}
          aria-keyshortcuts="Control+K"
          title={rail ? `${t('sidebar_search')} (${t('sidebar_search_shortcut')})` : undefined}
          disabled={!search.extension}
          onClick={search.open}
          data-sidebar-search
        >
          <Search aria-hidden="true" className="size-4 shrink-0" />
          {!rail && (
            <>
              <span className={styles.label}>{t('sidebar_search')}</span>
              <kbd className={styles.kbd}>{t('sidebar_search_shortcut')}</kbd>
            </>
          )}
        </button>
      </div>

      <div className={styles.nav}>
        <ul className={styles.list}>
          {inbox.screen && (
            <Row
              icon={<Inbox aria-hidden="true" />}
              label={t('inbox')}
              onClick={inbox.open}
              active={inboxActive}
              rail={rail}
              badge={<Count value={inbox.count} rail={rail} />}
              data={{ 'data-sidebar-item': 'inbox' }}
            />
          )}
          {org && (
            <Row
              icon={<Building2 aria-hidden="true" />}
              label={t('sidebar_organization')}
              onClick={() => eventBus.emit('app/context/level/requested', { level: 'organization' })}
              holdsActive={level === 'organization'}
              rail={rail}
              expanded={isOpen('organization')}
              onToggle={() => toggle('organization')}
              controls={`${ids}-organization`}
              data={{ 'data-sidebar-item': 'organization' }}
            >
              {isOpen('organization') && (
                <div id={`${ids}-organization`}>
                  <TabList
                    id={`${ids}-organization-tabs`}
                    model={models.organization}
                    without={[...raised.map((ext) => ext.id), orgWorkspaces?.id]}
                    label={org.name}
                  />
                </div>
              )}
            </Row>
          )}
          {(orgWorkspaces || workspace) && (
            <Row
              icon={<Layers aria-hidden="true" />}
              label={orgWorkspaces?.presentation?.label ?? t('sidebar_workspaces')}
              onClick={() => orgWorkspaces && chooseTab(orgWorkspaces)}
              active={!!orgWorkspaces && models.organization.isActive(orgWorkspaces)}
              holdsActive={level === 'workspace'}
              rail={rail}
              expanded={workspace ? isOpen('workspaces') : undefined}
              onToggle={workspace ? () => toggle('workspaces') : undefined}
              controls={`${ids}-workspaces`}
              data={{ 'data-sidebar-item': 'workspaces' }}
            >
              {workspace && isOpen('workspaces') && (
                <ul id={`${ids}-workspaces`} className={styles.sub}>
                  <Row
                    sub
                    icon={<Layers aria-hidden="true" className={styles.tabGlyph} />}
                    label={workspace.name}
                    onClick={() => eventBus.emit('app/context/level/requested', { level: 'workspace' })}
                    holdsActive={level === 'workspace'}
                    expanded={isOpen('workspace')}
                    onToggle={() => toggle('workspace')}
                    controls={`${ids}-workspace`}
                    data={{ 'data-sidebar-item': 'workspace' }}
                  >
                    {isOpen('workspace') && (
                      <TabList
                        id={`${ids}-workspace`}
                        model={models.workspace}
                        without={[workspaceProjects?.id]}
                        label={workspace.name}
                      />
                    )}
                  </Row>
                </ul>
              )}
            </Row>
          )}
          {(projectsTarget || project || others.length > 0) && (
            <Row
              icon={<FolderKanban aria-hidden="true" />}
              label={t('sidebar_projects')}
              onClick={() => projectsTarget && chooseTab(projectsTarget)}
              active={projectsActive}
              holdsActive={level === 'project'}
              rail={rail}
              expanded={isOpen('projects')}
              onToggle={project || others.length > 0 ? () => toggle('projects') : undefined}
              controls={`${ids}-projects`}
              data={{ 'data-sidebar-item': 'projects' }}
            >
              {isOpen('projects') && (project || others.length > 0) && (
                <ul id={`${ids}-projects`} className={styles.sub}>
                  {project && (
                    <Row
                      sub
                      icon={<Folder aria-hidden="true" className={styles.tabGlyph} />}
                      label={project.name}
                      onClick={() => projectEntry && chooseTab(projectEntry)}
                      holdsActive
                      expanded={isOpen('project')}
                      onToggle={() => toggle('project')}
                      controls={`${ids}-project`}
                      data={{ 'data-sidebar-item': 'project' }}
                    >
                      {isOpen('project') && (
                        <TabList id={`${ids}-project`} model={models.project} label={project.name} />
                      )}
                    </Row>
                  )}
                  {others.length > 0 && (
                    <li className={styles.item}>
                      <div className={styles.caption} id={`${ids}-recent`}>
                        {t('sidebar_recent')}
                      </div>
                      <ul className={styles.sub} aria-labelledby={`${ids}-recent`} data-recent-projects>
                        {others.map((entry) => (
                          <li key={entry.project.id} className={styles.item}>
                            <button
                              type="button"
                              className={cn(styles.link, styles.subLink)}
                              title={`${entry.workspace.name} / ${entry.project.name}`}
                              onClick={() => openRecent(entry)}
                              data-recent-project={entry.project.id}
                            >
                              <span className={styles.glyph}>
                                <Clock aria-hidden="true" className={styles.tabGlyph} />
                              </span>
                              <span className={styles.label}>{entry.project.name}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </li>
                  )}
                </ul>
              )}
            </Row>
          )}
          {raised.map((ext) => (
            <Row
              key={ext.id}
              icon={<BundledIcon declared={ext.presentation?.icon} />}
              label={ext.presentation?.label ?? ''}
              onClick={() => chooseTab(ext)}
              active={models.organization.isActive(ext)}
              rail={rail}
              data={{ 'data-sidebar-item': sidebarItemOf(ext) }}
            />
          ))}
          {showPlatform && models.platform.ordered.length > 0 && (
            <Row
              icon={<Server aria-hidden="true" />}
              label={t('sidebar_platform')}
              onClick={() => eventBus.emit('app/context/level/requested', { level: 'platform' })}
              holdsActive={level === 'platform'}
              rail={rail}
              expanded={isOpen('platform')}
              onToggle={() => toggle('platform')}
              controls={`${ids}-platform`}
              data={{ 'data-sidebar-item': 'platform' }}
            >
              {isOpen('platform') && (
                <TabList id={`${ids}-platform`} model={models.platform} label={t('sidebar_platform')} />
              )}
            </Row>
          )}
          {level === 'admin' && (
            <Row
              icon={<Shield aria-hidden="true" />}
              label={t('user_menu_admin')}
              onClick={() => eventBus.emit('app/context/level/requested', { level: 'admin' })}
              holdsActive
              rail={rail}
              expanded={isOpen('admin')}
              onToggle={() => toggle('admin')}
              controls={`${ids}-admin`}
              data={{ 'data-sidebar-item': 'admin' }}
            >
              {isOpen('admin') && <TabList id={`${ids}-admin`} model={models.admin} label={t('user_menu_admin')} />}
            </Row>
          )}
        </ul>

        {/* What the person keeps within one click: the top bar's star, as a group. */}
        {rail ? (
          <div className={styles.railPins}>
            <PinsMenu side="right" />
          </div>
        ) : (
          pins.length > 0 && (
            <ul className={cn(styles.list, styles.pinned)}>
              <Row
                icon={<Star aria-hidden="true" />}
                label={t('pins')}
                onClick={() => toggle('pinned')}
                expanded={isOpen('pinned')}
                onToggle={() => toggle('pinned')}
                controls={`${ids}-pinned`}
                data={{ 'data-sidebar-item': 'pinned' }}
              >
                {isOpen('pinned') && (
                  <ul id={`${ids}-pinned`} className={styles.sub} aria-label={t('pins')}>
                    {pins.map((pin) => (
                      <li key={pinKey(pin)} className={cn(styles.item, styles.pinRow)} data-pin={pinKey(pin)}>
                        <button
                          type="button"
                          className={cn(styles.link, styles.subLink)}
                          title={[...pin.where, pin.label].join(' / ')}
                          onClick={() => eventBus.emit('app/pins/open', { route: pin.route })}
                        >
                          <span className={styles.glyph}>
                            <Star aria-hidden="true" className={styles.tabGlyph} fill="currentColor" />
                          </span>
                          <span className={styles.label}>
                            {pin.label}
                            {pin.where.length > 0 && <span className={styles.where}> · {pin.where[pin.where.length - 1]}</span>}
                          </span>
                        </button>
                        <button
                          type="button"
                          className={styles.unpin}
                          aria-label={t('pin_unpin', { label: pin.label })}
                          title={t('pin_unpin', { label: pin.label })}
                          onClick={() => togglePin(pin)}
                        >
                          <X aria-hidden="true" className="size-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Row>
            </ul>
          )
        )}
      </div>

      <div className={cn(styles.foot, rail && styles.footRail)}>
        <UserMenu variant={rail ? 'rail' : 'sidebar'} />
        <WorkInbox side="top" />
        {onToggleRail && (
          <button
            type="button"
            className={styles.iconButton}
            aria-label={rail ? t('sidebar_expand') : t('sidebar_collapse')}
            title={rail ? t('sidebar_expand') : t('sidebar_collapse')}
            aria-expanded={!rail}
            onClick={onToggleRail}
            data-sidebar-fold
          >
            {rail ? <PanelLeftOpen aria-hidden="true" className="size-4" /> : <PanelLeftClose aria-hidden="true" className="size-4" />}
          </button>
        )}
      </div>
    </nav>
  );
};

ShellSidebar.displayName = 'ShellSidebar';
