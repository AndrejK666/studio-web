import React from "react";
import { Button, Skeleton } from "@gears-frontx/ui-kit";
import { useMfeBridge } from "@gears-frontx/react";
import { openWorkspaceForm } from "../../../actions/overlayActions";
import type { ScreenText } from "@constructor-studio/mfe-shared";
import { useWorkspacesText } from "../../../i18n";
import styles from "../WorkspacesScreen.module.css";

/** The screen's head: its title, the counts, and New workspace. The search and the managed filter are the grid's (#1076). */
interface WorkspacesToolbarProps {
  busy: boolean;
  canCreate: boolean;
  total?: number;
  projectTotal?: number;
  /** The organization the list is of, said beside the counts as the prototype did. */
  organizationName?: string;
}

function totalsLine(t: ScreenText, total: number, projectTotal: number, organizationName?: string): string {
  const counts = `${t.count("totals_workspaces", total)} · ${t.count("totals_projects", projectTotal)}`;
  return organizationName ? `${counts} ${t("in_org", { name: organizationName })}` : counts;
}

export const WorkspacesToolbar: React.FC<WorkspacesToolbarProps> = ({
  busy,
  canCreate,
  total,
  projectTotal,
  organizationName,
}) => {
  const bridge = useMfeBridge();
  const t = useWorkspacesText();

  return (
    <div
      className={styles.toolbar}
      role="toolbar"
      aria-label={t("toolbar_label")}
    >
      <div className={styles.heading}>
        <h2 className={styles.title}>
          {busy ? <Skeleton className={styles.titleSkeleton} /> : t("title")}
        </h2>
        {!busy && total !== undefined && projectTotal !== undefined && (
          <p className={styles.totals}>{totalsLine(t, total, projectTotal, organizationName)}</p>
        )}
      </div>

      <div className={styles.controls}>
        {/* @cpt-dod:cpt-studiofrontend-dod-workspaces-screen-create-moves:p1 */}
        <Button
          size="sm"
          disabled={!canCreate}
          title={canCreate ? undefined : t("new_workspace_no_org")}
          onClick={() => openWorkspaceForm(bridge)}
        >
          {t("new_workspace")}
        </Button>
      </div>
    </div>
  );
};

WorkspacesToolbar.displayName = "WorkspacesToolbar";
