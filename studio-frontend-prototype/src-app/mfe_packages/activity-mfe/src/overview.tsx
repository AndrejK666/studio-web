import React from 'react';
import { apiRegistry, useApiQuery, useMfeBridge, useSharedProperty } from '@gears-frontx/react';
import { Button, Card, CardContent, CardHeader, CardTitle, Skeleton } from '@gears-frontx/ui-kit';
import {
  anchorKitThemeOnShadowHost,
  openScreen,
  STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT,
  StudioMfeLifecycle,
} from '@constructor-studio/mfe-shared';
import kitTheme from '@gears-frontx/ui-kit/theme.css?inline';
import { ActivityApiService } from './api/ActivityApiService';
import { useActivityTranslations } from './i18n';
import { mfeApp } from './init';

function RecentActivity({ projectId }: { projectId: string }) {
  const bridge = useMfeBridge();
  const { t, loading } = useActivityTranslations();
  const feed = useApiQuery(apiRegistry.getService(ActivityApiService).activity({ projectId }), { staleTime: 60_000 });
  if (loading || feed.isLoading) return <Skeleton />;
  if (feed.isError || !feed.data?.items?.length) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('recent_activity')}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul>
          {feed.data.items.slice(0, 5).map((item) => (
            <li key={item.id}>{item.event} · {item.subject} · {item.by}</li>
          ))}
        </ul>
        <Button variant="link" size="sm" onClick={() => openScreen(bridge, '/projects/activity')}>
          {t('open_activity')}
        </Button>
      </CardContent>
    </Card>
  );
}

function ProjectOverviewActivity() {
  const project = useSharedProperty(STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT);
  if (typeof project !== 'string' || !project) return null;
  return (
    <React.Fragment key={project}>
      <OpenPulls projectId={project} />
      <RecentActivity projectId={project} />
    </React.Fragment>
  );
}

function OpenPulls({ projectId }: { projectId: string }) {
  const { t, loading } = useActivityTranslations();
  const pulls = useApiQuery(apiRegistry.getService(ActivityApiService).openPulls({ projectId }), { staleTime: 60_000 });
  if (loading || pulls.isLoading) return <Skeleton />;
  if (pulls.isError || !pulls.data?.items?.length) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('open_pulls', { count: pulls.data.total })}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul>
          {pulls.data.items.map((pull) => (
            <li key={pull.id}>
              {pull.url ? <a href={pull.url} target="_blank" rel="noreferrer">{pull.title}</a> : pull.title}
              {pull.reason && <> · {pull.reason}</>}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

class OverviewLifecycle extends StudioMfeLifecycle {
  constructor() {
    super(mfeApp, anchorKitThemeOnShadowHost(kitTheme));
  }

  protected renderContent(): React.ReactNode {
    return <ProjectOverviewActivity />;
  }
}

export default new OverviewLifecycle();
