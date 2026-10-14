// Review requests on a project's documents and the verdicts given on them
// (studio-documents `/review-requests`, docs/design/studio-documents.md).
//
// A request names one version of one document, whom it asks, who of them is
// required, and when it is due. A verdict is a record and is never edited;
// the latest one per reviewer counts. What is here is the wording and the
// small decisions a screen makes about them, so they can be tested.

export interface ReviewerInput {
  person: string;
  name?: string | null;
  required: boolean;
}

export interface Reviewer {
  person: string;
  name?: string | null;
  required: boolean;
  verdict?: "approved" | "changes_requested" | null;
}

export interface ReviewVerdict {
  id: string;
  request_id: string;
  version: string;
  approver: string;
  approver_name?: string | null;
  verdict: "approved" | "changes_requested";
  note?: string | null;
  checks: string[];
  decided_at: string;
}

export interface ReviewRequest {
  id: string;
  project_id: string;
  subject_kind: "document" | "binding";
  subject_id: string;
  type_key?: string | null;
  title: string;
  version: string;
  requested_by: string;
  requested_by_name?: string | null;
  reviewers: Reviewer[];
  due_at?: string | null;
  state: "open" | "approved" | "superseded" | "withdrawn";
  overdue: boolean;
  outstanding: string[];
  created_at: string;
  verdicts: ReviewVerdict[];
}

/** The document a review is about. */
export interface ReviewSubject {
  kind: "document" | "binding";
  id: string;
  title: string;
  typeKey?: string | null;
  /** What is being reviewed: a binding's content sha, a document's revision. */
  version: string;
}

/** The body of `POST /review-requests`. A due date is a day; it is due at its
 *  end, in UTC. */
export function reviewRequestBody(
  projectId: string,
  subject: ReviewSubject,
  reviewers: ReviewerInput[],
  dueDay: string | null,
) {
  return {
    project_id: projectId,
    subject_kind: subject.kind,
    subject_id: subject.id,
    type_key: subject.typeKey ?? null,
    title: subject.title,
    version: subject.version,
    reviewers: reviewers.map((r) => ({ person: r.person, name: r.name ?? null, required: r.required })),
    due_at: dueDay ? `${dueDay}T23:59:59Z` : null,
  };
}

/** How a request reads in one line. */
export function reviewState(r: ReviewRequest): { label: string; tone: "ok" | "wait" | "late" | "muted" } {
  switch (r.state) {
    case "approved":
      return { label: "Approved", tone: "ok" };
    case "superseded":
      return { label: "Superseded by a later request", tone: "muted" };
    case "withdrawn":
      return { label: "Withdrawn", tone: "muted" };
    default:
      if (r.outstanding.length === 0) return { label: "Waiting for a first approval", tone: r.overdue ? "late" : "wait" };
      return {
        label: `${r.overdue ? "Overdue — waiting" : "Waiting"} for ${r.outstanding.join(", ")}`,
        tone: r.overdue ? "late" : "wait",
      };
  }
}

/** Whether the caller can give a verdict: an open request that names them. */
export function canDecide(r: ReviewRequest, me: string | null): boolean {
  return !!me && r.state === "open" && r.reviewers.some((x) => x.person === me);
}

/** The request the document stands on: the newest that is not superseded or
 *  withdrawn, else the newest at all. Requests arrive newest first. */
export function currentRequest(requests: ReviewRequest[]): ReviewRequest | null {
  return requests.find((r) => r.state === "open" || r.state === "approved") ?? requests[0] ?? null;
}

/** Whether a request is about an older version than the one on screen. */
export function isStale(r: ReviewRequest, version: string): boolean {
  return r.version !== version;
}

/** Add a person to the reviewers being picked, once; the first pick is required. */
export function addReviewer(list: ReviewerInput[], person: ReviewerInput): ReviewerInput[] {
  if (list.some((r) => r.person === person.person)) return list;
  return [...list, person];
}
