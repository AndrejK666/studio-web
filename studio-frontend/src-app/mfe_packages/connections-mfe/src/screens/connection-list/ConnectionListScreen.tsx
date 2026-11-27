import React from 'react';
import { Skeleton } from '@gears-frontx/ui-kit';
import { GridFailed } from '@constructor-studio/mfe-shared/grid';
import { useConnectionListScreenTranslations, useConnectionListText } from '../../i18n';
import { useConnectionList } from '../../shared/useConnectionList';
import { ConnectionsToolbar } from './components/ConnectionsToolbar';
import { ConnectionsGrid } from './components/ConnectionsGrid';
import styles from './ConnectionListScreen.module.css';

export const ConnectionListScreen: React.FC = () => {
  const { isLoaded, error: translationsFailed } = useConnectionListScreenTranslations();
  const t = useConnectionListText();

  const { rows, loading, failed, org, retry } = useConnectionList();
  const busy = (!isLoaded && !translationsFailed) || loading;

  return (
    <div className={styles.screen}>
      <ConnectionsToolbar busy={busy} />

      <section className={styles.body}>
        {busy ? (
          <div className={styles.rowsSkeleton} data-connections-loading>
            <Skeleton className={styles.rowSkeleton} />
            <Skeleton className={styles.rowSkeleton} />
            <Skeleton className={styles.rowSkeleton} />
          </div>
        ) : translationsFailed ? (
          <GridFailed message="Could not load this screen." />
        ) : failed ? (
          <GridFailed message={t('error_title')} retry={t('retry')} onRetry={retry} />
        ) : (
          // Another organization starts the grid clean: its search, sort and page belong to the last one.
          <ConnectionsGrid key={org?.id ?? 'none'} rows={rows} tenantId={org?.id ?? ''} />
        )}
      </section>
    </div>
  );
};

ConnectionListScreen.displayName = 'ConnectionListScreen';
