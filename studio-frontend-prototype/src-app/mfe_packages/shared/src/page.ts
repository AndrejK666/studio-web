/**
 * The frame every project tab draws itself in, and the states of its body: see
 * README, "Project tabs on one frame". Its own entry,
 * `@constructor-studio/mfe-shared/page`, like `grid`: it carries CSS modules,
 * which each MFE's build bundles into its own stylesheet.
 */

export { ProjectPage, type ProjectPageProps } from './page/ProjectPage';
export { PageEmpty, PageError, PageLoading, type PageEmptyProps } from './page/PageStates';
export { KitAbsentState, KITS_ROUTE, kitDisplayName, type KitAbsentStateProps } from './page/KitAbsentState';
