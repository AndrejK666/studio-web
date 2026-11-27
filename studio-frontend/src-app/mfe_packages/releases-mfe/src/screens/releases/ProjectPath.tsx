/**
 * What Releases says of the project's path to running (#1050): an action as
 * a button, a failure's cause with the actions that fix it (#1054), and a
 * path step that is not done, under the release map's stage it belongs to.
 * The server decides the steps (`GET /project-path`).
 */

import { Badge, Button } from '@gears-frontx/ui-kit';
import { useScreenAvailability } from '@constructor-studio/mfe-shared';
import type { FailureCause, PathAction, PathCheck, PathStep, PathStepState } from '../../api/types';
import { intentOf, type Intent } from '../../model/path';
import { useReleases } from './parts';
import styles from './ReleasesScreen.module.css';

const STATE_BADGE: Record<PathStepState, 'success' | 'info' | 'danger' | 'warning' | 'secondary'> = {
  done: 'success',
  active: 'info',
  failed: 'danger',
  blocked: 'warning',
  next: 'info',
  later: 'secondary',
};

/** Whether the dictionary had `key`: a missing one comes back as the key. */
const translated = (value: string, key: string) => value !== key && !value.endsWith(`:${key}`);

/** A button for an action, labelled in the screen's language by its kind;
 *  the server's label when the dictionary has none. */
export function ActionButton({
  action,
  deploymentId,
  onIntent,
  variant = 'default',
}: {
  action: Pick<PathAction, 'kind' | 'label'> & Partial<PathAction>;
  deploymentId?: string | null;
  onIntent: (intent: Intent, action: Partial<PathAction>) => void;
  variant?: 'default' | 'outline' | 'ghost';
}) {
  const { t } = useReleases();
  const screens = useScreenAvailability();
  const intent = intentOf(action, deploymentId);
  if (intent.kind === 'none') return null;
  // A button to a screen that is not here (Organization › Infrastructure without its kit) leads nowhere.
  if (intent.kind === 'screen' && !screens.route(intent.route)) return null;
  const key = `action_${action.kind}`;
  const label = t(key);
  return (
    <Button size="sm" variant={variant} onClick={() => onIntent(intent, action)} data-path-action={action.kind}>
      {translated(label, key) ? label : action.label}
    </Button>
  );
}

/** Why a build or a deploy failed, and the actions that fix it (#1054). */
export function CauseView({
  cause,
  deploymentId,
  onIntent,
}: {
  cause: FailureCause;
  deploymentId?: string | null;
  onIntent: (intent: Intent, action: Partial<PathAction>) => void;
}) {
  const { t } = useReleases();
  const key = `cause_${cause.code}`;
  const summary = t(key, { gear: cause.gear ?? '', key: cause.key ?? '' });
  return (
    <div className={styles.cause} data-failure-cause={cause.code}>
      <b>{translated(summary, key) ? summary : cause.summary}</b>
      {cause.lines.length > 0 && (
        <pre className={`${styles.log} ${styles.pre}`} aria-label={t('cause_lines')}>
          {cause.lines.join('\n')}
        </pre>
      )}
      <div className={styles.row}>
        {cause.actions.map((a, i) => (
          <ActionButton
            key={`${a.kind}-${i}`}
            action={a}
            deploymentId={deploymentId}
            onIntent={onIntent}
            variant={i === 0 ? 'default' : 'outline'}
          />
        ))}
      </div>
    </div>
  );
}

function Checklist({ items, onIntent }: { items: PathCheck[]; onIntent: (intent: Intent, a: Partial<PathAction>) => void }) {
  const { t } = useReleases();
  return (
    <ul className={styles.checklist} aria-label={t('path_checklist')} data-path-checklist>
      {items.map((c, i) => (
        <li key={`${c.code}-${i}`} data-check={c.code} data-check-done={c.done || undefined}>
          <Badge variant={c.done ? 'success' : 'warning'}>{c.done ? t('check_done') : t('check_missing')}</Badge>
          <span>{c.text}</span>
          {!c.done && c.action && <ActionButton action={c.action} onIntent={onIntent} variant="outline" />}
        </li>
      ))}
    </ul>
  );
}

/** One step of the path to running (#1050) under the stage it belongs to,
 *  when it is not done: why, what is missing as a checklist, its cause and
 *  its action. The release map replaced the path itself (2026-11-24); what it
 *  said about a stage stays with the stage. */
export function PathStepNote({
  step,
  onIntent,
}: {
  step: PathStep;
  onIntent: (intent: Intent, action: Partial<PathAction>) => void;
}) {
  const { t } = useReleases();
  // Done, later or under way: the map and the stage say it already.
  if (step.state === 'done' || step.state === 'later' || step.state === 'active') return null;
  return (
    <div className={styles.pathNote} data-path-open={step.id} data-path-state={step.state}>
      <span className={styles.chips}>
        <Badge variant={STATE_BADGE[step.state]}>{t(`path_state_${step.state}`)}</Badge>
        <span data-path-reason>{step.reason}</span>
      </span>
      {step.checklist.length > 0 && <Checklist items={step.checklist} onIntent={onIntent} />}
      {step.cause && <CauseView cause={step.cause} deploymentId={step.deployment_id} onIntent={onIntent} />}
      {!step.cause && step.action && (
        <div className={styles.row}>
          <ActionButton action={step.action} deploymentId={step.deployment_id} onIntent={onIntent} />
        </div>
      )}
    </div>
  );
}
