/** ContextChain Component — the path to the level in scope. */

// @cpt-dod:cpt-studiofrontend-dod-shell-levels-chain:p1
// @cpt-dod:cpt-studiofrontend-dod-shell-levels-workspace-level:p1
import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { useAppSelector, useDomainExtensions, eventBus, FRONTX_SCREEN_DOMAIN } from '@gears-frontx/react';
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbSeparator,
} from '@gears-frontx/ui-kit/breadcrumb';
import { Button } from '@gears-frontx/ui-kit/button';
import { Command, CommandEmpty, CommandItem, CommandList } from '@gears-frontx/ui-kit/command';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@gears-frontx/ui-kit/dropdown-menu';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@gears-frontx/ui-kit/input-group';
import { Popover, PopoverContent, PopoverTrigger } from '@gears-frontx/ui-kit/popover';
import { Skeleton } from '@gears-frontx/ui-kit/skeleton';
import {
  ArrowRight,
  Building2,
  Check,
  ChevronDown,
  Folder,
  Layers,
  LoaderCircle,
  Search,
  Server,
  type LucideIcon,
} from 'lucide-react';
import {
  APP_CONTEXT_SLICE_KEY,
  type AppContextState,
  type ContextEntity,
} from '@/app/slices/appContextSlice';
import { resolveLevelMenu, type ScreenLevel, type StudioScreenExtension } from '@/app/mfe/screenLevels';
import { useShellText } from '@/app/i18n/shellTranslations';
import type { ScreenText } from '@constructor-studio/mfe-shared';
import { useScreenLevel } from './useScreenLevel';
import { useOrgLogo } from './orgLogo';
import { useNarrowViewport } from './useNarrowViewport';
import {
  openPlace,
  useProjectsOf,
  useTabOnScreen,
  useWorkspacesOf,
  type ChildList,
  type Place,
} from './chainChildren';
import styles from './ContextChain.module.css';

interface ChainSlot {
  level: 'platform' | 'organization' | 'workspace' | 'project';
  caps: string;
  /** The entity in scope; `null` names none — the workspace slot at the organization level. */
  current: ContextEntity | null;
  /** What the trigger reads when `current` is `null`. */
  none?: string;
  options: ContextEntity[];
  Icon: LucideIcon;
  /** The entry for the level above, at the top of the menu. */
  up?: { label: string; level: ScreenLevel };
  /** The move an option stands for: picking it, or its level when it is the one picked. */
  pick: (id: string) => void;
  /** What an option's submenu lists (the organization's workspaces, the workspace's projects); none: no submenus. */
  nest?: 'workspaces' | 'projects';
  /** A level with one item (the platform): a button to it, no menu. */
  only?: boolean;
}

/** Goes to a workspace or a project picked anywhere in the path. */
type Go = (place: Place) => void;

// @cpt-begin:cpt-studiofrontend-algo-shell-levels-path:p1:inst-1
// @cpt-begin:cpt-studiofrontend-algo-shell-levels-path:p1:inst-2
const pickOrg = (id: string) => eventBus.emit('app/context/org/changed', { orgId: id });

/**
 * The whole path, the prototype's way (ADR-0069): the platform, then the
 * organization, then the workspace and the project as deep as the level goes.
 * Each segment names its level above its name and is the way to move along
 * it; the level header that used to repeat the name is gone.
 */
function slotsOf(
  level: ScreenLevel,
  context: AppContextState | undefined,
  t: ScreenText,
  hasPlatform: boolean,
  go: Go
): ChainSlot[] {
  const head: ChainSlot[] = [];
  if (hasPlatform) {
    head.push({
      level: 'platform',
      caps: '',
      current: { id: 'platform', name: t('level_platform') },
      options: [],
      Icon: Server,
      pick: () => requestLevel('platform'),
      only: true,
    });
  }
  if (!context?.org) return head;
  const orgId = context.org.id;
  head.push({
    level: 'organization',
    caps: t('chain_organization'),
    current: context.org,
    options: context.orgs ?? [],
    Icon: Building2,
    up: { label: t('chain_organization_overview', { organization: context.org.name }), level: 'organization' },
    pick: (id) => {
      if (id !== orgId) pickOrg(id);
      // From another level (the platform, Admin) the organization picked
      // already goes to that organization's own level.
      else if (level !== 'organization') requestLevel('organization');
    },
    nest: 'workspaces',
  });
  // The platform and Admin sit beside the organizations: no workspace to pick.
  if (level === 'platform' || level === 'admin') return head;
  return [...head, ...belowOrganization(level, context, t, go)];
}

