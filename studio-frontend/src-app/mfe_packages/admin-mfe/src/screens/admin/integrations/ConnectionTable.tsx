/**
 * The connections on the kit's DataGrid, the way Specs draws its list (#1076) —
 * the prototype's `ConnectionList` (`App.tsx` at 00828880): the kind and the
 * connector as quick filters, a search, header sort by connection and kind, one
 * row per connection with its health, what uses it and its scope; Test again,
 * Edit, Browse repositories and Remove in its actions; the editor and the
 * repository browser open below the list; "Not connected yet" names the kinds
 * nothing is connected for. Health is asked once when the list shows and kept
 * five minutes, across visits; a forced test always asks. The search, filters
 * and order stay in the address under `conn.`.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Network } from 'lucide-react';
import { apiRegistry } from '@gears-frontx/react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  DataGridRowActionsPlugin,
  StatusDot,
  filterTagGroup,
  type DataGridLoadContext,
  type DataGridTableColumn,
} from '@gears-frontx/ui-kit';
import type { OrganizationRef, ScreenText } from '@constructor-studio/mfe-shared';
import {
  GridAddress,
  GridClearFilters,
  GridEmpty,
  ListGrid,
  createGridCells,
  tagGroupChoice,
  useLocalGridLoad,
  writeGridAddress,
} from '@constructor-studio/mfe-shared/grid';
import { AdminApiService } from '../../../api/AdminApiService';
import type { ConnectorProvider, StoredConnection } from '../../../api/types';
import {
  CATEGORY_KEYS,
  HEALTH_TTL_MS,
  MISSING_EXPLAINED,
  missingCategories,
  nonDefaultAddress,
  usedByKind,
} from '../../../model/connections';
import { errText, useAdmin, useConfirm } from '../common';
import { ConnectorLogo, LogoSlot } from './ConnectorLogo';
import { EditConnection } from './EditConnection';
import { RepoBrowser } from './RepoBrowser';
import styles from '../Admin.module.css';
import own from './Integrations.module.css';

type Health = { state: 'ok' | 'bad' | 'testing'; text: string; at: number };

/**
 * Each connection's last answer, kept across visits to the page and, through localStorage, across page loads: a test
 * of a GitHub connection is a live call that spends the token's rate limit, so a visit asks only what has no answer
 * younger than HEALTH_TTL_MS (walk 2026-11-16: every visit tested all six).
 */
const HEALTH_STORE_KEY = 'studio.admin.connection-health.v1';
const healthCache = new Map<string, Health>(readStoredHealth());

function readStoredHealth(): [string, Health][] {
  try {
    const raw = window.localStorage.getItem(HEALTH_STORE_KEY);
    const stored = raw ? (JSON.parse(raw) as Record<string, Health>) : {};
    return Object.entries(stored).filter(
      ([, h]) => !!h && (h.state === 'ok' || h.state === 'bad') && typeof h.at === 'number'
    );
  } catch {
    return [];
  }
}

function storeHealth(): void {
  try {
    const settled = [...healthCache.entries()].filter(([, h]) => h.state !== 'testing');
    window.localStorage.setItem(HEALTH_STORE_KEY, JSON.stringify(Object.fromEntries(settled)));
  } catch {
    // A private window or blocked storage: the answers last this page load only.
  }
}

/** "8 min ago", "yesterday": when a health answer came. */
export function ago(at: number, now: number, t: ScreenText): string {
  const secs = Math.round((now - at) / 1000);
  if (secs < 60) return t('int_just_now');
  const mins = Math.round(secs / 60);
  if (mins < 60) return t.count('int_minutes_ago', mins);
  const hours = Math.round(mins / 60);
  if (hours < 24) return t.count('int_hours_ago', hours);
  const days = Math.round(hours / 24);
  if (days === 1) return t('int_yesterday');
  if (days < 30) return t.count('int_days_ago', days);
  return t.count('int_months_ago', Math.round(days / 30));
}

/** Where the connection list keeps its search, filters and sort in the address. */
export const CONNECTIONS_LIST_PREFIX = 'conn.';

