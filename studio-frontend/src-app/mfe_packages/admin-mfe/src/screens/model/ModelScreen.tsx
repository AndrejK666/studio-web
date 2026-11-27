/**
 * The shell's generic screens for the three levels (ADR-0066, the prototype's
 * `level-tabs-ui.tsx` and `object-attributes.tsx`): on an organization, a
 * workspace or a project, the **Attributes** tab — what the Studio domain
 * model records about that tenant — and every tab the model adds with a
 * `shows` relation no other screen answers (section `type:<name>`), which
 * lists the objects of the type the relation reaches.
 *
 * One entry with the rest of Admin; the extension the shell mounted says which
 * level this is (`model_<level>` in its id), the section which tab.
 */

import { useCallback, useMemo } from 'react';
import { useQueryCache, useSharedProperty } from '@gears-frontx/react';
import {
  STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT,
  STUDIO_SHARED_PROPERTY_CONTEXT_WORKSPACE,
  genericTabName,
  invalidateDomainTypes,
  modelOf,
  useDomainTypes,
  useOrganization,
  type DomainModel,
  type TabLevel,
} from '@constructor-studio/mfe-shared';
import { PageEmpty, PageError, PageLoading, ProjectPage } from '@constructor-studio/mfe-shared/page';
import { errText, useAdmin } from '../admin/common';
import { ObjectAttributes } from './ObjectAttributes';
import { TypeObjects } from './TypeObjects';

/** The level a generic screen extension stands for, from its id; null for any other screen. */
export function modelLevelOf(extensionId: string | undefined | null): TabLevel | null {
  const m = /\.model_(organization|workspace|project)(?:_types)?\.v1$/.exec(extensionId ?? '');
  return m ? (m[1] as TabLevel) : null;
}

export interface ModelRead {
  model: DomainModel | null;
  error: string | null;
  /** Reads it again, after an edit made here. */
  reload: () => void;
}

/** The organization's model, read again when it changes. */
export function useModel(orgId: string): ModelRead {
  // The one cached read of the model; the shell marks it stale when the live
  // channel says the model changed, and an edit here marks it stale itself.
  const read = useDomainTypes(orgId);
  const cache = useQueryCache();
  const reload = useCallback(() => invalidateDomainTypes(cache, orgId), [cache, orgId]);
  const model = useMemo(() => (read.data ? modelOf(read.data) : null), [read.data]);
  return read.isError
    ? { model: null, error: errText(read.error), reload }
    : { model, error: null, reload };
}

const isRef = (v: unknown): v is { id: string; name: string } =>
  typeof v === 'object' && v !== null && typeof (v as { id?: unknown }).id === 'string';

export function ModelScreen({ level, section }: { level: TabLevel; section: string | null }) {
  const { t } = useAdmin();
  const { org, loading } = useOrganization();
  const workspace = useSharedProperty<unknown>(STUDIO_SHARED_PROPERTY_CONTEXT_WORKSPACE);
  const project = useSharedProperty<unknown>(STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT);
  if (loading) return <ModelState title={null} loading={t('reading')} />;
  if (!org) return <ModelState title={t('model_attributes_title')} empty={t('no_org')} />;

  // The tenant the level is, and its name when the shell says it.
  const tenant =
    level === 'organization'
      ? { id: org.id, name: org.name }
      : level === 'workspace'
        ? isRef(workspace)
          ? workspace
          : null
        : typeof project === 'string' && project
          ? { id: project, name: '' }
          : null;
  if (!tenant) return <ModelState title={t('model_attributes_title')} empty={t('model_no_place')} />;
  return <Screen key={`${org.id}:${tenant.id}`} orgId={org.id} level={level} tenant={tenant} section={section} />;
}

function Screen({
  orgId,
  level,
  tenant,
  section,
}: {
  orgId: string;
  level: TabLevel;
  tenant: { id: string; name: string };
  section: string | null;
}) {
  const { t } = useAdmin();
  const { model, error, reload } = useModel(orgId);
  if (error) {
    return <ModelState title={t('model_attributes_title')} error={t('model_unreadable', { error })} onRetry={reload} />;
  }
  if (!model) return <ModelState title={null} loading={t('reading')} />;
  const tab = genericTabName(section);
  if (tab !== null) {
    return (
      <TypeObjects
        key={tab}
        orgId={orgId}
        model={model}
        level={level}
        tabName={tab}
        // The organization's objects are every scope's; below it, the place's own.
        scope={level === 'organization' ? null : tenant.id}
      />
    );
  }
  return <ObjectAttributes orgId={orgId} model={model} level={level} tenant={tenant} onModelChanged={reload} />;
}

/** A model tab before it has its model: read, nothing to show, or a failed read. */
function ModelState({
  title,
  loading,
  empty,
  error,
  onRetry,
}: {
  title: string | null;
  loading?: string;
  empty?: string;
  error?: string;
  onRetry?: () => void;
}) {
  const { t } = useAdmin();
  return (
    <ProjectPage title={title} busy={title === null}>
      {loading && <PageLoading label={loading} />}
      {empty && <PageEmpty title={empty} />}
      {error && <PageError message={error} retry={t('retry')} onRetry={onRetry} />}
    </ProjectPage>
  );
}
