import { useEffect } from 'react';
import { eventBus } from '@gears-frontx/react';
import { useNotify, type Refusal } from '@constructor-studio/mfe-shared';
import { useSpecsText } from '../../../../i18n';
import type { ConfirmFailure } from '../../../../model/specsConfirm';
import '../../../../events/specsEvents';

/** The reasons `ConfirmTypesSkippedDto.reason` names; any other is shown as sent. */
const SKIP_REASONS: ReadonlySet<string> = new Set(['not_found', 'other_project', 'not_proposed']);

/** At most this many names in the toast; the rest are counted, not named. */
const NAMED_FAILURES = 3;

/**
 * Shows a refused type decision (#690), and how a bulk confirmation went, as
 * the shell's toast. The effect that heard them has neither the bridge nor
 * this dictionary.
 */
export function useTypeDecisionRefusals(projectId: string): void {
  const notify = useNotify();
  const t = useSpecsText();

  useEffect(() => {
    const refused = eventBus.on('mfe/projects/type-decision-refused', (event) => {
      if (event.projectId !== projectId) return;
      const { name, refusal } = event;
      const text =
        refusal.kind === 'provider'
          ? t('type_refused_because', { name, reason: refusal.text })
          : t(refusal.key, { name });
      notify({ kind: 'error', text });
    });

    const refusalText = (refusal: Refusal): string =>
      refusal.kind === 'provider'
        ? t('confirm_refused_because', { reason: refusal.text })
        : t(refusal.key);
    const failureText = ({ name, reason }: ConfirmFailure): string =>
      `${name} (${SKIP_REASONS.has(reason) ? t(`confirm_reason_${reason}`) : reason})`;

    const confirmed = eventBus.on('mfe/projects/types-confirmed', (event) => {
      if (event.projectId !== projectId) return;
      const { outcome } = event;
      if (outcome.kind === 'refused') {
        notify({ kind: 'error', text: refusalText(outcome.refusal) });
        return;
      }
      const done = t.count('confirm_done', outcome.confirmed);
      if (outcome.failed.length === 0) {
        notify({ kind: 'success', text: done });
        return;
      }
      const named = outcome.failed.slice(0, NAMED_FAILURES).map(failureText);
      if (outcome.failed.length > NAMED_FAILURES) named.push('…');
      notify({
        kind: 'error',
        text: t('confirm_partial', {
          done,
          failed: t.count('confirm_failed', outcome.failed.length),
          names: named.join(', '),
        }),
      });
    });

    return () => {
      refused.unsubscribe();
      confirmed.unsubscribe();
    };
  }, [notify, t, projectId]);
}
