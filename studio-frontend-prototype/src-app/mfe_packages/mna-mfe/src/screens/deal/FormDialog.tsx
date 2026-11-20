/**
 * One form in a dialog, for every edit on the Deal tab: the header's
 * attributes, the recommendation, and a finding, risk or open question. The
 * fields are described, not written out: a line of text, a longer text, a
 * date, or a choice. A refusal is shown in the server's words and the draft
 * is kept. With `onDelete`, a Delete button asks once more before it deletes.
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
  NativeSelect,
  NativeSelectOption,
  Textarea,
} from '@gears-frontx/ui-kit';
import { errorMessage, refusalText } from '@constructor-studio/mfe-shared';
import type { RecordDraft } from '../../model/deal';
import type { Text } from './text';
import styles from './DealScreen.module.css';

export interface FormField {
  name: string;
  label: string;
  kind: 'text' | 'textarea' | 'date' | 'select';
  /** For `select`: the values and how each reads. */
  options?: { value: string; label: string }[];
  /** For `select`: whether "—" (none) is a choice. */
  optional?: boolean;
  required?: boolean;
  hint?: string;
}

const errText = (e: unknown) => refusalText(e) ?? errorMessage(e);

export function FormDialog({
  t,
  container,
  title,
  note,
  fields,
  initial,
  canSave,
  onSave,
  onDelete,
  deleteQuestion,
  onClose,
  name,
}: {
  t: Text;
  container: React.RefObject<HTMLDivElement | null>;
  title: string;
  /** A line under the title, e.g. that saving clears a sign-off. */
  note?: (draft: RecordDraft) => string | null;
  fields: readonly FormField[];
  initial: RecordDraft;
  canSave: (draft: RecordDraft) => boolean;
  onSave: (draft: RecordDraft) => Promise<void>;
  onDelete?: () => Promise<void>;
  deleteQuestion?: string;
  onClose: () => void;
  /** `data-form-dialog`: what tests and the page find it by. */
  name: string;
}) {
  const [draft, setDraft] = useState<RecordDraft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const set = (field: string, value: string) => setDraft((d) => ({ ...d, [field]: value }));

  const run = async (action: () => Promise<void>, failed: string) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(t(failed, { error: errText(e) }));
      setBusy(false);
    }
  };

  const noteText = note?.(draft) ?? null;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent container={container} closeLabel={t('close')} data-form-dialog={name}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {noteText && <DialogDescription data-form-note>{noteText}</DialogDescription>}
        </DialogHeader>
        <div className={styles.form}>
          {fields.map((f) => {
            const id = `${name}-${f.name}`;
            const value = draft[f.name] ?? '';
            return (
              <React.Fragment key={f.name}>
                <label className={styles.label} htmlFor={id}>
                  {f.label}
                  {f.required && ' *'}
                </label>
                <div className={styles.field}>
                  {f.kind === 'textarea' ? (
                    <Textarea id={id} rows={4} value={value} onChange={(e) => set(f.name, e.target.value)} />
                  ) : f.kind === 'select' ? (
                    <NativeSelect id={id} value={value} onChange={(e) => set(f.name, e.target.value)}>
                      {f.optional && <NativeSelectOption value="">—</NativeSelectOption>}
                      {(f.options ?? []).map((o) => (
                        <NativeSelectOption key={o.value} value={o.value}>
                          {o.label}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  ) : (
                    <Input
                      id={id}
                      type={f.kind === 'date' ? 'date' : 'text'}
                      value={value}
                      onChange={(e) => set(f.name, e.target.value)}
                    />
                  )}
                  {f.hint && <span className={styles.muted}>{f.hint}</span>}
                </div>
              </React.Fragment>
            );
          })}
        </div>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {confirming ? (
          <DialogFooter className={styles.confirm} data-form-confirm-delete>
            <span className={styles.confirmText}>{deleteQuestion}</span>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={busy}>
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => onDelete && void run(onDelete, 'delete_failed')}
              disabled={busy}
              data-form-delete-confirm
            >
              {t('delete')}
            </Button>
          </DialogFooter>
        ) : (
          <DialogFooter>
            {onDelete && (
              <Button
                variant="ghost"
                className={styles.footerStart}
                onClick={() => setConfirming(true)}
                disabled={busy}
                data-form-delete
              >
                {t('delete')}
              </Button>
            )}
            <Button variant="outline" onClick={onClose} disabled={busy}>
              {t('cancel')}
            </Button>
            <Button
              onClick={() => void run(() => onSave(draft), 'save_failed')}
              disabled={busy || !canSave(draft)}
              data-form-save
            >
              {busy ? t('saving') : t('save')}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
