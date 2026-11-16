/**
 * Admin › All identities — the prototype's `IdentityDirectory`
 * (`identity-directory.tsx`) carried over (ADR-0069): everyone whose identity
 * exists in Studio Keycloak, including people waiting for organization
 * access; where Studio records them as belonging and what Keycloak still says;
 * and, per row, putting them in an organization with a role. The list is
 * `IdentitiesGrid`, on the kit's DataGrid (#1076).
 *
 * A platform administrator's alone. The menu offers it to everyone and the
 * backend refuses the others; the section shows that refusal rather than
 * guessing who may.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiRegistry } from '@gears-frontx/react';
import { Badge, Card, CardContent } from '@gears-frontx/ui-kit';
import { AccountsApiService, TENANT_TYPES, type Tenant } from '@constructor-studio/mfe-shared';
import { GridFailed } from '@constructor-studio/mfe-shared/grid';
import { AdminApiService } from '../../api/AdminApiService';
import type { MembershipRole, PlatformIdentity } from '../../api/types';
import { PLATFORM_ROOT_TENANT_ID, currentOrg, roleIn } from '../../model/members';
import { ErrorLine, Header, errText, useAdmin } from './common';
import { IdentitiesGrid } from './IdentitiesGrid';
import styles from './Admin.module.css';

const NO_IDENTITIES: PlatformIdentity[] = [];

export function IdentitiesSection() {
  const { t, language } = useAdmin();
  const api = apiRegistry.getService(AdminApiService);
  const accounts = apiRegistry.getService(AccountsApiService);
  const [identities, setIdentities] = useState<PlatformIdentity[] | null>(null);
  const [organizations, setOrganizations] = useState<Tenant[]>([]);
  const [readError, setReadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [roles, setRoles] = useState<Record<string, MembershipRole>>({});
  const [tick, setTick] = useState(0);
  const load = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    Promise.all([
      api.platformIdentities.fetch({ staleTime: 0 }),
      accounts.getOrganizations({ tenantId: PLATFORM_ROOT_TENANT_ID }).fetch({ staleTime: 0 }),
    ]).then(
      ([{ items }, page]) => {
        if (!live) return;
        setIdentities(items);
        setOrganizations((page?.items ?? []).filter((o) => o.tenant_type === TENANT_TYPES.organization));
        setReadError(null);
      },
      (e: unknown) => {
        if (!live) return;
        setIdentities([]);
        setReadError(errText(e));
      }
    );
    return () => {
      live = false;
    };
  }, [api, accounts, tick]);

  const roleLabel = useCallback(
    (role: string) => (['owner', 'admin', 'member'].includes(role) ? t(`role_${role}`) : role),
    [t]
  );
  const targetOf = useCallback((i: PlatformIdentity) => targets[i.id] ?? currentOrg(i), [targets]);
  const roleOf = useCallback(
    (i: PlatformIdentity): MembershipRole =>
      roles[i.id] ?? ((roleIn(i, targetOf(i)) as MembershipRole | undefined) || 'member'),
    [roles, targetOf]
  );
  const onTarget = useCallback(
    (i: PlatformIdentity, tenantId: string) => setTargets((cur) => ({ ...cur, [i.id]: tenantId })),
    []
  );
  const onRole = useCallback(
    (i: PlatformIdentity, role: MembershipRole) => setRoles((cur) => ({ ...cur, [i.id]: role })),
    []
  );

  const assign = useCallback(
    async (identity: PlatformIdentity) => {
      const tenantId = targetOf(identity);
      if (!tenantId) return;
      setBusyId(identity.id);
      setError(null);
      try {
        await api.assignIdentity(identity.id).fetch({ tenant_id: tenantId, role: roleOf(identity) });
        // The row now starts from what the server has, not from the picks.
        setTargets(({ [identity.id]: _target, ...rest }) => rest);
        setRoles(({ [identity.id]: _role, ...rest }) => rest);
        load();
      } catch (e) {
        setError(errText(e));
      } finally {
        setBusyId(null);
      }
    },
    [api, targetOf, roleOf, load]
  );
  const onAssign = useCallback((i: PlatformIdentity) => void assign(i), [assign]);

  // The grid reloads on a new array: the same one while nothing was read again.
  const list = identities ?? NO_IDENTITIES;
  const waiting = list.filter((i) => i.status === 'unassigned').length;

  return (
    <>
      <Header
        title={t('ids_title')}
        info={
          <>
            <p>{t('ids_about')}</p>
            <p>{t('ids_about_audit')}</p>
          </>
        }
        status={
          list.length > 0 && (
            <>
              <Badge variant="secondary">{t.count('ids_count', list.length)}</Badge>
              {waiting > 0 && <Badge variant="warning">{t.count('ids_waiting_count', waiting)}</Badge>}
            </>
          )
        }
      />
      {error && <ErrorLine>{error}</ErrorLine>}
      <Card data-identities>
        <CardContent className={styles.cardBody}>
          {identities === null ? (
            <p className={styles.muted}>{t('reading')}</p>
          ) : readError ? (
            <div data-identities-refused>
              <GridFailed message={readError} retry={t('retry')} onRetry={load} />
            </div>
          ) : (
            <IdentitiesGrid
              identities={list}
              t={t}
              language={language}
              organizations={organizations}
              busyId={busyId}
              roleLabel={roleLabel}
              targetOf={targetOf}
              roleOf={roleOf}
              onTarget={onTarget}
              onRole={onRole}
              onAssign={onAssign}
            />
          )}
        </CardContent>
      </Card>
    </>
  );
}
