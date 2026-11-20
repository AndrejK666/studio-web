import { useState } from 'react';
import { apiRegistry, useApiQuery, useSharedProperty, type ChildMfeBridge } from '@gears-frontx/react';
import { Card, CardContent, CardHeader, CardTitle, NativeSelect, NativeSelectOption, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@gears-frontx/ui-kit';
import { anchorKitThemeOnShadowHost, OrganizationProvider, STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT, StudioMfeLifecycle, useHostChrome, useOrganization } from '@constructor-studio/mfe-shared';
import kitTheme from '@gears-frontx/ui-kit/theme.css?inline';
import { ReportsApiService } from './api/ReportsApiService';
import { mfeApp } from './init';
import { useReportsTranslations } from './i18n';
import { METRIC_PERIODS, metricRows, type MetricPeriod } from './model/metrics';

function MetricsCard({ organizationId, projectId }: { organizationId: string; projectId?: string }) {
  const { t, loading } = useReportsTranslations();
  const { language } = useHostChrome();
  const [range, setRange] = useState<MetricPeriod>('30d');
  const query = useApiQuery(apiRegistry.getService(ReportsApiService).metrics({ organizationId, projectId, range }), {
    staleTime: 60_000,
  });
  if (loading) return null;

  const number = new Intl.NumberFormat(language);
  const value = (n: number | null) => n === null ? '—' : number.format(n);
  const metrics = query.data;
  const spend = metrics?.costs === 'shown' ? metrics.spend : null;
  const currency = spend && new Intl.NumberFormat(language, { style: 'currency', currency: spend.currency });
  return (
    <Card data-overview-metrics>
      <CardHeader>
        <CardTitle>{t('metrics_title')}</CardTitle>
        <NativeSelect aria-label={t('metrics_period')} value={range} onChange={(event) => setRange(event.target.value as MetricPeriod)}>
          {METRIC_PERIODS.map((period) => (
            <NativeSelectOption key={period} value={period}>{t(`metrics_period_${period}`)}</NativeSelectOption>
          ))}
        </NativeSelect>
      </CardHeader>
      <CardContent>
        {query.isError ? <p role="status">{t('metrics_unavailable')}</p> : !metrics ? (
          <p role="status">{t('metrics_reading')}</p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow><TableHead>{t('metrics_measure')}</TableHead><TableHead>{t('metrics_current')}</TableHead><TableHead>{t('metrics_previous')}</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {metricRows(metrics).map((row) => (
                  <TableRow key={row.label}><TableCell>{t(row.label)}</TableCell><TableCell>{value(row.current)}</TableCell><TableCell>{value(row.previous)}</TableCell></TableRow>
                ))}
                {spend && currency && (
                  <TableRow><TableCell>{t('metrics_cost')}</TableCell><TableCell>{currency.format(spend.current)}</TableCell><TableCell>{currency.format(spend.previous)}</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
            {metrics.insight.state !== 'ok' && <p>{t('metrics_insight_unavailable')}</p>}
            {metrics.insight.truncated && <p>{t('metrics_partial')}</p>}
            {spend?.unpriced.length ? <p>{t('metrics_unpriced')}</p> : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function OverviewMetrics({ projectScoped }: { projectScoped: boolean }) {
  const { org } = useOrganization();
  const project = useSharedProperty(STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT);
  const projectId = projectScoped && typeof project === 'string' && project ? project : undefined;
  if (!org || (projectScoped && !projectId)) return null;
  return <MetricsCard key={`${org.id}/${projectId ?? ''}`} organizationId={org.id} projectId={projectId} />;
}

class MetricsLifecycle extends StudioMfeLifecycle {
  constructor() {
    super(mfeApp, anchorKitThemeOnShadowHost(kitTheme));
  }

  protected renderContent(bridge: ChildMfeBridge) {
    return (
      <OrganizationProvider>
        <OverviewMetrics projectScoped={bridge.extDomainId.endsWith('project_overview_content.v1')} />
      </OrganizationProvider>
    );
  }
}

export default new MetricsLifecycle();
