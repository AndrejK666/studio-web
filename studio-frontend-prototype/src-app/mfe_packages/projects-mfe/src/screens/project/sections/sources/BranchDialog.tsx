/**
 * "Change branch…" on a source row: the branch the project's IDE session checks
 * out, its specs sync from and a Studio build takes the code from
 * (`sources[].branch`). A branch that was merged and deleted stops all three,
 * and a build then says so (SOURCE_REF_MISSING); this is where it is pointed
 * at one that exists.
 */

import React, { useState } from 'react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from '@gears-frontx/ui-kit';
import { errorMessage, refusalText } from '@constructor-studio/mfe-shared';
import { useSourcesText } from '../../../../i18n';
import { branchNameProblem } from '../../../../model/projectSources';
import type { SourceRow } from '../../../../model/sourceRows';
import styles from './SourceRowMenu.module.css';

export interface BranchDialogProps {
  row: SourceRow;
  container?: HTMLElement | null;
  onSave: (branch: string) => Promise<void>;
  onClose: () => void;
}

export const BranchDialog: React.FC<BranchDialogProps> = ({ row, container, onSave, onClose }) => {
  const t = useSourcesText();
  const [branch, setBranch] = useState(row.branch ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = branchNameProblem(branch);
  const unchanged = branch.trim() === (row.branch ?? '').trim();

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(branch.trim());
      onClose();
    } catch (e) {
      setError(t('branch_not_saved', { reason: refusalText(e) ?? errorMessage(e) }));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent container={container ?? undefined} closeLabel={t('detach_cancel')} data-source-branch-dialog>
        <DialogHeader>
          <DialogTitle>{t('branch_title', { name: row.fullPath })}</DialogTitle>
          <DialogDescription>{t('branch_body')}</DialogDescription>
        </DialogHeader>
        <label className={styles.branchLabel} htmlFor="source-branch">
          {t('branch_label')}
        </label>
        <Input
          id="source-branch"
          value={branch}
          placeholder={t('branch_placeholder')}
          onChange={(e) => setBranch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !problem && !unchanged && !busy) void save();
          }}
          data-source-branch-input
        />
        {problem === 'invalid' && <p className={styles.branchError}>{t('branch_invalid')}</p>}
        {error && (
          <p className={styles.branchError} role="alert">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t('detach_cancel')}
          </Button>
          <Button onClick={() => void save()} disabled={busy || problem !== null || unchanged} data-source-branch-save>
            {busy ? t('share_saving') : t('branch_save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

BranchDialog.displayName = 'BranchDialog';
