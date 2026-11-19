/** LevelTabs Component  */

// @cpt-dod:cpt-studiofrontend-dod-shell-levels-shell-draws:p1
// @cpt-dod:cpt-studiofrontend-dod-shell-levels-one-mount:p1
import React, { useState, type DragEvent, type KeyboardEvent } from 'react';
import {
  NavigationMenu,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
} from '@gears-frontx/ui-kit/navigation-menu';
import { Skeleton } from '@gears-frontx/ui-kit/skeleton';
import { RotateCcw, Star } from 'lucide-react';
import { placementOf } from '@/app/mfe/screenLevels';
import { useShellText } from '@/app/i18n/shellTranslations';
import { moveTo } from '@/app/preferences/tab-order';
import { cn } from '@/app/lib/utils';
import { SHELL_SLOTS } from '@/app/mfe/slots';
import { KitSlot } from './KitSlot';
import { ManifestIcon } from './ManifestIcon';
import { useScreenLevel } from './useScreenLevel';
import { screenIcon } from './useInstalledKits';
import { modelNameOf } from './modelTabs';
import { LevelTabsEditor } from './LevelTabsEditor';
import { chooseTab, useLevelTabs, type LevelTabsModel } from './useLevelTabs';
import styles from './LevelTabs.module.css';

/**
 * What follows a level's tabs: Default order, Pin, the Tabs editor and the
 * kits' toolbar actions. The top bar draws them at the end of the tab row;
 * the sidebar layout in the bar over the screen. `Item` wraps each one.
 */
export const LevelTabActions: React.FC<{
  model: LevelTabsModel;
  Item: React.ComponentType<{ children: React.ReactNode }>;
  /** Whether Default order is offered: only where the tabs can be dragged. */
  reorder?: boolean;
}> = ({ model, Item, reorder = true }) => {
  const t = useShellText();
  const { pin, pinned, togglePin, saveHidden, all, hidden, setPreview } = model;
  return (
    <>
      {reorder && model.reordered && (
        <Item>
          <button
            type="button"
            className={styles.aside}
            title={t('level_tabs_default_order_hint')}
            onClick={() => model.saveOrder(model.defaultOrder)}
          >
            <RotateCcw aria-hidden="true" className={styles.asideGlyph} />
            {t('level_tabs_default_order')}
          </button>
        </Item>
      )}
      {/* Pinning belongs on the section, not in a picker: only here is it
          known which section of which project is open (the prototype's
          band did the same). The pins are listed in the header. */}
      {pin && (
        <Item>
          <button
            type="button"
            className={cn(styles.aside, pinned && styles.asideOn)}
            aria-pressed={pinned}
            title={pinned ? t('pin_remove_hint') : t('pin_add_hint')}
            data-pin-toggle
            onClick={() => togglePin(pin)}
          >
            <Star aria-hidden="true" className={styles.asideGlyph} fill={pinned ? 'currentColor' : 'none'} />
            {pinned ? t('pin_pinned') : t('pin_pin')}
          </button>
        </Item>
      )}
      {/* Which tabs show here, for everyone in this place (`hidden_tabs`). */}
      {saveHidden && (
        <Item>
          <LevelTabsEditor
            tabs={all.map((ext) => ({ id: modelNameOf(ext), label: ext.presentation?.label ?? modelNameOf(ext) }))}
            hidden={hidden}
            onSave={saveHidden}
            onPreview={setPreview}
          />
        </Item>
      )}
      {/* Kits' actions for this level or this screen (slot screen.toolbar.actions). */}
      <Item>
        <KitSlot slot={SHELL_SLOTS.screenToolbarActions} />
      </Item>
    </>
  );
};

LevelTabActions.displayName = 'LevelTabActions';

