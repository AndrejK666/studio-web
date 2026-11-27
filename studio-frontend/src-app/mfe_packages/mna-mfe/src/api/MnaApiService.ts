/**
 * The M&A kit's one service: every read and write of the Deal tab, all on
 * `studio-kits` under `/mna/*`, each scoped by `?project_id=` (the deal is
 * the project).
 */

import { BaseApiService, RestEndpointProtocol, RestProtocol } from '@gears-frontx/react';
import type { MnaDeal, MnaDealPatch, MnaEvidence, MnaLedger, MnaLedgers, MnaList } from './types';

export const MNA_API_BASE_URL = '/cf/studio-kits/v1';

const scoped = (path: string, projectId: string): string =>
  `${path}?${new URLSearchParams({ project_id: projectId }).toString()}`;

export const dealPath = ({ projectId }: { projectId: string }): string => scoped('/mna/deal', projectId);
export const evidencePath = ({ projectId }: { projectId: string }): string => scoped('/mna/evidence', projectId);

/** `/mna/<ledger>` or `/mna/<ledger>/<id>`, scoped to the project. */
export const ledgerPath = (ledger: MnaLedger, projectId: string, id?: string): string =>
  scoped(id === undefined ? `/mna/${ledger}` : `/mna/${ledger}/${encodeURIComponent(id)}`, projectId);

export class MnaApiService extends BaseApiService {
  constructor() {
    const restProtocol = new RestProtocol({ timeout: 30000 });
    super({ baseURL: MNA_API_BASE_URL }, restProtocol, new RestEndpointProtocol(restProtocol));
  }

  private get rest() {
    return this.protocol(RestEndpointProtocol);
  }

  readonly deal = this.protocol(RestEndpointProtocol).queryWith<MnaDeal, { projectId: string }>(dealPath);

  readonly evidence = this.protocol(RestEndpointProtocol).queryWith<MnaEvidence, { projectId: string }>(
    evidencePath
  );

  readonly findings = this.protocol(RestEndpointProtocol).queryWith<
    MnaList<MnaLedgers['findings']['row']>,
    { projectId: string }
  >(({ projectId }) => ledgerPath('findings', projectId));

  readonly risks = this.protocol(RestEndpointProtocol).queryWith<
    MnaList<MnaLedgers['risks']['row']>,
    { projectId: string }
  >(({ projectId }) => ledgerPath('risks', projectId));

  readonly questions = this.protocol(RestEndpointProtocol).queryWith<
    MnaList<MnaLedgers['open-questions']['row']>,
    { projectId: string }
  >(({ projectId }) => ledgerPath('open-questions', projectId));

  /** Change the deal's attributes; `recommendation` or `conditions` clear a sign-off. */
  updateDeal(projectId: string) {
    return this.rest.mutation<MnaDeal, MnaDealPatch>('PATCH', dealPath({ projectId }));
  }

  /** The deal lead signs the recommendation off. */
  signOff(projectId: string) {
    return this.rest.mutation<MnaDeal, void>('POST', scoped('/mna/deal/sign-off', projectId));
  }

  create<L extends MnaLedger>(ledger: L, projectId: string) {
    return this.rest.mutation<MnaLedgers[L]['row'], MnaLedgers[L]['body']>('POST', ledgerPath(ledger, projectId));
  }

  update<L extends MnaLedger>(ledger: L, projectId: string, id: string) {
    return this.rest.mutation<MnaLedgers[L]['row'], MnaLedgers[L]['body']>(
      'PUT',
      ledgerPath(ledger, projectId, id)
    );
  }

  remove(ledger: MnaLedger, projectId: string, id: string) {
    return this.rest.mutation<void, void>('DELETE', ledgerPath(ledger, projectId, id));
  }
}
