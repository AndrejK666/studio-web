/**
 * The organization's workspaces — the prototype's `ProjectsPortfolio`
 * (`projects.tsx`): one row a workspace with what the organization overview
 * says of it (spend over 30 days and its change, failing specs, pull requests
 * stuck past the overview's threshold, quiet days), its projects folded under
 * it, search and the managed filter; open, rename, delete.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FRONTX_SHARED_PROPERTY_LANGUAGE,
  apiRegistry,
  useApiQuery,
  useMfeBridge,
  useSharedProperty,
} from "@gears-frontx/react";
import { Button, Skeleton } from "@gears-frontx/ui-kit";
import {
  openPlace,
  useOrganization,
  AccountsApiService,
  STUDIO_SHARED_PROPERTY_CONTEXT_WORKSPACE,
  type OrganizationRef,
  type Tenant,
} from "@constructor-studio/mfe-shared";
import { requestWorkspace } from "../../actions/workspaceActions";
import { OverviewApiService } from "../../api/OverviewApiService";
import { ConfirmDialog, NameDialog } from "../../components/dialogs";
import { useWorkspacesScreenTranslations, useWorkspacesText } from "../../i18n";
import { WorkspacesToolbar } from "./components/WorkspacesToolbar";
import { WorkspacesGrid } from "./components/WorkspacesGrid";
import { healthOf, projectCountOf } from "./model";
import styles from "./WorkspacesScreen.module.css";

/** A sum in the reader's language and the overview's currency. */
function money(value: number, currency: string, language: string): string {
  // A sum that rounds to nothing is $0, not -$0: a forecast or difference can come back as -0.2 (walk 2026-11-16).
  const whole = Math.round(value) === 0 ? 0 : value;
  try {
    return new Intl.NumberFormat(language, { style: "currency", currency, maximumFractionDigits: 0 }).format(whole);
  } catch {
    return `${Math.round(whole)} ${currency}`;
  }
}