function belowOrganization(level: ScreenLevel, context: AppContextState, t: ScreenText, go: Go): ChainSlot[] {
  const workspaces = context.workspaces ?? [];
  const organizationId = context.org!.id;
  const pickWorkspace = (workspaceId: string) => go({ organizationId, workspaceId });

  // @cpt-begin:cpt-studiofrontend-algo-shell-levels-path:p1:inst-4
  if (level === 'organization') {
    const pending = workspaces.length === 0 && context.workspacesStatus === 'pending';
    if (workspaces.length === 0 && !pending) return [];
    return [
      {
        level: 'workspace',
        caps: t('chain_workspace'),
        current: null,
        none: pending ? '' : t('chain_all_workspaces'),
        options: workspaces,
        Icon: Layers,
        pick: pickWorkspace,
        nest: 'projects',
      },
    ];
  }
  // @cpt-end:cpt-studiofrontend-algo-shell-levels-path:p1:inst-4

  if (!context.workspace) return [];
  const workspaceId = context.workspace.id;
  const slots: ChainSlot[] = [
    {
      level: 'workspace',
      caps: t('chain_workspace'),
      current: context.workspace,
      options: workspaces,
      Icon: Layers,
      up: { label: t('chain_all_workspaces'), level: 'organization' },
      pick: pickWorkspace,
      nest: 'projects',
    },
  ];

  if (level === 'project' && context.project) {
    slots.push({
      level: 'project',
      caps: t('chain_project'),
      current: context.project,
      options: context.projects ?? [],
      Icon: Folder,
      up: {
        label: t('chain_projects_in', { workspace: context.workspace.name }),
        level: 'workspace',
      },
      pick: (projectId) => go({ organizationId, workspaceId, projectId }),
    });
  }

  return slots;
}
// @cpt-end:cpt-studiofrontend-algo-shell-levels-path:p1:inst-2
// @cpt-end:cpt-studiofrontend-algo-shell-levels-path:p1:inst-1

const requestLevel = (level: ScreenLevel) =>
  eventBus.emit('app/context/level/requested', { level });

/**
 * A slot's or an option's mark: the organization's logo where it has one (the
 * prototype's `OrgMark`), else the level's glyph.
 */
const SlotMark: React.FC<{ slot: ChainSlot; id: string | undefined; className?: string }> = ({ slot, id, className }) => {
  const logo = useOrgLogo(slot.level === 'organization' ? id : null);
  if (logo) {
    return <img src={logo} alt="" aria-hidden="true" className={className ?? 'size-4 rounded-sm object-contain'} data-org-logo={id} />;
  }
  return <slot.Icon strokeWidth={1.5} aria-hidden="true" />;
};

/** The slot's face: the design's ghost button — icon, name, chevron. */
const SlotFace = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<typeof Button> & { chainSlot: ChainSlot; isCurrent: boolean }
>(({ chainSlot: slot, isCurrent, ...props }, ref) => {
  const name = slot.current ? slot.current.name : slot.none;
  const label = slot.caps ? `${slot.caps}: ${name || '…'}` : name || '…';
  return (
    <Button
      ref={ref}
      variant="utility"
      size="sm"
      icon={<SlotMark slot={slot} id={slot.current?.id} />}
      aria-current={isCurrent ? 'page' : undefined}
      aria-label={label}
      className={styles.slot}
      {...props}
    >
      <span className={styles.face}>
        <span className={styles.text}>
          {slot.caps && <span className={styles.caps}>{slot.caps}</span>}
          {name ? (
            <span className={styles.name}>{name}</span>
          ) : (
            // An address can name a project before its tenant has been read
            // (ADR-0028): the id is published to the MFE at once, the name follows.
            <Skeleton className="h-4 w-24" data-testid="context-slot-pending" />
          )}
        </span>
        {!slot.only && <ChevronDown className={styles.chevron} strokeWidth={1.5} aria-hidden="true" />}
      </span>
    </Button>
  );
});
SlotFace.displayName = 'SlotFace';

