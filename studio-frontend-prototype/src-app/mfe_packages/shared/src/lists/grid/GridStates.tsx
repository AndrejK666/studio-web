import React from 'react';
import {
  Button,
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  useDataGrid,
} from '@gears-frontx/ui-kit';
import styles from './ListGrid.module.css';

export interface GridEmptyProps {
  /** The list's own icon, shown while nothing is filtered. */
  icon?: React.ReactNode;
  title?: string;
  note?: string;
  /** What to do about an empty list: a create or connect button. */
  actions?: React.ReactNode;
  /** Said when a search or a filter left nothing. */
  noMatches: string;
  /** Offered beside `noMatches`, such as a link that clears the search. */
  noMatchesActions?: React.ReactNode;
}

/**
 * The empty state of a list tab: "nothing here yet" with its icon, title, note
 * and actions, or "nothing matched" while a search or filter is on. Render it
 * from a module-level component handed to `ListGrid`'s `empty`, which reads the
 * text: the plugin takes a component, not an element.
 */
export const GridEmpty: React.FC<GridEmptyProps> = ({ icon, title, note, actions, noMatches, noMatchesActions }) => {
  const filtered = useDataGrid().useStore((state) => state.hasActiveFilters);
  if (filtered) {
    return (
      <Empty className={styles.empty} data-grid-empty="no-matches">
        <EmptyHeader>
          <EmptyDescription>{noMatches}</EmptyDescription>
        </EmptyHeader>
        {noMatchesActions && <EmptyActions>{noMatchesActions}</EmptyActions>}
      </Empty>
    );
  }
  return (
    <Empty className={styles.empty} data-grid-empty="none">
      <EmptyHeader>
        {icon && <EmptyMedia variant="icon">{icon}</EmptyMedia>}
        {title && <EmptyTitle>{title}</EmptyTitle>}
        {note && <EmptyDescription>{note}</EmptyDescription>}
      </EmptyHeader>
      {actions && <EmptyActions>{actions}</EmptyActions>}
    </Empty>
  );
};

GridEmpty.displayName = 'GridEmpty';

/**
 * A list that did not load, with a retry. The kit's own error view is English
 * and has none, so a list renders this in place of its grid.
 */
export const GridFailed: React.FC<{ message: string; retry?: string; onRetry?: () => void }> = ({
  message,
  retry,
  onRetry,
}) => (
  <div className={styles.failed}>
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

GridFailed.displayName = 'GridFailed';

/**
 * The line under a list: counts and context, joined with " · ". Parts that are
 * `false`, `null` or `''` drop out; with none left it renders nothing.
 */
export const GridFooter: React.FC<{ parts: ReadonlyArray<string | false | null | undefined> }> = ({ parts }) => {
  const text = parts.filter(Boolean).join(' · ');
  if (!text) return null;
  return (
    <p className={styles.footer} data-grid-footer>
      {text}
    </p>
  );
};

GridFooter.displayName = 'GridFooter';

/**
 * A cell with nothing to show: one muted dash. The label says which kind of
 * nothing, as a title rather than text, so the cell stays one dash wide.
 */
export const NoData: React.FC<{ label: string }> = ({ label }) => (
  <span className={styles.noData} title={label}>
    —
  </span>
);

NoData.displayName = 'NoData';
