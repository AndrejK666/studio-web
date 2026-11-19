/** The details: name, project type, goal, owner. The type decides what follows (ADR-0073). */

// @cpt-dod:cpt-studiofrontend-dod-project-create-owner:p1
import { User } from '@constructor-studio/mfe-shared';
import React, { useId } from 'react';
import {
  Avatar,
  AvatarFallback,
  Field,
  FieldLabel,
  Input,
  RadioGroup,
  RadioGroupItem,
  Skeleton,
  Textarea,
} from '@gears-frontx/ui-kit';
import { useAppDispatch, useAppSelector } from '@gears-frontx/react';
import { useProjectCreateText } from '../../../i18n';
import { CREATE_SLICE_KEY, editDraft } from '../../../slices/createSlice';
import { useCurrentUser } from '../../../shared/useCurrentUser';
import { displayName } from '../../../model/project';
import type { ProjectTypeKit } from '../../../api/ProjectStatusApiService';
import styles from '../NewProjectWizard.module.css';

/** Two letters at most, like the mockup's avatar. */
function initials(user: User): string {
  const parts = displayName(user).split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map((p) => p[0]!.toUpperCase()).join('') || '?';
}

const UserRow: React.FC<{ user: User }> = ({ user }) => (
  <>
    <Avatar aria-hidden="true">
      <AvatarFallback>{initials(user)}</AvatarFallback>
    </Avatar>
    <span className={styles.ownerText}>
      <span className={styles.ownerName}>{displayName(user)}</span>
      {user.email ? <span className={styles.ownerEmail}>{user.email}</span> : null}
    </span>
  </>
);

UserRow.displayName = 'UserRow';

const UserRowPlaceholder: React.FC = () => (
  <>
    <Skeleton className={styles.ownerAvatarSkeleton} />
    <span className={styles.ownerText}>
      <Skeleton className={styles.ownerNameSkeleton} />
      <Skeleton className={styles.ownerEmailSkeleton} />
    </span>
  </>
);

UserRowPlaceholder.displayName = 'UserRowPlaceholder';

/**
 * The owner, shown and not chosen: whoever creates the project owns it.
 */
const OwnerField: React.FC = () => {
  const t = useProjectCreateText();
  const { asUser: me } = useCurrentUser();

  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{t('field_owner')}</span>
      <span className={styles.owner}>
        {me ? <UserRow user={me} /> : <UserRowPlaceholder />}
      </span>
    </div>
  );
};

OwnerField.displayName = 'OwnerField';

export const DetailsStep: React.FC<{ projectTypes?: readonly ProjectTypeKit[] }> = ({ projectTypes = [] }) => {
  const t = useProjectCreateText();
  const dispatch = useAppDispatch();
  const draft = useAppSelector((state) => state[CREATE_SLICE_KEY].draft);
  const ids = { name: useId(), goal: useId(), typeLabel: useId() };
  const picked = projectTypes.find((kit) => kit.slug === draft.typeKit);
  const nextLabels = (picked?.next_steps ?? []).map((step) => step.label);

  return (
    <>
      <Field>
        <FieldLabel className={styles.fieldLabel} htmlFor={ids.name}>
          {t('field_name')}
        </FieldLabel>
        <Input
          id={ids.name}
          value={draft.name}
          onChange={(event) => dispatch(editDraft({ name: event.target.value }))}
          autoFocus
        />
      </Field>

      {projectTypes.length > 0 && <Field>
        <FieldLabel className={styles.fieldLabel} id={ids.typeLabel}>{t('field_project_type')}</FieldLabel>
        <RadioGroup aria-labelledby={ids.typeLabel} className={styles.modes} value={draft.typeKit ?? ''}
          onValueChange={(typeKit) => dispatch(editDraft({ typeKit }))}>
          {projectTypes.map((kit) => <label key={kit.slug} className={styles.modeCard}
            data-selected={draft.typeKit === kit.slug ? '' : undefined}>
            <RadioGroupItem className={styles.modeInput} value={kit.slug} />
            <span className={styles.modeTitle}>{kit.name}</span>
            <span className={styles.modeHint}>{kit.description}</span>
          </label>)}
        </RadioGroup>
        {nextLabels.length > 0 && (
          <p className={styles.modeHint} data-type-next>
            {t('type_next', { steps: nextLabels.join(' → ') })}
          </p>
        )}
      </Field>}

      <Field>
        <FieldLabel className={styles.fieldLabel} htmlFor={ids.goal}>
          {t('field_goal')}
        </FieldLabel>
        <Textarea
          id={ids.goal}
          className={styles.goal}
          rows={3}
          value={draft.goal}
          onChange={(event) => dispatch(editDraft({ goal: event.target.value }))}
        />
      </Field>

      <OwnerField />
    </>
  );
};

DetailsStep.displayName = 'DetailsStep';
