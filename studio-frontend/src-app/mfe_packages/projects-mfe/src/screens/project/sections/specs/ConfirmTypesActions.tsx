import React, { useState } from 'react';
import { CheckCheck } from 'lucide-react';
import { useAppSelector } from '@gears-frontx/react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from '@gears-frontx/ui-kit';
import { useThemedRoot } from '@constructor-studio/mfe-shared/grid';
import { useSpecsText } from '../../../../i18n';
import { selectedTargets, typeSummary, type ConfirmTarget } from '../../../../model/specsConfirm';
import { SPECS_CHECK_SLICE_KEY } from '../../../../slices/specsCheckSlice';
import { TYPE_DECISION_SLICE_KEY } from '../../../../slices/typeDecisionSlice';
import { requestTypesConfirm } from '../../../../actions/typeDecisionActions';

interface ConfirmTypesActionsProps {
  projectId: string;
  workspaceId: string;
}

type Scope = 'selected' | 'all';

const NONE: readonly ConfirmTarget[] = [];

/**
 * The Specs header's bulk *Confirm*: the selected rows' proposed types, or
 * every proposed type of the project. Each asks first, saying how many of
 * which type, and what confirming them does.
 */
export const ConfirmTypesActions: React.FC<ConfirmTypesActionsProps> = ({
  projectId,
  workspaceId,
}) => {
  const t = useSpecsText();
  const selected = useAppSelector((state) => state[SPECS_CHECK_SLICE_KEY].selected);
  const proposed = useAppSelector((state) => state[TYPE_DECISION_SLICE_KEY].proposed) ?? NONE;
  const pending = useAppSelector((state) => state[TYPE_DECISION_SLICE_KEY].pending);
  const [scope, setScope] = useState<Scope | null>(null);
  const [container, findThemedRoot] = useThemedRoot();

  if (proposed.length === 0) return null;

  const picked = selectedTargets(selected, proposed);
  const targets = scope === 'selected' ? picked.targets : proposed;
  const busy = proposed.some((target) => pending.includes(target.id));
  const icon = <CheckCheck />;

  const confirm = (): void => {
    requestTypesConfirm({ projectId, workspaceId, targets: [...targets] });
    setScope(null);
  };

  const summary = typeSummary(targets)
    .map(({ typeName, count }) => t('confirm_type_count', { count, type: typeName }))
    .join(', ');

  return (
    <span ref={findThemedRoot}>
      {picked.targets.length > 0 && (
        <Button size="sm" icon={icon} loading={busy} onClick={() => setScope('selected')}>
          {t.count('confirm_selected', picked.targets.length)}
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        icon={icon}
        loading={busy}
        onClick={() => setScope('all')}
      >
        {t('confirm_all', { count: proposed.length })}
      </Button>
      <AlertDialog open={scope !== null} onOpenChange={(open) => !open && setScope(null)}>
        <AlertDialogContent container={container ?? undefined}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {scope === 'all'
                ? t.count('confirm_title_all', targets.length)
                : t.count('confirm_title_selected', targets.length)}
            </AlertDialogTitle>
            <AlertDialogDescription>{summary}</AlertDialogDescription>
            {scope === 'all' && (
              <AlertDialogDescription>{t('confirm_scope_all')}</AlertDialogDescription>
            )}
            {scope === 'selected' && picked.skipped > 0 && (
              <AlertDialogDescription>
                {t.count('confirm_skipped', picked.skipped)}
              </AlertDialogDescription>
            )}
            <AlertDialogDescription>{t('confirm_note')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('check_cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirm}>{t('confirm_go')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </span>
  );
};

ConfirmTypesActions.displayName = 'ConfirmTypesActions';