// @cpt-dod:cpt-studiofrontend-dod-workspaces-screen-level:p1
const WorkspaceList: React.FC<{
  organization: OrganizationRef;
  translationsPending: boolean;
}> = ({ organization, translationsPending }) => {
  const bridge = useMfeBridge();
  const accounts = apiRegistry.getService(AccountsApiService);
  const t = useWorkspacesText();
  const [renaming, setRenaming] = useState<Tenant | null>(null);
  const [deleting, setDeleting] = useState<Tenant | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const published = useSharedProperty(FRONTX_SHARED_PROPERTY_LANGUAGE);
  const language = typeof published === "string" && published ? published : "en";
  // `staleTime: 0` is what makes the `refetch()` below reach the network, and
  // is not an accidental opt-out of the shared 30s default. There are two
  // caches, and this number is handed to both: react-query's, whose staleness
  // `refetch()` does override, and the one inside `descriptor.fetch`
  // (`SharedFetchCache`, also 30s), which it does not — `queryFn` calls into it
  // on every refetch and only `staleTime <= 0` counts an entry as stale there.
  // Raise this and creating a workspace stops adding a row for up to 30s: the
  // effect still calls `refetch()`, and no request is made.
  const { data, isLoading, isError, refetch } = useApiQuery(
    accounts.getWorkspaces({ organizationId: organization.id }),
    { staleTime: 0 },
  );

  // Spend, failing specs, stuck pull requests and quiet days per workspace:
  // the organization overview's numbers, shown where the workspaces are. Best
  // effort, as the prototype read it: without it those cells are dashes.
  const overview = useApiQuery(
    apiRegistry.getService(OverviewApiService).overview({ organizationId: organization.id }),
  ).data;

  const scopedWorkspace = useSharedProperty(
    STUDIO_SHARED_PROPERTY_CONTEXT_WORKSPACE,
  );
  const seenScoped = useRef(false);
  useEffect(() => {
    if (!seenScoped.current) {
      seenScoped.current = true;
      return;
    }
    void refetch();
  }, [scopedWorkspace, refetch]);

  const all = useMemo(() => data?.items ?? [], [data]);

  // The same count as each row's: the overview's projects, else the child count.
  const projectTotal = useMemo(
    () => all.reduce((sum, row) => sum + (projectCountOf(row, healthOf(overview, row.id)) ?? 0), 0),
    [all, overview],
  );


  const health = useCallback((row: Tenant) => healthOf(overview, row.id), [overview]);
  const cash = useCallback(
    (value: number) => money(value, overview?.currency || "USD", language),
    [overview, language],
  );

  // @cpt-dod:cpt-studiofrontend-dod-workspaces-screen-row-opens:p1
  const open = useCallback(
    (row: Tenant) => {
      requestWorkspace(bridge, { id: row.id, name: row.name }, organization.id);
    },
    [bridge, organization.id],
  );
  const openProject = useCallback(
    (workspaceId: string, projectId: string, failingSpecs = false) => openPlace(bridge, {
      organizationId: organization.id, workspaceId, projectId,
      ...(failingSpecs ? { route: '/projects/specs', view: 'failing-specs' } : {}),
    }),
    [bridge, organization.id],
  );

  const rename = async (name: string) => {
    if (!renaming) return;
    await accounts.renameTenant(renaming.id).fetch({ name });
    await refetch();
  };
  const remove = async () => {
    if (!deleting) return;
    await accounts.deleteTenant(deleting.id).fetch(undefined);
    await refetch();
  };
  const dialogLabels = { cancel: t("cancel"), close: t("close") };

  const pending = translationsPending || (isLoading && all.length === 0);

  return (
    <div className={styles.screen} ref={container}>
      <WorkspacesToolbar
        busy={pending}
        canCreate
        total={all.length}
        projectTotal={projectTotal}
        organizationName={organization.name}
      />

      <div className={styles.panel}>
        {pending ? (
          <div className={styles.loading}>
            <Skeleton className={styles.rowSkeleton} />
            <Skeleton className={styles.rowSkeleton} />
            <Skeleton className={styles.rowSkeleton} />
          </div>
        ) : (
          <>
            {isError && (
              <div className={styles.stateBlock}>
                <p className={styles.error}>{t("error_title")}</p>
                <Button
                  variant="secondary"
                  size="sm"
                  className={styles.retry}
                  onClick={() => void refetch()}
                >
                  {t("retry")}
                </Button>
              </div>
            )}
            {/* A failed read with nothing kept shows only the error, not "no workspaces yet". */}
            {!(isError && all.length === 0) && (
              <WorkspacesGrid
                // A new organization starts the grid clean; a new list of its workspaces reloads it.
                key={organization.id}
                workspaces={all}
                health={health}
                stuckDays={overview?.stuck_days ?? 7}
                cash={cash}
                onOpen={open}
                onOpenProject={openProject}
                onRename={setRenaming}
                onDelete={setDeleting}
              />
            )}
          </>
        )}
      </div>
      <NameDialog
        open={renaming !== null}
        title={t("rename_title", { name: renaming?.name ?? "" })}
        fieldLabel={t("rename_field")}
        initial={renaming?.name ?? ""}
        saveLabel={t("save")}
        savingLabel={t("saving")}
        labels={dialogLabels}
        container={container}
        onSave={rename}
        onClose={() => setRenaming(null)}
      />
      <ConfirmDialog
        open={deleting !== null}
        title={t("delete_title", { name: deleting?.name ?? "" })}
        body={t("delete_body")}
        confirmLabel={t("delete")}
        labels={dialogLabels}
        container={container}
        onConfirm={remove}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
};

WorkspaceList.displayName = "WorkspaceList";

export const WorkspacesScreen: React.FC = () => {
  const { isLoaded, error: translationsFailed } =
    useWorkspacesScreenTranslations();
  const t = useWorkspacesText();
  const { org, loading } = useOrganization();
  const translationsPending = !isLoaded && !translationsFailed;

  if (!org) {
    return (
      <div className={styles.screen} data-state="no-organization">
        <WorkspacesToolbar
          busy={loading || translationsPending}
          canCreate={false}
        />
        <p className={styles.note}>
          {loading ? t("resolving_org") : t("no_org")}
        </p>
      </div>
    );
  }

  return (
    <WorkspaceList
      organization={org}
      translationsPending={translationsPending}
    />
  );
};

WorkspacesScreen.displayName = "WorkspacesScreen";
