/**
 * The pictures a build took of micro-frontend screens
 * (`scripts/mfe-screen-previews.mjs`), as every screen that shows one reads
 * them: a kit's page (#1099) and the product map's screen cards.
 *
 * Two places keep them, read in this order:
 *
 * 1. the components catalogue (`GET /studio-components-catalog/v1/screen-previews`),
 *    where a build uploads them for the organization — the caller reads it
 *    with its own API service and hands the answer in;
 * 2. the portal itself: the portal's build takes a picture of each of its own
 *    screens into `dist/screen-previews/` (`npm run build:previews`), served
 *    beside the shell at {@link BUILT_PREVIEWS_INDEX}. A component the
 *    catalogue keeps no picture of shows these; they do not depend on a
 *    stand's database, so a reset stand does not lose them.
 *
 * Either way a picture is the newest build's, by route, else by label.
 */

/** One picture a build took of a micro-frontend screen. */
export interface ScreenPreview {
  component: string;
  version: string | null;
  commit: string;
  route: string;
  label: string | null;
  order: number;
  /** `data:image/webp;base64,...` from the catalogue, or a path the portal serves (`/screen-previews/<file>`). */
  image: string;
  width: number | null;
  height: number | null;
  captured_at: string;
}

/** Where the portal serves its own build's pictures: an index and one file per screen beside it. */
export const BUILT_PREVIEWS_DIR = '/screen-previews/';
export const BUILT_PREVIEWS_INDEX = `${BUILT_PREVIEWS_DIR}index.json`;

/** Whether a picture can be shown: an image `data:` URL, or a file the portal serves. */
export function isPicture(p: Pick<ScreenPreview, 'image'>): boolean {
  return p.image.startsWith('data:image/') || p.image.startsWith(BUILT_PREVIEWS_DIR);
}

/**
 * The newest build's pictures, in the build's order. `items` come the newest
 * build first, as the catalogue answers them; a picture of an older build is
 * not taken when the newest has none of a screen.
 */
export function newestBuild(items: readonly ScreenPreview[] | null | undefined): ScreenPreview[] {
  const usable = (items ?? []).filter(isPicture);
  const newest = usable[0]?.commit;
  if (!newest) return [];
  return usable.filter((p) => p.commit === newest).sort((a, b) => a.order - b.order || a.route.localeCompare(b.route));
}

/** The newest build's picture of a screen: by route, else by label. */
export function pictureFor(
  items: readonly ScreenPreview[] | null | undefined,
  place: { route: string | null; label: string }
): ScreenPreview | null {
  const build = newestBuild(items);
  if (place.route) {
    const byRoute = build.find((p) => p.route === place.route);
    if (byRoute) return byRoute;
  }
  const label = place.label.trim().toLowerCase();
  return build.find((p) => p.label?.trim().toLowerCase() === label) ?? null;
}

/**
 * The portal build's pictures of one component, out of its index
 * (`scripts/mfe-screen-previews.mjs` writes it): each entry names its file,
 * which the portal serves under {@link BUILT_PREVIEWS_DIR}. Anything that is
 * not such an entry is left out.
 */
export function builtPreviewsOf(index: unknown, component: string): ScreenPreview[] {
  if (!Array.isArray(index)) return [];
  const out: ScreenPreview[] = [];
  for (const raw of index as unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue;
    const e = raw as Record<string, unknown>;
    if (e.component !== component || typeof e.route !== 'string' || typeof e.file !== 'string' || typeof e.commit !== 'string')
      continue;
    // A file name, never a path out of the folder.
    if (!/^[\w.-]+$/.test(e.file)) continue;
    out.push({
      component,
      version: typeof e.version === 'string' ? e.version : null,
      commit: e.commit,
      route: e.route,
      label: typeof e.label === 'string' ? e.label : null,
      order: typeof e.order === 'number' ? e.order : 0,
      image: `${BUILT_PREVIEWS_DIR}${e.file}`,
      width: typeof e.width === 'number' ? e.width : null,
      height: typeof e.height === 'number' ? e.height : null,
      captured_at: typeof e.captured_at === 'string' ? e.captured_at : '',
    });
  }
  return out;
}

let builtIndex: Promise<unknown> | null = null;

/** The portal's index of its build's pictures, read once per page; none when it serves none. */
function readBuiltIndex(): Promise<unknown> {
  if (!builtIndex) {
    builtIndex =
      typeof fetch === 'function'
        ? fetch(BUILT_PREVIEWS_INDEX, { headers: { accept: 'application/json' } }).then(
            (r) => {
              if (r.ok && (r.headers.get('content-type') ?? '').includes('json')) return r.json();
              // A portal without pictures answers with its index.html: drop the body unread, or
              // the response stays open for the rest of the page's life.
              void r.body?.cancel().catch(() => undefined);
              return [];
            },
            () => []
          )
        : Promise.resolve([]);
  }
  return builtIndex;
}

/** Forget the index read (tests; a page that knows the portal was rebuilt). */
export function forgetBuiltPreviews(): void {
  builtIndex = null;
}

/**
 * A component's pictures: the catalogue's when it keeps any that can be
 * shown, else the portal build's own. `readCatalogue` is the caller's
 * catalogue read; its failure counts as none.
 */
export async function loadScreenPreviews(
  component: string,
  readCatalogue: () => Promise<readonly ScreenPreview[]>,
  readIndex: () => Promise<unknown> = readBuiltIndex
): Promise<ScreenPreview[]> {
  const kept = await readCatalogue().then(
    (items) => [...items],
    (): ScreenPreview[] => []
  );
  if (kept.some(isPicture)) return kept;
  return builtPreviewsOf(await readIndex().catch(() => []), component);
}