/** The quick filters' keys: one kind, one connector. */
export const CONNECTION_FILTERS = { kind: 'kind', provider: 'provider' } as const;
const ADDRESS_FILTERS = [CONNECTION_FILTERS.kind, CONNECTION_FILTERS.provider];

/** What a cell needs beyond its row. */
interface ConnectionCells {
  t: ScreenText;
  orgName: string;
  health: Record<string, Health>;
  now: number;
  editing: string | null;
  open: string | null;
  nameOf: (provider: string) => string;
  categoryTitle: (provider: string) => string;
  defaultUrl: (provider: string) => string;
  inheritedOf: (c: StoredConnection) => boolean;
  browsable: (c: StoredConnection) => boolean;
  usedBy: (c: StoredConnection) => string;
  retest: (c: StoredConnection) => void;
  onEdit: (c: StoredConnection) => void;
  onBrowse: (c: StoredConnection) => void;
  onRemove: (c: StoredConnection) => void;
}

const [ConnectionCellsProvider, useConnectionCells] = createGridCells<ConnectionCells>('Connections');

const ConnectionCell: React.FC<{ item: StoredConnection }> = ({ item }) => {
  const { health, nameOf, defaultUrl } = useConnectionCells();
  const h = health[item.id];
  const address = nonDefaultAddress(item.base_url, defaultUrl(item.provider));
  return (
    <span className={own.lead} data-connection={item.id}>
      <LogoSlot>
        <ConnectorLogo provider={item.provider} label={nameOf(item.provider)} />
      </LogoSlot>
      <span className={own.stack}>
        <span className={own.name}>
          <StatusDot
            tone={h?.state === 'ok' ? 'success' : h?.state === 'bad' ? 'danger' : 'neutral'}
            live={!h || h.state === 'testing'}
          />
          {item.label}
        </span>
        <span className={styles.sub}>
          {nameOf(item.provider)}
          {address ? ` · ${address}` : ''}
        </span>
      </span>
    </span>
  );
};

const KindCell: React.FC<{ item: StoredConnection }> = ({ item }) => (
  <span className={styles.sub}>{useConnectionCells().categoryTitle(item.provider)}</span>
);

const AnswerCell: React.FC<{ item: StoredConnection }> = ({ item }) => {
  const { t, health, now } = useConnectionCells();
  const h = health[item.id];
  const answer = h
    ? h.text.replace(` (${item.base_url})`, '').replace(` (${item.base_url.replace(/\/$/, '')})`, '')
    : t('int_checking');
  return (
    <span>
      <span
        className={h?.state === 'bad' ? own.bad : h?.state === 'ok' ? own.ok : styles.sub}
        title={h?.text}
        data-connection-answer={h?.state ?? 'testing'}
      >
        {answer}
      </span>
      {h && h.state !== 'testing' && (
        <span className={styles.sub}> · {t('int_checked', { when: ago(h.at, Math.max(now, h.at), t) })}</span>
      )}
    </span>
  );
};

const UsedCell: React.FC<{ item: StoredConnection }> = ({ item }) => (
  <span className={styles.sub}>{useConnectionCells().usedBy(item)}</span>
);

const ScopeCell: React.FC<{ item: StoredConnection }> = ({ item }) => {
  const { t, inheritedOf } = useConnectionCells();
  const scopeWord = (scope: string) =>
    ['organization', 'workspace', 'personal'].includes(scope) ? t(`int_scope_${scope}`) : scope;
  return (
    <Badge variant={item.scope === 'personal' ? 'outline' : 'secondary'}>
      {inheritedOf(item) ? t('int_scope_shared', { scope: scopeWord(item.scope) }) : scopeWord(item.scope)}
    </Badge>
  );
};

