/**
 * The icons the portal draws with no request at all: every `lucide:<name>` a
 * built-in screen's `mfe.json` names (`bundledIcons.test.ts` fails the build of
 * one that names another), the built-in kit catalogue's (studio-backend
 * `kit_registry/builtin`), and the header's own.
 *
 * Imported one by one, so the shell carries these glyphs and nothing else of
 * lucide (~0.3 kB each minified). Before this the header drew through
 * `@iconify/react`, which asked api.iconify.design (then api.unisvg.com) for
 * every glyph on every cold load; the tabs and menus loaded lucide's whole name
 * map and one chunk per glyph after the first paint. A name outside this set
 * still draws for a kit installed at run time — through `lucide-react/dynamic`,
 * a chunk of our own origin (`ManifestIcon`) — never through a third party.
 */

import {
  Activity,
  Atom,
  Book,
  BookOpen,
  Boxes,
  Building2,
  CalendarDays,
  ChartColumn,
  CircleDashed,
  CircleDot,
  CircleUserRound,
  Coins,
  Component,
  Contact,
  FileCode,
  FileText,
  Files,
  FlaskConical,
  Folder,
  FolderTree,
  Frame,
  GitPullRequest,
  Globe,
  History,
  House,
  Inbox,
  KeyRound,
  Layers,
  LayoutDashboard,
  LayoutGrid,
  List,
  Network,
  Package,
  Palette,
  Plug,
  Plus,
  Rocket,
  Route,
  Scale,
  ScanSearch,
  Search,
  Server,
  Settings,
  Shapes,
  Shield,
  Sparkles,
  TableProperties,
  TriangleAlert,
  User,
  Users,
  Wallet,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

const LUCIDE_PREFIX = 'lucide:';

/** By lucide's own (kebab-case) name, as a manifest writes it after `lucide:`. */
export const BUNDLED_ICONS: Readonly<Record<string, LucideIcon>> = {
  activity: Activity,
  atom: Atom,
  book: Book,
  'book-open': BookOpen,
  boxes: Boxes,
  'building-2': Building2,
  'calendar-days': CalendarDays,
  'chart-column': ChartColumn,
  'circle-dot': CircleDot,
  'circle-user-round': CircleUserRound,
  coins: Coins,
  component: Component,
  contact: Contact,
  'file-code': FileCode,
  'file-text': FileText,
  files: Files,
  'flask-conical': FlaskConical,
  folder: Folder,
  'folder-tree': FolderTree,
  frame: Frame,
  'git-pull-request': GitPullRequest,
  globe: Globe,
  history: History,
  // lucide renamed it; the catalogue still says `home`.
  home: House,
  house: House,
  inbox: Inbox,
  'key-round': KeyRound,
  layers: Layers,
  'layout-dashboard': LayoutDashboard,
  'layout-grid': LayoutGrid,
  list: List,
  network: Network,
  package: Package,
  palette: Palette,
  plug: Plug,
  plus: Plus,
  rocket: Rocket,
  route: Route,
  scale: Scale,
  'scan-search': ScanSearch,
  search: Search,
  server: Server,
  settings: Settings,
  shapes: Shapes,
  shield: Shield,
  sparkles: Sparkles,
  'table-properties': TableProperties,
  'triangle-alert': TriangleAlert,
  user: User,
  users: Users,
  wallet: Wallet,
  workflow: Workflow,
};

/** What a slot that must show a glyph draws for a name it does not have: neutral, and local. */
export const FALLBACK_ICON: LucideIcon = CircleDashed;

/** The bare lucide name `declared` names (`lucide:users` → `users`), or `undefined`. */
export function lucideNameOf(declared: string | null | undefined): string | undefined {
  if (!declared?.startsWith(LUCIDE_PREFIX)) return undefined;
  return declared.slice(LUCIDE_PREFIX.length) || undefined;
}

/** The bundled glyph `declared` names, or `undefined` when it is not one of ours. */
export function bundledIcon(declared: string | null | undefined): LucideIcon | undefined {
  const name = lucideNameOf(declared);
  return name !== undefined && Object.prototype.hasOwnProperty.call(BUNDLED_ICONS, name) ? BUNDLED_ICONS[name] : undefined;
}
