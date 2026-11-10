import React from 'react';
import {
  Button,
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyHeader,
  useDataGrid,
  type DataGridTextSearchPluginApi,
} from '@gears-frontx/ui-kit';
import styles from './ListStates.module.css';

/** A list's empty state while its search is on: rendered inside the grid. */
export const ListNoMatch: React.FC<{ message: string; clearLabel: string }> = ({
  message,
  clearLabel,
}) => {
  const grid = useDataGrid();
  const clearSearch = () => grid.getPlugin<DataGridTextSearchPluginApi>('textSearch')?.setSearch('');
  return (
    <Empty className={styles.empty}>
      <EmptyHeader>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
      <EmptyActions>
        <Button variant="link" onClick={clearSearch}>
          {clearLabel}
        </Button>
      </EmptyActions>
    </Empty>
  );
};

ListNoMatch.displayName = 'ListNoMatch';

export const ListReadFailed: React.FC<{
  message: string;
  retryLabel: string;
  onRetry: () => void;
}> = ({ message, retryLabel, onRetry }) => (
  <div className={styles.failed}>
    <p className={styles.error} role="alert">
      {message}
    </p>
    <Button variant="secondary" size="sm" className={styles.retry} onClick={onRetry}>
      {retryLabel}
    </Button>
  </div>
);

ListReadFailed.displayName = 'ListReadFailed';
