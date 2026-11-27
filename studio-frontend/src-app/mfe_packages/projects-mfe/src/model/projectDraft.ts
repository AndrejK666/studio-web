/**
 * What the New project wizard is collecting, before anything is sent.
 *
 * The draft is deliberately *not* the wire shape. A project is created as two
 * writes — an AM tenant, then its `cf.studio.project.config.v1~` metadata
 * (ADR-0010) — and the split between them is an artifact of AM's API, not of
 * what the user filled in.
 *
 * Assumptions recorded here rather than in the UI, because the mockups are
 * silent on both and the FEATURE fixes them:
 *
 * - **Journey stages.** The wizard has no stage picker on either screen, so a
 *   new project starts with whatever the workspace's catalogue marks required.
 *   That used to be `['intent']` hardcoded here; the catalogue is served now
 *   (ADR-0014 section 7) and an organization may mark a different set, so the
 *   wizard reads it rather than assuming. The rest are added later from the
 *   project screen.
 * - **What comes next.** The wizard asks for a name, the project type, a goal
 *   and shows the owner; nothing else. The type decides the rest -- the
 *   `mode`, which optional steps the creation takes, and the next steps the
 *   project's Overview shows (ADR-0073). Repositories are connected from the
 *   project's Sources afterwards, with the same picker (`RepositoryPicker`).
 */

/** Only `draft` is reachable at creation; the ladder moves forward from there. */
export const INITIAL_STATUS = 'draft';

/**
 * Ceiling on how many repositories one Connect source picks at once.
 *
 * A product limit, not a technical one: nothing on the wire counts, and the
 * array is stored verbatim. It is not accidentally reachable either — one
 * catalogue page is clamped to 100 rows, so filling it takes a deliberate sweep
 * across connections.
 */
export const MAX_SOURCES = 100;

export interface RepositoryPick {
  /** Provider-native id, unique within one connection. */
  readonly id: string;
  /** `group/repo`, what the user recognises. */
  readonly fullPath: string;
  readonly cloneUrl: string;
  /** Which connection it came from — the tab the user was on. */
  readonly connectionId: string;
  /** The provider's default branch, when it reports one. */
  readonly defaultBranch?: string;
}

/**
 * Identity of a pick, and it has to be composite.
 *
 * `id` is the provider's own, "unique within one connection" and nothing more —
 * two connections can hand back the same string for different repositories. The
 * selection spans connections (a project may be seeded from a GitHub repo and a
 * GitLab one), so comparing on `id` alone would make one row's checkbox toggle
 * another's.
 */
export function repoKey(connectionId: string, repoId: string): string {
  return `${connectionId}:${repoId}`;
}

export function sourceKey(pick: RepositoryPick): string {
  return repoKey(pick.connectionId, pick.id);
}

export interface ProjectDraft {
  readonly name: string;
  /** The mockup's GOAL field; stored as `brief` in project metadata. */
  readonly goal: string;
  /** Keycloak `sub`. One owner, not a list. */
  readonly ownerId: string | null;
  /** The kit that is the project's type (`slug` of `project-creation-types`). */
  readonly typeKit?: string;
}

export const EMPTY_DRAFT: ProjectDraft = {
  name: '',
  goal: '',
  ownerId: null,
};

/**
 * A name is required and is trimmed before comparison, because AM stores what
 * we send and " Agent Platform" would read as a second project.
 *
 * Uniqueness inside the parent is NOT checked here. It was a unique index while
 * the retired gear owned projects; now it would take listing every sibling
 * through a cursor-paginated endpoint clamped at 200 rows, which is neither
 * atomic nor complete (ADR-0010). The wizard lets the write happen and reports
 * what AM answers.
 */
export function isNameUsable(name: string): boolean {
  return name.trim().length > 0;
}