// ─── The nested menus ────────────────────────────────────────────────────

interface ChainMenu {
  go: Go;
  /** Closes the whole menu: a submenu row's own click does not. */
  close: () => void;
  /** The place in scope, as deep as the level goes: what each row checks itself against. */
  here: { org?: string; workspace?: string; project?: string };
  narrow: boolean;
}

const ChainMenuContext = createContext<ChainMenu | null>(null);

function useChainMenu(): ChainMenu {
  const menu = useContext(ChainMenuContext);
  if (!menu) throw new Error('A row of the path’s menu outside its menu');
  return menu;
}

/** A row with nothing below it. */
const LeafRow: React.FC<{ icon: React.ReactNode; label: string; current: boolean; onChoose: () => void }> = ({
  icon,
  label,
  current,
  onChoose,
}) => (
  <DropdownMenuItem onClick={onChoose} aria-current={current ? 'true' : undefined}>
    {icon}
    <span className={styles.rowName}>{label}</span>
    {current && <Check className="ml-auto" aria-hidden="true" />}
  </DropdownMenuItem>
);

/**
 * A row with a submenu of what is below it. A click (or Enter) on the row
 * goes to it, as on a row without one; hovering it or ArrowRight opens the
 * submenu, ArrowLeft and Escape close it. A tap opens the submenu — a touch
 * screen has no hover — whose first row goes to the parent itself.
 */
const NestedRow: React.FC<{
  icon: React.ReactNode;
  label: string;
  current: boolean;
  onChoose: () => void;
  children: React.ReactNode;
}> = ({ icon, label, current, onChoose, children }) => {
  const t = useShellText();
  const { close, narrow } = useChainMenu();
  const touched = useRef(false);
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        aria-current={current ? 'true' : undefined}
        onPointerDown={(event) => {
          touched.current = event.pointerType === 'touch';
        }}
        onClick={() => {
          if (touched.current) return;
          close();
          onChoose();
        }}
      >
        {icon}
        <span className={styles.rowName}>{label}</span>
        {current && <Check className="ml-auto" aria-hidden="true" />}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        side={narrow ? 'bottom' : 'right'}
        sideOffset={narrow ? 4 : 0}
        className={`!w-auto ${styles.submenu}`}
      >
        <DropdownMenuItem onClick={onChoose}>
          {icon}
          <span className={styles.rowName}>{t('chain_open_item', { name: label })}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {children}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
};

/** What a list being read, failed or empty shows instead of its rows; null once it has rows. */
const ListState: React.FC<{ list: ChildList; empty: string }> = ({ list, empty }) => {
  const t = useShellText();
  if (list.items.length > 0) return null;
  const text = list.loading ? t('chain_children_loading') : list.failed ? t('chain_children_failed') : empty;
  return (
    <DropdownMenuItem disabled data-chain-list-state={list.loading ? 'loading' : list.failed ? 'failed' : 'empty'}>
      {list.loading && <LoaderCircle className="animate-spin" aria-hidden="true" />}
      {text}
    </DropdownMenuItem>
  );
};