export const LevelTabs: React.FC = () => {
  const t = useShellText();
  const level = useScreenLevel();
  const model = useLevelTabs(level);
  const { ordered, mounted, kitIcons } = model;
  const order = ordered.map((tab) => tab.id);
  const save = model.saveOrder;
  const [dragging, setDragging] = useState<string | null>(null);
  /** Where a drop would land: an index into the order without the dragged tab. */
  const [dropAt, setDropAt] = useState<number | null>(null);

  const slotFor = (e: DragEvent<HTMLElement>, index: number) => {
    const box = e.currentTarget.getBoundingClientRect();
    const after = e.clientX > box.left + box.width / 2;
    const raw = index + (after ? 1 : 0);
    // The dragged tab leaves its own slot, so everything behind it moves up one.
    const from = dragging ? order.indexOf(dragging) : -1;
    return from >= 0 && raw > from ? raw - 1 : raw;
  };

  const endDrag = () => {
    setDragging(null);
    setDropAt(null);
  };

  const onKey = (e: KeyboardEvent<HTMLElement>, id: string, index: number) => {
    if (!e.altKey || !e.shiftKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    const to = e.key === 'ArrowLeft' ? index - 1 : index + 1;
    if (to < 0 || to >= order.length) return;
    save(moveTo(order, id, to));
    // Keep the focus on the tab that moved; it is re-rendered in its new slot.
    const row = e.currentTarget.closest('nav');
    requestAnimationFrame(() => row?.querySelector<HTMLElement>(`[data-tab="${id}"]`)?.focus());
  };

  // A screen of the product menu (Docs & API) is a product of its own, not a
  // tab of the level it was opened from: no level's tabs over it (walks of
  // 2026-11-17 and 2026-11-18 found the Platform's row above Docs & API).
  if (mounted && placementOf(mounted) === 'product') return null;

  if (ordered.length === 0) {
    return model.pending ? (
      <div className={styles.row} aria-hidden="true">
        <Skeleton className={styles.pending} />
      </div>
    ) : null;
  }

  const from = dragging ? order.indexOf(dragging) : -1;
  // The slot index the indicator sits in front of, in the full order. Nothing
  // is drawn where the drop would change nothing.
  const marker = dropAt === null || dropAt === from ? null : from >= 0 && dropAt >= from ? dropAt + 1 : dropAt;
  const reorderHint = t('level_tabs_reorder_hint');

  return (
    <NavigationMenu aria-label={t('level_tabs')} className={styles.row}>
      <NavigationMenuList className={styles.list}>
        {ordered.map(({ id, extension: ext }, index) => {
          return (
            <NavigationMenuItem key={ext.id}>
              <NavigationMenuLink
                size="compact"
                active={model.isActive(ext)}
                render={
                  <button
                    type="button"
                    data-tab={id}
                    title={reorderHint}
                    draggable
                    onClick={() => chooseTab(ext)}
                    onKeyDown={(e) => onKey(e, id, index)}
                    onDragStart={(e) => {
                      setDragging(id);
                      e.dataTransfer.effectAllowed = 'move';
                      // Firefox starts no drag without data.
                      e.dataTransfer.setData('text/plain', ext.presentation?.label ?? id);
                    }}
                    onDragOver={(e) => {
                      if (!dragging) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      const at = slotFor(e, index);
                      if (at !== dropAt) setDropAt(at);
                    }}
                    onDrop={(e) => {
                      if (!dragging) return;
                      e.preventDefault();
                      const at = slotFor(e, index);
                      if (at !== order.indexOf(dragging)) save(moveTo(order, dragging, at));
                      endDrag();
                    }}
                    onDragEnd={endDrag}
                  />
                }
                className={cn(
                  styles.tab,
                  dragging === id && styles.dragging,
                  dragging && marker === index && dragging !== id && styles.dropBefore,
                  dragging && marker === order.length && index === order.length - 1 && styles.dropAfter
                )}
              >
                <ManifestIcon {...screenIcon(ext, kitIcons)} className={styles.glyph} />
                {ext.presentation?.label}
                {ext.presentation?.experimental && (
                  <span className={styles.exp} title={t('level_tab_experimental')}>
                    EXP
                  </span>
                )}
              </NavigationMenuLink>
            </NavigationMenuItem>
          );
        })}
        <LevelTabActions model={model} Item={NavigationMenuItem} />
      </NavigationMenuList>
    </NavigationMenu>
  );
};

LevelTabs.displayName = 'LevelTabs';
