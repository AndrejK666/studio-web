import React, { useEffect, useState } from 'react';
import { apiRegistry, useApiQuery, useMfeBridge, useSharedProperty } from '@gears-frontx/react';
import { Button, Card, CardContent, CardHeader, CardTitle, Skeleton } from '@gears-frontx/ui-kit';
import {
  anchorKitThemeOnShadowHost,
  openScreen,
  type OpenPullRequest,
  STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT,
  StudioMfeLifecycle,
} from '@constructor-studio/mfe-shared';
import kitTheme from '@gears-frontx/ui-kit/theme.css?inline';
import { ActivityApiService } from './api/ActivityApiService';
import { useActivityTranslations } from './i18n';
import { mfeApp } from './init';
import { pullQueues } from './model/pullQueues';

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
  const api = apiRegistry.getService(ActivityApiService);
  const [pulls, setPulls] = useState<{ items: OpenPullRequest[]; membersKnown: boolean } | 'failed' | null>(null);
  useEffect(() => {
    let live = true;
    const load = async () => {
      const items = new Map<string, OpenPullRequest>();
      let membersKnown = true;
      for (let offset = 0; live;) {
        const page = await api.openPulls({ projectId, offset }).fetch({ staleTime: 60_000 });
        if (!live) return;
        const before = items.size;
        for (const pull of page.items) items.set(pull.id, pull);
        membersKnown &&= page.members_known !== false;
        offset += page.items.length;
        if (offset >= page.total) break;
        if (items.size === before) throw new Error('The open pull request list changed while it was read');
      }
      if (live) setPulls({ items: [...items.values()], membersKnown });
    };
    void load().catch(() => { if (live) setPulls('failed'); });
    return () => { live = false; };
  }, [api, projectId]);
  if (loading || pulls === null) return <Skeleton />;
  if (pulls === 'failed') return <p role="status">{t('pulls_unavailable')}</p>;
  if (!pulls.items.length) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('open_pulls', { count: pulls.items.length })}</CardTitle>
      </CardHeader>
      <CardContent>
        {!pulls.membersKnown && <p>{t('pulls_members_unavailable')}</p>}
        {pullQueues(pulls.items).map((queue) => (
          <details key={queue.key}>
            <summary>{queue.name ?? t(`pull_queue_${queue.key}`)} · {queue.pulls.length}</summary>
            <ul>
              {queue.pulls.map((pull) => (
                <li key={pull.id}>
                  {pull.url ? <a href={pull.url} target="_blank" rel="noreferrer">{pull.title}</a> : pull.title}
                  {pull.reason && <> · {pull.reason}</>}
                </li>
              ))}
            </ul>
          </details>
        ))}
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