/** A workspace's projects, read when its submenu opens. */
const ProjectsMenu: React.FC<{ organizationId: string; workspaceId: string }> = ({ organizationId, workspaceId }) => {
  const t = useShellText();
  const { go, here } = useChainMenu();
  const list = useProjectsOf(workspaceId);
  return (
    <>
      <ListState list={list} empty={t('chain_no_projects_here')} />
      {list.items.map((project) => (
        <LeafRow
          key={project.id}
          icon={<Folder strokeWidth={1.5} aria-hidden="true" />}
          label={project.name}
          current={here.project === project.id}
          onChoose={() => go({ organizationId, workspaceId, projectId: project.id })}
        />
      ))}
    </>
  );
};

/** A workspace as a row: its projects in its submenu, unless it is known to have none. */
const WorkspaceRow: React.FC<{ organizationId: string; workspace: ContextEntity; onChoose: () => void }> = ({
  organizationId,
  workspace,
  onChoose,
}) => {
  const { here } = useChainMenu();
  const icon = <Layers strokeWidth={1.5} aria-hidden="true" />;
  const current = here.org === organizationId && here.workspace === workspace.id;
  if (workspace.count === 0) {
    return <LeafRow icon={icon} label={workspace.name} current={current} onChoose={onChoose} />;
  }
  return (
    <NestedRow icon={icon} label={workspace.name} current={current} onChoose={onChoose}>
      <ProjectsMenu organizationId={organizationId} workspaceId={workspace.id} />
    </NestedRow>
  );
};

/** An organization's workspaces, read when its submenu opens. */
const WorkspacesMenu: React.FC<{ organizationId: string }> = ({ organizationId }) => {
  const t = useShellText();
  const { go } = useChainMenu();
  const list = useWorkspacesOf(organizationId);
  return (
    <>
      <ListState list={list} empty={t('chain_no_workspaces_here')} />
      {list.items.map((workspace) => (
        <WorkspaceRow
          key={workspace.id}
          organizationId={organizationId}
          workspace={workspace}
          onChoose={() => go({ organizationId, workspaceId: workspace.id })}
        />
      ))}
    </>
  );
};

