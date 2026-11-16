/**
 * Background work (ADR-0069 parity: Organization › Background work): the runs
 * `studio-tasks` keeps and the schedules `studio-scheduler` fires.
 */

import { BaseApiService, RestEndpointProtocol, RestProtocol } from '@gears-frontx/react';
import type { TaskRun, TaskSchedule } from '../background/types';

export interface RunsQuery {
  /** The organization in view: its runs, its workspaces' and its projects', never another's. */
  organizationId?: string;
  state?: string;
  taskType?: string;
  limit: number;
  offset?: number;
}

function runsPath({ organizationId, state, taskType, limit, offset }: RunsQuery): string {
  const q = new URLSearchParams({ limit: String(limit) });
  if (organizationId) q.set('organization_id', organizationId);
  if (state) q.set('state', state);
  if (taskType) q.set('task_type', taskType);
  if (offset) q.set('offset', String(offset));
  return `/studio-tasks/v1/runs?${q}`;
}

function tenantQuery(tenant: string | undefined): string {
  return tenant ? `?${new URLSearchParams({ tenant })}` : '';
}

/** A schedule of the organization: its payload names it (`organization_id`, the platform's schedules' rule). */
export function scheduleOf(schedule: Pick<TaskSchedule, 'payload'>, organizationId: string): boolean {
  return schedule.payload?.organization_id === organizationId;
}

export class BackgroundApiService extends BaseApiService {
  constructor() {
    const restProtocol = new RestProtocol({ timeout: 30000 });
    const restEndpoints = new RestEndpointProtocol(restProtocol);
    super({ baseURL: '/cf' }, restProtocol, restEndpoints);
  }

  readonly runs = this.protocol(RestEndpointProtocol).queryWith<{ items: TaskRun[]; total?: number }, RunsQuery>(
    runsPath
  );

  readonly taskTypes = this.protocol(RestEndpointProtocol).query<{ items: string[] }>('/studio-tasks/v1/task-types');

  readonly schedules = this.protocol(RestEndpointProtocol).query<{ items: TaskSchedule[] }>(
    '/studio-scheduler/v1/schedules'
  );

  /** `tenant`: the run's own, which an organization's listing may show from a workspace or project. */
  cancel(runId: string, tenant?: string) {
    return this.protocol(RestEndpointProtocol).mutation<TaskRun, void>(
      'POST',
      `/studio-tasks/v1/runs/${encodeURIComponent(runId)}/cancel${tenantQuery(tenant)}`
    );
  }

  retry(runId: string, tenant?: string) {
    return this.protocol(RestEndpointProtocol).mutation<TaskRun, void>(
      'POST',
      `/studio-tasks/v1/runs/${encodeURIComponent(runId)}/retry${tenantQuery(tenant)}`
    );
  }

  runNow(scheduleId: string) {
    return this.protocol(RestEndpointProtocol).mutation<{ run_id: string }, void>(
      'POST',
      `/studio-scheduler/v1/schedules/${encodeURIComponent(scheduleId)}/run-now`
    );
  }
}
