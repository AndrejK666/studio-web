import React from 'react';
import { Button, Skeleton } from '@gears-frontx/ui-kit';
import { useConnectionListText } from '../../../i18n';
import { useMfeBridge } from '@gears-frontx/react';
import { openConnectDialog } from '../../../actions/connectActions';
import styles from '../ConnectionListScreen.module.css';

interface ConnectionsToolbarProps {
  busy: boolean;
}

/** The screen's title and Connect source; the search is the grid's own. */
export const ConnectionsToolbar: React.FC<ConnectionsToolbarProps> = ({ busy }) => {
  const t = useConnectionListText();
  const bridge = useMfeBridge();

  return (
    <div className={styles.toolbar} role="toolbar" aria-label={t('toolbar_label')}>
      <h2 className={styles.title}>
        {busy ? <Skeleton className={styles.titleSkeleton} /> : t('title')}
      </h2>

      <div className={styles.controls}>
        <Button size="sm" onClick={() => openConnectDialog(bridge)}>
          {t('connect_source')}
        </Button>
      </div>
    </div>
  );
};

ConnectionsToolbar.displayName = 'ConnectionsToolbar';
