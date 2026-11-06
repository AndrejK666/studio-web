/** ContextChain Component — the path to the level in scope. */

// @cpt-dod:cpt-studiofrontend-dod-shell-levels-chain:p1
// @cpt-dod:cpt-studiofrontend-dod-shell-levels-workspace-level:p1
import React, { useCallback, useRef, useState } from 'react';
import { useAppSelector, eventBus } from '@gears-frontx/react';
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from '@gears-frontx/ui-kit/dropdown-menu';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@gears-frontx/ui-kit/input-group';
import { Popover, PopoverContent, PopoverTrigger } from '@gears-frontx/ui-kit/popover';
import { Skeleton } from '@gears-frontx/ui-kit/skeleton';
import {
  ArrowRight,
  Check,
  ChevronDown,
  Folder,
  Layers,
  Search,
  type LucideIcon,
} from 'lucide-react';
import {
  APP_CONTEXT_SLICE_KEY,
  type AppContextState,
  type ContextEntity,
} from '@/app/slices/appContextSlice';
import type { ScreenLevel } from '@/app/mfe/screenLevels';
import { useShellText } from '@/app/i18n/shellTranslations';
import type { ScreenText } from '@constructor-studio/mfe-shared';
import { useScreenLevel } from './useScreenLevel';
import styles from './ContextChain.module.css';

interface ChainSlot {
  level: 'workspace' | 'project';
  caps: string;
  /** The entity in scope; `null` names none — the workspace slot at the organization level. */
  current: ContextEntity | null;
  /** What the trigger reads when `current` is `null`. */
  none?: string;
  options: ContextEntity[];
  Icon: LucideIcon;
  /** The entry for the level above, at the top of the menu. */
  up?: { label: string; level: ScreenLevel };
  pick: (id: string) => void;
}

const pickWorkspace = (id: string) =>
  eventBus.emit('app/context/workspace/changed', { workspaceId: id });
const enterWorkspace = (id: string) =>
  eventBus.emit('app/context/workspace/changed', { workspaceId: id, enter: true });
const pickProject = (id: string) =>
  eventBus.emit('app/context/project/changed', { projectId: id });

// @cpt-begin:cpt-studiofrontend-algo-shell-levels-path:p1:inst-1
// @cpt-begin:cpt-studiofrontend-algo-shell-levels-path:p1:inst-2
function slotsOf(
  level: ScreenLevel,
  context: AppContextState | undefined,
  t: ScreenText
): ChainSlot[] {
  if (!context?.org) return [];
  const workspaces = context.workspaces ?? [];

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
        pick: enterWorkspace,
      },
    ];
  }
  // @cpt-end:cpt-studiofrontend-algo-shell-levels-path:p1:inst-4

  if (!context.workspace) return [];
  const slots: ChainSlot[] = [
    {
      level: 'workspace',
      caps: t('chain_workspace'),
      current: context.workspace,
      options: workspaces,
      Icon: Layers,
      up: { label: t('chain_all_workspaces'), level: 'organization' },
      pick: pickWorkspace,
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
      pick: pickProject,
    });
  }

  return slots;
}
// @cpt-end:cpt-studiofrontend-algo-shell-levels-path:p1:inst-2
// @cpt-end:cpt-studiofrontend-algo-shell-levels-path:p1:inst-1

const requestLevel = (level: ScreenLevel) =>
  eventBus.emit('app/context/level/requested', { level });

/** The slot's face: the design's ghost button — icon, name, chevron. */
const SlotFace = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<typeof Button> & { chainSlot: ChainSlot; isCurrent: boolean }
>(({ chainSlot: slot, isCurrent, ...props }, ref) => {
  const name = slot.current ? slot.current.name : slot.none;
  return (
    <Button
      ref={ref}
      variant="utility"
      size="sm"
      icon={<slot.Icon strokeWidth={1.5} />}
      aria-current={isCurrent ? 'page' : undefined}
      aria-label={`${slot.caps}: ${name || '…'}`}
      className={styles.slot}
      {...props}
    >
      <span className={styles.face}>
        {name ? (
          <span className={styles.name}>{name}</span>
        ) : (
          // An address can name a project before its tenant has been read
          // (ADR-0028): the id is published to the MFE at once, the name follows.
          <Skeleton className="h-4 w-24" data-testid="context-slot-pending" />
        )}
        <ChevronDown className={styles.chevron} strokeWidth={1.5} aria-hidden="true" />
      </span>
    </Button>
  );
});
SlotFace.displayName = 'SlotFace';

const MenuSlot: React.FC<{ slot: ChainSlot; isCurrent: boolean }> = ({ slot, isCurrent }) => {
  const onPick = useCallback(
    (id: string) => {
      slot.pick(id);
      if (!isCurrent && slot.current) requestLevel(slot.level);
    },
    [slot, isCurrent]
  );

  return (
    <DropdownMenu>
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
        <DropdownMenuRadioGroup value={slot.current?.id ?? ''} onValueChange={onPick}>
          {slot.options.map((option) => (
            <DropdownMenuRadioItem key={option.id} value={option.id} closeOnClick>
              <slot.Icon aria-hidden="true" />
              {option.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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

  const slots = slotsOf(level, context, t);
  if (slots.length === 0) {
    return context?.loading ? <Skeleton className="h-8 w-40" /> : null;
  }

  return (
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
              {slot.level === 'project' ? (
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
  );
};

ContextChain.displayName = 'ContextChain';
