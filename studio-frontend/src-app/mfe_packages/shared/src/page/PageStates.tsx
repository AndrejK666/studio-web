import React from 'react';
import {
  Button,
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Skeleton,
  VisuallyHidden,
} from '@gears-frontx/ui-kit';
import styles from './ProjectPage.module.css';

/**
 * A tab's body while its first read is out: a strip and a block of
 * placeholders. `label` is said to a screen reader ("Loading…"); before the
 * tab's words have loaded there is none to say.
 */
export const PageLoading: React.FC<{ label?: string; blocks?: number }> = ({ label, blocks = 2 }) => (
  <div className={styles.loading} role="status" aria-busy="true" data-page-loading>
    {label && <VisuallyHidden>{label}</VisuallyHidden>}
    <Skeleton className={styles.stripSkeleton} />
    {Array.from({ length: blocks }, (_, i) => (
      <Skeleton key={i} className={styles.blockSkeleton} />
    ))}
  </div>
);

PageLoading.displayName = 'PageLoading';

export interface PageEmptyProps {
  icon?: React.ReactNode;
  title: React.ReactNode;
  note?: React.ReactNode;
  /** What to do about it: a create or connect button. */
  actions?: React.ReactNode;
}

/** A tab with nothing to show yet, and what to do about it. */
export const PageEmpty: React.FC<PageEmptyProps> = ({ icon, title, note, actions }) => (
  <Empty className={styles.empty} data-page-empty>
    <EmptyHeader>
      {icon && <EmptyMedia variant="icon">{icon}</EmptyMedia>}
      <EmptyTitle>{title}</EmptyTitle>
      {note && <EmptyDescription>{note}</EmptyDescription>}
    </EmptyHeader>
    {actions && <EmptyActions>{actions}</EmptyActions>}
  </Empty>
);

PageEmpty.displayName = 'PageEmpty';

/** A tab whose read failed: why, and a retry when one is given. */
export const PageError: React.FC<{ message: React.ReactNode; retry?: string; onRetry?: () => void }> = ({
  message,
  retry,
  onRetry,
}) => (
  <div className={styles.failed} data-page-error>
    <p className={styles.error} role="alert">
      {message}
    </p>
    {retry && onRetry && (
      <Button variant="outline" size="sm" onClick={onRetry}>
        {retry}
      </Button>
    )}
  </div>
);

PageError.displayName = 'PageError';