const MenuSlot: React.FC<{ slot: ChainSlot; isCurrent: boolean }> = ({ slot, isCurrent }) => {
  const outer = useChainMenu();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const menu = { ...outer, close };
  const orgId = outer.here.org;

  return (
    <ChainMenuContext.Provider value={menu}>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          disabled={slot.options.length === 0 && !slot.up}
          render={<SlotFace chainSlot={slot} isCurrent={isCurrent} />}
        />
        <DropdownMenuContent align="start" className="!w-auto">
          {slot.up && (
            <>
              <DropdownMenuItem onClick={() => requestLevel(slot.up!.level)}>
                <slot.Icon aria-hidden="true" />
                {slot.up.label}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {slot.options.map((option) => {
            const icon = <SlotMark slot={slot} id={option.id} />;
            const current = option.id === slot.current?.id;
            const onChoose = () => slot.pick(option.id);
            if (slot.nest === 'workspaces' && option.count !== 0) {
              return (
                <NestedRow key={option.id} icon={icon} label={option.name} current={current} onChoose={onChoose}>
                  <WorkspacesMenu organizationId={option.id} />
                </NestedRow>
              );
            }
            if (slot.nest === 'projects' && orgId) {
              return <WorkspaceRow key={option.id} organizationId={orgId} workspace={option} onChoose={onChoose} />;
            }
            return <LeafRow key={option.id} icon={icon} label={option.name} current={current} onChoose={onChoose} />;
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </ChainMenuContext.Provider>
  );
};

/** The project slot. */
const SearchSlot: React.FC<{ slot: ChainSlot; isCurrent: boolean }> = ({ slot, isCurrent }) => {
  const t = useShellText();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const toggle = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) setQuery('');
  }, []);

  const choose = useCallback(
    (action: () => void) => {
      toggle(false);
      action();
    },
    [toggle]
  );

  const needle = query.trim().toLowerCase();
  const found = needle
    ? slot.options.filter((option) => option.name.toLowerCase().includes(needle))
    : slot.options;

  return (
    <Popover open={open} onOpenChange={toggle}>
      <PopoverTrigger render={<SlotFace chainSlot={slot} isCurrent={isCurrent} />} />
      <PopoverContent align="start" initialFocus={searchRef}>
        {slot.up && (
          <Button
            variant="ghost"
            size="sm"
            icon={<Layers />}
            className="!justify-start"
            onClick={() => choose(() => requestLevel(slot.up!.level))}
          >
            {slot.up.label}
          </Button>
        )}
        <Command shouldFilter={false}>
          <InputGroup>
            <InputGroupAddon>
              <Search aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              ref={searchRef}
              type="search"
              placeholder={t('chain_search_projects')}
              aria-label={t('chain_search_projects')}
              value={query}
              onValueChange={setQuery}
            />
          </InputGroup>
          <CommandList>
            <CommandEmpty>{t('chain_no_projects')}</CommandEmpty>
            {found.map((option) => (
              <CommandItem
                key={option.id}
                value={option.id}
                onSelect={() =>
                  choose(() => {
                    if (option.id !== slot.current?.id) slot.pick(option.id);
                  })
                }
              >
                <slot.Icon aria-hidden="true" />
                {option.name}
                {option.id === slot.current?.id && <Check className="ml-auto" aria-hidden="true" />}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};

export const ContextChain: React.FC = () => {
  const t = useShellText();
  const context = useAppSelector(
    (state) => state[APP_CONTEXT_SLICE_KEY] as AppContextState | undefined
  );
  const level = useScreenLevel();
  const screens = useDomainExtensions(FRONTX_SCREEN_DOMAIN) as StudioScreenExtension[];
  const hasPlatform = resolveLevelMenu(screens, 'platform').length > 0;
  const tab = useTabOnScreen();
  const narrow = useNarrowViewport();

  // Where the path stands, as deep as the level goes: the workspace the slice
  // keeps at the organization level is a preference, not a place on screen.
  const below = level === 'workspace' || level === 'project';
  const here = {
    org: context?.org?.id,
    workspace: below ? context?.workspace?.id : undefined,
    project: level === 'project' ? context?.project?.id : undefined,
  };

  // A place of the level on screen opens on the tab on screen (`openPlace`);
  // the place already on screen, picked again, moves nothing.
  const go: Go = (place) => {
    const target: ScreenLevel = place.projectId ? 'project' : 'workspace';
    const same =
      place.organizationId === here.org &&
      place.workspaceId === here.workspace &&
      (place.projectId ?? undefined) === here.project;
    if (same && level === target) return;
    void openPlace(place, level === target, tab);
  };

  const slots = slotsOf(level, context, t, hasPlatform, go);
  if (slots.length === 0) {
    return context?.loading ? <Skeleton className="h-8 w-40" /> : null;
  }

  const menu: ChainMenu = { go, close: () => undefined, here, narrow };

  return (
    <ChainMenuContext.Provider value={menu}>
      <Breadcrumb>
        {/* @cpt-begin:cpt-studiofrontend-algo-shell-levels-path:p1:inst-3 */}
        <BreadcrumbList className={styles.list}>
          {slots.map((slot, index) => (
            <React.Fragment key={slot.level}>
              {index > 0 && (
                <BreadcrumbSeparator className={styles.separator}>
                  <ArrowRight strokeWidth={1.5} />
                </BreadcrumbSeparator>
              )}
              <BreadcrumbItem>
                {slot.only ? (
                  <SlotFace chainSlot={slot} isCurrent={slot.level === level} onClick={() => slot.pick('')} />
                ) : slot.level === 'project' ? (
                  <SearchSlot slot={slot} isCurrent={slot.level === level} />
                ) : (
                  <MenuSlot slot={slot} isCurrent={slot.level === level} />
                )}
              </BreadcrumbItem>
            </React.Fragment>
          ))}
        </BreadcrumbList>
        {/* @cpt-end:cpt-studiofrontend-algo-shell-levels-path:p1:inst-3 */}
      </Breadcrumb>
    </ChainMenuContext.Provider>
  );
};

ContextChain.displayName = 'ContextChain';
