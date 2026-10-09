import React, { useState } from 'react';
import { Skeleton } from '@gears-frontx/ui-kit';
import { useConnectionListScreenTranslations, useConnectionListText } from '../../i18n';
import { useConnectionList } from '../../shared/useConnectionList';
import { ConnectionsToolbar } from './components/ConnectionsToolbar';
import { ConnectionsTable } from './components/ConnectionsTable';
import styles from './ConnectionListScreen.module.css';

export const ConnectionListScreen: React.FC = () => {
  const { isLoaded, error: translationsFailed } = useConnectionListScreenTranslations();
  const t = useConnectionListText();
  const [query, setQuery] = useState('');

  const { rows, loading, failed, org, total } = useConnectionList(query);
  const busy = (!isLoaded && !translationsFailed) || loading;

  return (
    <div className={styles.screen}>
      <ConnectionsToolbar query={query} onQueryChange={setQuery} busy={busy} />

      <section className={styles.card}>
        {busy ? (
          <div className={styles.rowsSkeleton}>
            <Skeleton className={styles.rowSkeleton} />
            <Skeleton className={styles.rowSkeleton} />
            <Skeleton className={styles.rowSkeleton} />
          </div>
        ) : failed || translationsFailed ? (
          <p className={styles.state}>
            {translationsFailed ? 'Could not load this screen.' : t('error_title')}
          </p>
        ) : rows.length === 0 ? (
          <div className={styles.state}>
            <p className={styles.stateTitle}>
              {total > 0 ? t('empty_no_match') : t('empty_title')}
            </p>
            <p className={styles.stateHint}>
              {total > 0
                ? t('empty_no_match_hint')
                : org
                  ? t('empty_hint')
                  : t('empty_no_org')}
            </p>
          </div>
        ) : (
          <ConnectionsTable rows={rows} tenantId={org?.id ?? ''} />
        )}
        {!busy && !failed && !translationsFailed && rows.length > 0 ? (
          <footer className={styles.footer}>
            {t.count('count', rows.length)}
          </footer>
        ) : null}
      </section>
    </div>
  );
};

ConnectionListScreen.displayName = 'ConnectionListScreen';
