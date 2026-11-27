export const METRIC_PERIODS = ['7d', '30d', '90d'] as const;
export type MetricPeriod = (typeof METRIC_PERIODS)[number];

export interface StudioMetrics {
  insight: {
    state: string;
    truncated: boolean;
    measures: {
      key: string;
      current: { total: number; people: number } | null;
      previous: { total: number; people: number } | null;
    }[];
  };
  costs: 'shown' | 'hidden' | 'unreadable';
  spend: { current: number; previous: number; currency: string; unpriced: string[] } | null;
}

export function metricRows(metrics: StudioMetrics) {
  const measures = new Map(metrics.insight.measures.map((measure) => [measure.key, measure]));
  return [
    { label: 'metrics_merged', measure: measures.get('git.pr_merged'), field: 'total' as const },
    { label: 'metrics_bugs', measure: measures.get('task.bugs_fixed'), field: 'total' as const },
    { label: 'metrics_contributors', measure: measures.get('git.contributors'), field: 'people' as const },
  ].map(({ label, measure, field }) => ({
    label,
    current: measure?.current?.[field] ?? null,
    previous: measure?.previous?.[field] ?? null,
  }));
}
