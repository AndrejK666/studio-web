/**
 * Admin › Secrets — the prototype's `SecretsView` (`App.tsx`) carried over
 * (ADR-0069): repository credentials in credstore. Values are write-only;
 * credstore has no list endpoint, so the section lists the references this
 * organization's workspaces name (their settings' root token, the connections
 * behind their sources), probes each with a read, and rotates or deletes one.
 * Anything saved outside the portal does not appear. The list is `SecretsGrid`,
 * on the kit's DataGrid (#1076).
 */

import { useCallback, useEffect, useState } from 'react';
import { apiRegistry } from '@gears-frontx/react';
import { Button, Card, CardContent, Input } from '@gears-frontx/ui-kit';
import {
  AccountsApiService,
  PROJECT_CONFIG_TYPE,
  responseStatus,
  useOrganization,
  type OrganizationRef,
  type ProjectConfig,
} from '@constructor-studio/mfe-shared';
import { AdminApiService } from '../../api/AdminApiService';
import type { Connection, WorkspaceSettings } from '../../api/types';
import { GridFailed } from '@constructor-studio/mfe-shared/grid';
import { knownSecretRefs, type SecretRow, type WorkspaceSecrets } from '../../model/secrets';
import { ErrorLine, Header, errText, useAdmin, useConfirm } from './common';
import { SecretsGrid, type SecretHealth } from './SecretsGrid';
import styles from './Admin.module.css';

export const WS_SETTINGS_TYPE = 'gts.cf.core.am.tenant_metadata.v1~cf.studio.workspace.settings.v1~';
/** Repository credentials are workspace-scoped (tenant sharing): the api_key type. */
export const PAT_SECRET_TYPE = 'gts.cf.core.credstore.secret.v1~cf.core.credstore.api_key.v1~';

export function SecretsSection() {
  const { t } = useAdmin();
  const { org, loading } = useOrganization();
  if (loading) return <p className={styles.muted}>{t('reading')}</p>;
  if (!org) return <p className={styles.muted}>{t('no_org')}</p>;
  return <Secrets key={org.id} org={org} />;
}