const RowActions: React.FC<{ item: StoredConnection }> = ({ item }) => {
  const { t, health, editing, open, inheritedOf, browsable, retest, onEdit, onBrowse, onRemove } =
    useConnectionCells();
  const testing = health[item.id]?.state === 'testing';
  return (
    <div className={styles.inline}>
      <Button size="sm" variant="ghost" disabled={testing} onClick={() => retest(item)} data-connection-test>
        {testing ? t('int_checking') : t('int_test_again')}
      </Button>
      <Button
        size="sm"
        variant="outline"
        // Inherited connections are edited where they are defined.
        disabled={inheritedOf(item)}
        onClick={() => onEdit(item)}
        data-connection-edit
      >
        {editing === item.id ? t('int_close_editor') : t('int_edit')}
      </Button>
      {browsable(item) && (
        <Button size="sm" variant="outline" onClick={() => onBrowse(item)} data-connection-browse>
          {open === item.id ? t('int_hide_repos') : t('int_browse_repos')}
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={() => onRemove(item)} data-connection-remove>
        {t('remove')}
      </Button>
    </div>
  );
};

const ConnectionsEmpty: React.FC = () => {
  const { t, orgName } = useConnectionCells();
  return (
    <div data-connections-empty>
      <GridEmpty
        icon={<Network />}
        title={t('int_empty_title', { name: orgName })}
        note={t('int_empty_body')}
        noMatches={t('int_no_match')}
        noMatchesActions={<GridClearFilters label={t('clear_search')} />}
      />
    </div>
  );
};

export function ConnectionTable({
  org,
  personal = false,
  providers,
  connections,
  loading,
  sourcesTick,
  envUses,
  adding,
  onAdd,
  onSourcesChanged,
  onChanged,
  onNote,
}: {
  org: OrganizationRef;
  personal?: boolean;
  providers: ConnectorProvider[];
  connections: StoredConnection[];
  loading: boolean;
  sourcesTick: number;
  /** Environments by the cluster or registry connection they deploy with. */
  envUses: Map<string, string[]>;
  /** Whether the picker is open above. */
  adding: boolean;
  /** Open the provider picker, on one kind or on all. */
  onAdd: (category?: string) => void;
  onSourcesChanged: () => void;
  onChanged: () => void;
  onNote: (text: string) => void;
}) {
  const { t } = useAdmin();
  const api = apiRegistry.getService(AdminApiService);
  const [ask, confirmDialog] = useConfirm();
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [health, setHealth] = useState<Record<string, Health>>(() => Object.fromEntries(healthCache.entries()));
  // "checked 3 min ago" moves on without a re-read: the instant is state, ticked every 30 s.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const providerOf = useCallback((p: string) => providers.find((x) => x.provider === p), [providers]);
  const nameOf = useCallback((p: string) => providerOf(p)?.display_name ?? p, [providerOf]);
  const categoryOf = useCallback((p: string) => providerOf(p)?.category, [providerOf]);
  const categoryTitle = useCallback(
    (p: string) => {
      const key = categoryOf(p);
      return key && (CATEGORY_KEYS as readonly string[]).includes(key) ? t(`int_cat_${key}`) : t('int_cat_other');
    },
    [categoryOf, t]
  );
  const defaultUrl = useCallback((p: string) => providerOf(p)?.default_base_url ?? '', [providerOf]);
  // A row stored on an ancestor is shared with sibling tenants: removing it affects them too.
  // The gear says so on the list read with ancestors (#1043); else the holder tells.
  const inheritedOf = useCallback((c: StoredConnection) => c.inherited ?? c.owner_tenant_id !== org.id, [org.id]);
  const browsable = useCallback((c: StoredConnection) => categoryOf(c.provider) === 'source_code', [categoryOf]);

  const probe = useCallback(
    (c: StoredConnection) =>
      api
        .testConnection(c.id, org.id)
        .fetch(undefined)
        .then(
          (r): Health => ({
            state: 'ok',
            text: r.display_name ? `${r.account} (${r.display_name})` : r.account,
            at: Date.now(),
          }),
          (e: unknown): Health => ({ state: 'bad', text: errText(e), at: Date.now() })
        )
        .then((v) => {
          healthCache.set(c.id, v);
          storeHealth();
          setHealth((h) => ({ ...h, [c.id]: v }));
        }),
    [api, org.id]
  );

  const retest = useCallback(
    (c: StoredConnection) => {
      setHealth((h) => ({
        ...h,
        [c.id]: { state: 'testing', text: h[c.id]?.text ?? t('int_checking'), at: h[c.id]?.at ?? Date.now() },
      }));
      void probe(c);
    },
    [probe, t]
  );

  // Ask what has no fresh answer, once per list of connections.
  const ids = connections.map((c) => c.id).join(',');
  useEffect(() => {
    const at = Date.now();
    for (const c of connections) {
      const known = healthCache.get(c.id);
      if (!known || at - known.at > HEALTH_TTL_MS) void probe(c);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per list of ids, as the prototype asked
  }, [ids, probe]);

  const missing = loading ? [] : missingCategories(providers, connections);
  const providersPresent = [...new Set(connections.map((c) => c.provider))].join(',');
  const kindsPresent = CATEGORY_KEYS.filter((key) => connections.some((c) => categoryOf(c.provider) === key)).join(',');

  const usedBy = useCallback(
    (c: StoredConnection) => {
      // What uses a connection follows from its kind: an environment deploys with a cluster or a registry.
      const used = usedByKind(categoryOf(c.provider));
      if (used === 'environments') {
        const names = envUses.get(c.id);
        return names?.length ? t('int_used_envs', { names: names.join(', ') }) : t('int_used_none');
      }
      return used === 'gear_repositories' ? t('int_used_gear_repos') : '—';
    },
    [categoryOf, envUses, t]
  );

  const remove = useCallback(
    (c: StoredConnection) =>
      ask(
        {
          title: inheritedOf(c) ? t('int_remove_shared_title', { label: c.label }) : t('int_remove_title', { label: c.label }),
          body: inheritedOf(c) ? t('int_remove_shared_body') : t('int_remove_body'),
          confirmLabel: t('remove'),
        },
        async () => {
          await api.deleteConnection(c.id, org.id).fetch(undefined);
          onChanged();
        }
      ),
    [ask, inheritedOf, t, api, org.id, onChanged]
  );

  const { load: localLoad, reloadBridge } = useLocalGridLoad(connections, {
    search: (c) => [c.label, c.account, c.base_url, nameOf(c.provider)],
    filter: (c, filters) => {
      const kind = tagGroupChoice(filters[CONNECTION_FILTERS.kind]);
      const provider = tagGroupChoice(filters[CONNECTION_FILTERS.provider]);
      return (!kind || categoryOf(c.provider) === kind) && (!provider || c.provider === provider);
    },
    compare: {
      connection: (a, b) => a.label.localeCompare(b.label),
      kind: (a, b) => categoryTitle(a.provider).localeCompare(categoryTitle(b.provider)),
    },
  });
  const load = useCallback(
    (context: DataGridLoadContext) => {
      writeGridAddress(context, CONNECTIONS_LIST_PREFIX, ADDRESS_FILTERS);
      return localLoad(context);
    },
    [localLoad]
  );

  const columns = useMemo<DataGridTableColumn<StoredConnection>[]>(
    () => [
      { id: 'connection', label: t('int_col_connection'), component: ConnectionCell },
      { id: 'kind', label: t('int_col_kind'), component: KindCell, width: 128 },
      { id: 'answers', label: t('int_col_answers'), component: AnswerCell },
      { id: 'used', label: t('int_col_used'), component: UsedCell, width: 160 },
      { id: 'scope', label: t('int_col_scope'), component: ScopeCell, width: 160 },
    ],
    [t]
  );
  const filters = useMemo(() => {
    const kinds = kindsPresent ? kindsPresent.split(',') : [];
    const present = providersPresent ? providersPresent.split(',') : [];
    return [
      ...(kinds.length > 0
        ? [
            filterTagGroup({
              id: CONNECTION_FILTERS.kind,
              label: t('int_kind'),
              mode: 'radio',
              options: kinds.map((key) => ({ value: key, label: t(`int_cat_${key}`) })),
            }),
          ]
        : []),
      ...(present.length > 1
        ? [
            filterTagGroup({
              id: CONNECTION_FILTERS.provider,
              label: t('int_provider'),
              mode: 'radio',
              options: present.map((p) => ({ value: p, label: nameOf(p) })),
            }),
          ]
        : []),
    ];
  }, [t, kindsPresent, providersPresent, nameOf]);

  const cells = useMemo<ConnectionCells>(
    () => ({
      t,
      orgName: org.name,
      health,
      now,
      editing,
      open,
      nameOf,
      categoryTitle,
      defaultUrl,
      inheritedOf,
      browsable,
      usedBy,
      retest,
      onEdit: (c) => {
        setOpen(null);
        setEditing((was) => (was === c.id ? null : c.id));
      },
      onBrowse: (c) => {
        setEditing(null);
        setOpen((was) => (was === c.id ? null : c.id));
      },
      onRemove: remove,
    }),
    [t, org.name, health, now, editing, open, nameOf, categoryTitle, defaultUrl, inheritedOf, browsable, usedBy, retest, remove]
  );

  const edited = editing ? connections.find((c) => c.id === editing) : undefined;
  const browsed = !edited && open ? connections.find((c) => c.id === open && browsable(c)) : undefined;

  return (
    <Card data-connections>
      <CardContent className={styles.cardBody}>
        <div className={styles.toolbar}>
          <h3 className={styles.subtitle}>{t('int_connections')}</h3>
          <span className={own.spacer} />
          <Button size="sm" disabled={adding} onClick={() => onAdd()} data-connection-add>
            {personal ? t('int_add_personal') : t('int_add_for_org', { organization: org.name })}
          </Button>
        </div>

        {loading ? (
          <p className={styles.muted}>{t('reading')}</p>
        ) : (
          <ConnectionCellsProvider value={cells}>
            <ListGrid<StoredConnection>
              name="connections"
              label={t('int_connections')}
              columns={columns}
              load={load}
              search={t('int_search')}
              filters={filters}
              empty={ConnectionsEmpty}
              unsortable={['answers', 'used', 'scope']}
              minWidth="56rem"
            >
              <DataGridRowActionsPlugin<StoredConnection> component={RowActions} />
              <GridAddress prefix={CONNECTIONS_LIST_PREFIX} filterKeys={ADDRESS_FILTERS} />
              {reloadBridge}
            </ListGrid>
          </ConnectionCellsProvider>
        )}

        {/* The editor and the repository browser open below the list, not under their row. */}
        {edited && (
          <div data-connection-detail={edited.id}>
            <EditConnection
              org={org}
              connection={edited}
              onNote={onNote}
              onDone={(changed) => {
                setEditing(null);
                if (changed) {
                  // A rotated credential invalidates the cached answer: it was for the old token.
                  healthCache.delete(edited.id);
                  retest(edited);
                  onChanged();
                }
              }}
            />
          </div>
        )}
        {browsed && (
          <div data-connection-detail={browsed.id}>
            <RepoBrowser
              org={org}
              connection={browsed}
              sourcesTick={sourcesTick}
              onSourcesChanged={onSourcesChanged}
              onNote={onNote}
            />
          </div>
        )}

        {missing.length > 0 && (
          <div className={own.missing} data-connections-missing>
            <span className={styles.sub}>{t('int_missing')}</span>
            {missing.map((key) => (
              <span key={key}>
                <b>{t(`int_cat_${key}`)}</b>{' '}
                <span className={styles.sub}>
                  — {MISSING_EXPLAINED.includes(key) ? t(`int_missing_${key}`) : t('int_missing_other')}
                </span>{' '}
                <Button size="sm" variant="link" onClick={() => onAdd(key)} data-missing-add={key}>
                  {t('int_add_kind')}
                </Button>
              </span>
            ))}
          </div>
        )}
      </CardContent>
      {confirmDialog}
    </Card>
  );
}
