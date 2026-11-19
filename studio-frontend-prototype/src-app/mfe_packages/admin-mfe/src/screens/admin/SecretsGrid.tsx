/**
 * Admin › Secrets' references on the kit's DataGrid, the way Specs draws its
 * list (#1076): the reference, the workspaces that name it and whether it
 * reads; a search over references and workspaces; header sort by reference.
 * Check, Rotate and Delete sit in the row's actions; Rotate's form opens below
 * the list, not under the row.
 */

import React, { useMemo } from 'react';
import { LockKeyhole } from 'lucide-react';
import { Badge, Button, DataGridRowActionsPlugin, type DataGridTableColumn } from '@gears-frontx/ui-kit';
import type { ScreenText } from '@constructor-studio/mfe-shared';
import {
  GridClearFilters,
  GridEmpty,
  ListGrid,
  createGridCells,
  useLocalGridLoad,
} from '@constructor-studio/mfe-shared/grid';
import type { SecretRow } from '../../model/secrets';
import styles from './Admin.module.css';

export type SecretHealth = 'ok' | 'broken' | 'checking';

/** A row of the grid: a reference, by itself. */
type SecretGridRow = SecretRow & { id: string };

/** What a cell needs beyond its row. */
interface SecretCells {
  t: ScreenText;
  status: Record<string, SecretHealth>;
  onCheck: (ref: string) => void;
  onRotate: (ref: string) => void;
  onDelete: (ref: string) => void;
}

const [SecretCellsProvider, useSecretCells] = createGridCells<SecretCells>('Secrets');

const RefCell: React.FC<{ item: SecretGridRow }> = ({ item }) => (
  <code className={styles.mono} data-secret={item.ref}>
    {item.ref}
  </code>
);

const UsedCell: React.FC<{ item: SecretGridRow }> = ({ item }) => (
  <span className={styles.sub}>{item.usedBy.join(', ')}</span>
);

const HealthCell: React.FC<{ item: SecretGridRow }> = ({ item }) => {
  const { t, status } = useSecretCells();
  const health = status[item.ref];
  if (health === 'ok') return <Badge variant="success">{t('secrets_readable')}</Badge>;
  if (health === 'broken') {
    return (
      <Badge variant="danger" title={t('secrets_broken_hint')}>
        {t('secrets_broken')}
      </Badge>
    );
  }
  return <span className={styles.sub}>{health === 'checking' ? t('secrets_checking') : t('secrets_not_checked')}</span>;
};

const RowActions: React.FC<{ item: SecretGridRow }> = ({ item }) => {
  const { t, status, onCheck, onRotate, onDelete } = useSecretCells();
  return (
    <div className={styles.inline}>
      <Button
        size="sm"
        variant="ghost"
        disabled={status[item.ref] === 'checking'}
        onClick={() => onCheck(item.ref)}
        data-secret-check
      >
        {t('secrets_check')}
      </Button>
      <Button size="sm" variant="outline" onClick={() => onRotate(item.ref)} data-secret-rotate>
        {t('secrets_rotate')}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => onDelete(item.ref)}>
        {t('delete')}
      </Button>
    </div>
  );
};

const SecretsEmpty: React.FC = () => {
  const { t } = useSecretCells();
  return (
    <GridEmpty
      icon={<LockKeyhole />}
      title={t('secrets_empty')}
      noMatches={t('secrets_no_match')}
      noMatchesActions={<GridClearFilters label={t('clear_search')} />}
    />
  );
};

export interface SecretsGridProps extends SecretCells {
  secrets: readonly SecretRow[];
}

export function SecretsGrid({ secrets, t, status, onCheck, onRotate, onDelete }: SecretsGridProps) {
  const rows = useMemo<SecretGridRow[]>(() => secrets.map((r) => ({ ...r, id: r.ref })), [secrets]);
  const { load, reloadBridge } = useLocalGridLoad(rows, {
    search: (r) => [r.ref, ...r.usedBy],
    compare: { reference: (a, b) => a.ref.localeCompare(b.ref) },
  });
  const columns = useMemo<DataGridTableColumn<SecretGridRow>[]>(
    () => [
      { id: 'reference', label: t('secrets_col_ref'), component: RefCell },
      { id: 'used_by', label: t('secrets_col_used'), component: UsedCell },
      { id: 'health', label: t('secrets_col_health'), component: HealthCell, width: 140 },
    ],
    [t]
  );
  const cells = useMemo<SecretCells>(
    () => ({ t, status, onCheck, onRotate, onDelete }),
    [t, status, onCheck, onRotate, onDelete]
  );

  return (
    <SecretCellsProvider value={cells}>
      <ListGrid<SecretGridRow>
        name="secrets"
        label={t('secrets_title')}
        columns={columns}
        load={load}
        search={t('secrets_search')}
        empty={SecretsEmpty}
        unsortable={['used_by', 'health']}
        minWidth="44rem"
      >
        <DataGridRowActionsPlugin<SecretGridRow> component={RowActions} />
        {reloadBridge}
      </ListGrid>
    </SecretCellsProvider>
  );
}
