/**
 * What the Issues kit reads and writes (the prototype's Issues tab,
 * ADR-0069). The queue, its groups and its actions, and whether anything
 * stops a build, are the server's (`GET /spec-model/issues`,
 * `GET /spec-model/readiness`); so is every fact's review key (`fact_key` on
 * `GET /spec-model`). The documentation-quality rows are still read off the
 * model here (doc-quality.ts), so the model, the glossary and the reviews are
 * read too. The organization's members (studio-user) are whom an issue can go to.
 */

import { BaseApiService, RestEndpointProtocol, RestProtocol } from '@gears-frontx/react';
import type { SpecModelBuildEstimate } from '../model/build-eta';
import type { GlossaryEntry, SpecModelBuild } from '../model/spec-model';
import type {
  MemberIdentities,
  NewIssue,
  OrgMember,
  ReviewWrite,
  SpecModelEntityEdit,
  SpecModelIssueRowList,
  SpecModelReadiness,
  SpecModelReview,
  SpecModelSentence,
  SpecModelWrite,
  ServedSpecModel,
} from './types';

const q = (params: Record<string, string>) => new URLSearchParams(params).toString();
const e = encodeURIComponent;
const DOCS = '/studio-documents/v1/spec-model';

/** The largest page the issues route and the members route answer. */
export const MAX_PAGE = 200;

export class IssuesApiService extends BaseApiService {
  constructor() {
    const restProtocol = new RestProtocol({ timeout: 60000 });
    const restEndpoints = new RestEndpointProtocol(restProtocol);
    // The gateway prefix: every path below names its gear.
    super({ baseURL: '/cf' }, restProtocol, restEndpoints);
  }

  private get rest() {
    return this.protocol(RestEndpointProtocol);
  }

  /* ── reads ── */

  readonly model = this.protocol(RestEndpointProtocol).queryWith<ServedSpecModel, { projectId: string }>(
    ({ projectId }) => `${DOCS}?${q({ project_id: projectId })}`
  );

  readonly issuesPage = this.protocol(RestEndpointProtocol).queryWith<
    SpecModelIssueRowList,
    { projectId: string; offset: number }
  >(({ projectId, offset }) => `${DOCS}/issues?${q({ project_id: projectId, offset: String(offset), limit: String(MAX_PAGE) })}`);

  /** The whole queue: the screen searches and filters it as one table. */
  async issues(projectId: string): Promise<SpecModelIssueRowList> {
    const first = await this.issuesPage({ projectId, offset: 0 }).fetch({ staleTime: 0 });
    const items = [...first.items];
    while (items.length < first.total) {
      const page = await this.issuesPage({ projectId, offset: items.length }).fetch({ staleTime: 0 });
      if (page.items.length === 0) break;
      items.push(...page.items);
    }
    return { ...first, items };
  }

  readonly readiness = this.protocol(RestEndpointProtocol).queryWith<SpecModelReadiness, { projectId: string }>(
    ({ projectId }) => `${DOCS}/readiness?${q({ project_id: projectId })}`
  );

  readonly glossary = this.protocol(RestEndpointProtocol).queryWith<
    { items: GlossaryEntry[]; total: number },
    { projectId: string }
  >(({ projectId }) => `${DOCS}/glossary?${q({ project_id: projectId })}`);

  readonly reviews = this.protocol(RestEndpointProtocol).queryWith<
    { items: SpecModelReview[]; total: number },
    { projectId: string }
  >(({ projectId }) => `${DOCS}/reviews?${q({ project_id: projectId })}`);

  readonly buildEstimate = this.protocol(RestEndpointProtocol).queryWith<SpecModelBuildEstimate, { projectId: string }>(
    ({ projectId }) => `${DOCS}/build-estimate?${q({ project_id: projectId })}`
  );

  readonly membersPage = this.protocol(RestEndpointProtocol).queryWith<
    { items?: OrgMember[]; total?: number },
    { orgId: string; offset: number }
  >(({ orgId, offset }) => `/studio-user/v1/organizations/${e(orgId)}/members?${q({ offset: String(offset), limit: String(MAX_PAGE) })}`);

  /** An organization's members, every page (`people.view`). */
  async orgMembers(orgId: string): Promise<OrgMember[]> {
    const items: OrgMember[] = [];
    for (let offset = 0; ; offset += MAX_PAGE) {
      const body = await this.membersPage({ orgId, offset }).fetch({ staleTime: 0 });
      const page = body.items ?? [];
      items.push(...page);
      const total = typeof body.total === 'number' ? body.total : items.length;
      if (page.length === 0 || items.length >= total) return items;
    }
  }

  readonly memberIdentities = this.protocol(RestEndpointProtocol).queryWith<
    MemberIdentities,
    { orgId: string; userId: string }
  >(({ orgId, userId }) => `/studio-user/v1/organizations/${e(orgId)}/members/${e(userId)}/identities`);

  /* ── writes ── */

  /** Read every document not yet read at its revision, on the caller's own model key. */
  readonly startBuild = this.protocol(RestEndpointProtocol).mutation<SpecModelBuild, { project_id: string }>(
    'POST',
    `${DOCS}/builds`
  );

  /** A member's ✓ (a real problem) or ✗ (fine) on one finding. */
  decideFinding(fingerprint: string) {
    return this.rest.mutation<
      { fingerprint: string; decision: string },
      { project_id: string; decision: 'confirmed' | 'dismissed' }
    >('POST', `${DOCS}/findings/${e(fingerprint)}/decision`);
  }

  /** Propose a finding's fix as a pull request on the document it names. */
  proposeFix(projectId: string, fingerprint: string) {
    return this.rest.mutation<SpecModelWrite, void>(
      'POST',
      `${DOCS}/findings/${e(fingerprint)}/proposals?${q({ project_id: projectId })}`
    );
  }

  /** Open an issue in the project's repository for a row, assigned by GitHub login. */
  readonly createIssue = this.protocol(RestEndpointProtocol).mutation<
    { number: number; url?: string | null },
    NewIssue & { project_id: string }
  >('POST', `${DOCS}/issues`);

  /** Record reviews and decisions kept by key (`iss:<row key>` for an opened issue). */
  readonly review = this.protocol(RestEndpointProtocol).mutation<
    { items: SpecModelReview[]; total: number },
    { project_id: string; items: ReviewWrite[] }
  >('POST', `${DOCS}/reviews`);

  /** Save one entity's section of docs/domain-model.md. */
  saveEntity(projectId: string) {
    return this.rest.mutation<SpecModelWrite, SpecModelEntityEdit>('POST', `${DOCS}/entities?${q({ project_id: projectId })}`);
  }

  /** Open a pull request adding a sentence to a document. */
  proposeSentence(projectId: string) {
    return this.rest.mutation<SpecModelWrite, SpecModelSentence>(
      'POST',
      `${DOCS}/sentences/proposals?${q({ project_id: projectId })}`
    );
  }

  /** Read one glossary entry as another (the glossary's merge). */
  readonly decideGlossaryEntry = this.protocol(RestEndpointProtocol).mutation<
    { key: string; name: string | null; alias_of: string | null },
    { project_id: string; key: string; name: string | null; alias_of: string | null }
  >('POST', `${DOCS}/glossary/decisions`);
}