function Secrets({ org }: { org: OrganizationRef }) {
  const { t } = useAdmin();
  const api = apiRegistry.getService(AdminApiService);
  const accounts = apiRegistry.getService(AccountsApiService);
  const [ask, confirmDialog] = useConfirm();
  const [rows, setRows] = useState<SecretRow[] | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [rotating, setRotating] = useState<string | null>(null);
  const [newValue, setNewValue] = useState('');
  const [status, setStatus] = useState<Record<string, SecretHealth>>({});
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        // A workspace's settings carry its root token; a project's config its sources, whose tokens are the
        // connections'. Project config is read from the projects, under each workspace and straight under the
        // organization: a workspace has none (walk 2026-11-16: five 404s and "No secret references found").
        const [workspaces, orgProjects, orgConnections] = await Promise.all([
          accounts.getWorkspaces({ organizationId: org.id }).fetch({ staleTime: 0 }).then((p) => p?.items ?? []),
          accounts.getProjects({ parentId: org.id }).fetch({ staleTime: 0 }).then((p) => p?.items ?? [], () => []),
          api
            .connections({ tenant: org.id })
            .fetch({ staleTime: 0 })
            .then((p) => p.items)
            .catch((): Connection[] => []),
        ]);
        const projectSecrets = async (project: { id: string; name: string }, where: string, connections: Connection[]) => {
          const config = await accounts
            .getTenantMetadata<ProjectConfig>({ tenantId: project.id, metadataType: PROJECT_CONFIG_TYPE })
            .fetch({ staleTime: 0 })
            .catch(() => null);
          return { name: `${where}${project.name}`, sources: config?.value?.sources, connections };
        };
        const perWorkspace = await Promise.all(
          workspaces.map(async (ws) => {
            const [settings, connections, projects] = await Promise.all([
              accounts
                .getTenantMetadata<WorkspaceSettings>({ tenantId: ws.id, metadataType: WS_SETTINGS_TYPE })
                .fetch({ staleTime: 0 })
                .catch(() => null),
              api
                .connections({ tenant: ws.id })
                .fetch({ staleTime: 0 })
                .then((p) => p.items)
                .catch((): Connection[] => []),
              accounts
                .getProjects({ parentId: ws.id })
                .fetch({ staleTime: 0 })
                .then((p) => p?.items ?? [], () => []),
            ]);
            const reachable = [...connections, ...orgConnections];
            return [
              { name: ws.name, rootTokenRef: settings?.value?.root_token_ref, connections: reachable },
              ...(await Promise.all(projects.map((p) => projectSecrets(p, `${ws.name} / `, reachable)))),
            ];
          })
        );
        const each: WorkspaceSecrets[] = [
          { name: org.name, connections: orgConnections, listsConnections: true },
          ...perWorkspace.flat(),
          ...(await Promise.all(orgProjects.map((p) => projectSecrets(p, '', orgConnections)))),
        ];
        if (!live) return;
        setRows(knownSecretRefs(each));
        setReadError(null);
      } catch (e) {
        if (!live) return;
        setRows([]);
        setReadError(errText(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [api, accounts, org.id, org.name, tick]);

  const check = useCallback(
    async (ref: string) => {
      setStatus((s) => ({ ...s, [ref]: 'checking' }));
      const r: SecretHealth = await api
        .secret({ reference: ref })
        .fetch({ staleTime: 0 })
        .then(
          () => 'ok' as const,
          () => 'broken' as const
        );
      setStatus((s) => ({ ...s, [ref]: r }));
    },
    [api]
  );

  async function rotate(ref: string) {
    const value = newValue.trim();
    if (!value) return;
    setError(null);
    try {
      try {
        await api.createSecret.fetch({ reference: ref, value, sharing: 'tenant', type: PAT_SECRET_TYPE });
      } catch (e) {
        // 409: the reference exists. Rotate it instead — the unconditional overwrite.
        if (responseStatus(e) !== 409) throw e;
        await api.rotateSecret(ref).fetch({ value, sharing: 'tenant', type: PAT_SECRET_TYPE });
      }
      setRotating(null);
      setNewValue('');
      await check(ref);
    } catch (e) {
      setError(errText(e));
    }
  }

  const onCheck = useCallback((ref: string) => void check(ref), [check]);
  const onRotate = useCallback((ref: string) => {
    setNewValue('');
    setRotating((was) => (was === ref ? null : ref));
  }, []);
  const onDelete = useCallback(
    (ref: string) =>
      ask(
        { title: t('secrets_delete_confirm', { ref }), body: t('secrets_delete_body'), confirmLabel: t('delete') },
        async () => {
          await api.deleteSecret(ref).fetch(undefined);
          setStatus((st) => ({ ...st, [ref]: 'broken' }));
        }
      ),
    [ask, t, api]
  );

  return (
    <>
      <Header title={t('secrets_title')} info={<p>{t('secrets_about')}</p>} />
      {error && <ErrorLine>{error}</ErrorLine>}
      <Card data-secrets>
        <CardContent className={styles.cardBody}>
          {rows === null ? (
            <p className={styles.muted}>{t('reading')}</p>
          ) : readError ? (
            <GridFailed message={readError} retry={t('retry')} onRetry={() => setTick((n) => n + 1)} />
          ) : (
            <SecretsGrid
              secrets={rows}
              t={t}
              status={status}
              onCheck={onCheck}
              onRotate={onRotate}
              onDelete={onDelete}
            />
          )}
          {/* A new value is asked for below the list, not under its row. */}
          {rotating && (
            <form
              className={styles.inline}
              onSubmit={(e) => {
                e.preventDefault();
                void rotate(rotating);
              }}
              data-secret-rotating={rotating}
            >
              <Input
                className={styles.search}
                type="password"
                autoFocus
                aria-label={t('secrets_new_value_for', { ref: rotating })}
                placeholder={t('secrets_new_value')}
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
              />
              <Button type="submit" size="sm" disabled={!newValue.trim()} data-secret-save>
                {t('save')}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setRotating(null)}>
                {t('cancel')}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
      {confirmDialog}
    </>
  );
}
