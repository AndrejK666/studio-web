/**
 * A kit's page (ADR-0068 §3, §8; #1099): what it is and what it would do,
 * read at a glance.
 *
 * - The header: its icon, where it is installed and the action this level may
 *   take, and what installing it changes — the tabs that appear, the types
 *   that become active, the ones of Studio's core it adopts.
 * - Where it appears: each level's tab bar with the kit's tabs among the
 *   shell's, and a picture of the screen a tab opens.
 * - What it adds to the model: its types and the types they relate to.
 * - What it lets people and agents do: Inbox sources, MCP tools, and the
 *   permissions by gear and by read or write.
 * - Everything else it brings (rules, functions, services, files, artifact
 *   kinds), and one line for every section it has nothing for.
 */

import React, { useMemo } from 'react';
import { Badge, Button, Skeleton } from '@gears-frontx/ui-kit';
import type { ModelTab, ShellTab } from '@constructor-studio/mfe-shared';
import type { CatalogKit, KitContents, KitDetail, ScreenPreview } from '../../api/KitsApiService';
import {
  emptySections,
  installChanges,
  levelMaps,
  modelGraph,
  type SectionKey,
} from '../../model/kitPage';
import type { KitStatus } from './KitsGrid';
import { KitIcon } from './KitIcon';
import { LevelMap } from './kit/LevelMap';
import { ModelDiagram } from './kit/ModelDiagram';
import { AgentItems, Permissions } from './kit/PeopleAndAgents';
import { ItemsGrid, type ItemRow } from './kit/ItemsGrid';
import type { Text } from './kit/text';
import styles from './HomeScreen.module.css';
import page from './kit/KitPage.module.css';

/** The card's one line: how much of each kind the kit brings. */
export function contentsSummary(c: KitContents, t: Text): string {
  const parts: string[] = [];
  const add = (n: number, key: string) => n > 0 && parts.push(t(key, { count: n }));
  add(c.screens.length, 'sum_screens');
  add(c.types.length, 'sum_types');
  add(c.rules.length + c.functions.length, 'sum_handlers');
  add(c.services.length, 'sum_services');
  add(c.inbox.length, 'sum_inbox');
  add(c.mcp_tools.length, 'sum_tools');
  add(c.material.length, 'sum_material');
  add(c.kinds.length, 'sum_kinds');
  return parts.join(' · ');
}

/** "No rules, services or project files": the sections a kit has nothing for, in one line. */
export function noneLine(empty: readonly SectionKey[], t: Text): string | null {
  if (empty.length === 0) return null;
  const names = empty.map((k) => t(`none_${k}`));
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} ${t('none_or')} ${names[names.length - 1]}`;
  return t('none_line', { list });
}

/** Everything else the kit brings, one row each: rules, functions, services, files, artifact kinds, docs. */
export function moreRows(c: KitContents, t: Text): ItemRow[] {
  const note = (s: string | null | undefined) => s ?? '';
  return [
    ...c.rules.map((r) => ({ id: `rule:${r.name}`, kind: t('rule'), name: r.name, note: note(r.description) })),
    ...c.functions.map((f) => ({
      id: `fn:${f.name}`,
      kind: t('item_function', { runtime: f.runtime }),
      name: f.name,
      note: note(f.description),
    })),
    ...c.services.map((s) => ({ id: `svc:${s.name}`, kind: t('item_service'), name: s.name, note: note(s.description) })),
    ...c.material.map((m) => ({ id: `file:${m.path}`, kind: t('item_file'), name: m.path, note: note(m.description) })),
    ...c.kinds.map((k) => ({ id: `kind:${k}`, kind: t('item_kind'), name: k, note: '' })),
    ...c.docs.map((d) => ({ id: `doc:${d}`, kind: t('item_doc'), name: d, note: '' })),
  ];
}

function Block({ title, hint, id, children }: { title: string; hint: string; id: string; children: React.ReactNode }) {
  return (
    <section className={page.block} aria-labelledby={`kit-block-${id}`} data-kit-block={id}>
      <h4 id={`kit-block-${id}`} className={page.blockTitle}>
        {title}
      </h4>
      <p className={page.blockHint}>{hint}</p>
      {children}
    </section>
  );
}

/** What the page reads beside the kit's contents: the shell's tabs, the model's, and the pictures. */
export interface KitPageContext {
  shellTabs: ShellTab[] | null;
  routes: string[] | null;
  modelTabs: Record<string, ModelTab[]> | null;
  loadPreviews: (component: string) => Promise<ScreenPreview[]>;
}

const NO_CONTEXT: KitPageContext = {
  shellTabs: null,
  routes: null,
  modelTabs: null,
  loadPreviews: () => Promise.resolve([]),
};

function Changes({ contents, installed, t }: { contents: KitContents; installed: boolean; t: Text }) {
  const changes = installChanges(contents);
  if (!changes.tabs.length && !changes.types.length && !changes.adopts.length && !changes.extends.length) return null;
  return (
    <div data-kit-changes>
      <p className={page.blockHint}>{installed ? t('changes_installed') : t('changes_install')}</p>
      <dl className={page.changes}>
        {changes.tabs.length > 0 && (
          <>
            <dt>{t('changes_tabs')}</dt>
            <dd>
              {changes.tabs.map((tab) => (
                <Badge key={`${tab.level}:${tab.label}`} variant="info">
                  {tab.label} · {t(`level_${tab.level}`)}
                </Badge>
              ))}
            </dd>
          </>
        )}
        {changes.types.length > 0 && (
          <>
            <dt>{t('changes_types')}</dt>
            <dd>
              {changes.types.map((name) => (
                <Badge key={name} variant="secondary">
                  {name}
                </Badge>
              ))}
            </dd>
          </>
        )}
        {changes.adopts.length > 0 && (
          <>
            <dt title={t('changes_adopts_hint')}>{t('changes_adopts')}</dt>
            <dd>
              {changes.adopts.map((name) => (
                <Badge key={name} variant="outline">
                  {name}
                </Badge>
              ))}
            </dd>
          </>
        )}
        {changes.extends.length > 0 && (
          <>
            <dt>{t('changes_extends')}</dt>
            <dd>
              {changes.extends.map((name) => (
                <Badge key={name} variant="outline">
                  {name}
                </Badge>
              ))}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

function Contents({ kit, c, context, t }: { kit: CatalogKit; c: KitContents; context: KitPageContext; t: Text }) {
  const levels = useMemo(
    () =>
      levelMaps({
        slug: kit.slug,
        contents: c,
        shellTabs: context.shellTabs,
        routes: context.routes,
        modelTabs: context.modelTabs,
      }),
    [kit.slug, c, context.shellTabs, context.routes, context.modelTabs]
  );
  const graph = useMemo(() => modelGraph(c, kit.slug), [c, kit.slug]);
  const more = useMemo(() => moreRows(c, t), [c, t]);
  const empty = emptySections(c);
  const has = (k: SectionKey) => !empty.includes(k);
  const permissions = c.permissions;
  const others = (['handlers', 'services', 'material', 'kinds'] as const).filter(has);
  const none = noneLine(empty, t);
  return (
    <div className={styles.detail}>
      {has('screens') && (
        <Block id="screens" title={t('sec_screens')} hint={t('sec_screens_hint')}>
          <LevelMap levels={levels} loadPreviews={context.loadPreviews} t={t} />
        </Block>
      )}
      {has('model') && (
        <Block id="model" title={t('sec_types')} hint={t('sec_types_hint')}>
          <ModelDiagram graph={graph} t={t} />
        </Block>
      )}
      {(has('agents') || has('permissions')) && (
        <Block id="agents" title={t('sec_agents')} hint={t('sec_agents_hint')}>
          {has('agents') && <AgentItems contents={c} t={t} />}
          {has('permissions') && (
            <>
              <h5 className={page.gearName} title={t('sec_permissions_hint')}>
                {t('sec_permissions')}
              </h5>
              <Permissions permissions={permissions} t={t} />
            </>
          )}
        </Block>
      )}
      {others.length > 0 && (
        <Block id="more" title={t('sec_more')} hint={t('sec_more_hint')}>
          <ItemsGrid name="kit-more" label={t('sec_more')} rows={more} t={t} />
        </Block>
      )}
      {none && (
        <p className={page.collapsed} data-kit-none>
          {none}
        </p>
      )}
    </div>
  );
}

export function KitDetailView({
  kit,
  detail,
  failed,
  controls,
  onBack,
  t,
  status = 'unknown',
  context = NO_CONTEXT,
}: {
  kit: CatalogKit;
  detail: KitDetail | null;
  /** The detail could not be read: this Studio's backend predates it, or it refused. */
  failed: boolean;
  /** The installer's badges and buttons, as on the card. */
  controls: React.ReactNode;
  onBack: () => void;
  t: Text;
  /** Whether it is installed where the page is open. */
  status?: KitStatus;
  context?: KitPageContext;
}) {
  const c = detail?.contents;
  return (
    <article className={styles.detail} data-kit-detail={kit.slug}>
      <Button variant="ghost" size="sm" onClick={onBack}>
        ← {t('back')}
      </Button>
      <header className={styles.detailHeader}>
        <h3 className={styles.title}>
          <KitIcon kit={kit} />
          {kit.name}
        </h3>
        <p className={styles.description}>{kit.description}</p>
        {controls}
        {c && <Changes contents={c} installed={status === 'base' || status === 'installed'} t={t} />}
        <dl className={styles.facts}>
          <dt>{t('publisher')}</dt>
          <dd>{kit.publisher}</dd>
          <dt>{t('version')}</dt>
          <dd>
            <code>{kit.default_version}</code>
          </dd>
          {kit.repository_url && (
            <>
              <dt>{t('repository')}</dt>
              <dd>
                <a href={kit.repository_url} target="_blank" rel="noreferrer">
                  {kit.repository_url.replace('https://', '')}
                </a>
              </dd>
            </>
          )}
          <dt>{t('described_by')}</dt>
          <dd>{detail?.manifest ?? (detail ? t('described_unknown') : '…')}</dd>
          {detail?.origin && (
            <>
              <dt>{t('origin_from')}</dt>
              <dd data-kit-origin>
                <code>
                  {detail.origin.repository}
                  {detail.origin.path ? `/${detail.origin.path}` : ''}
                </code>{' '}
                {t('origin_ref', { ref: detail.origin.git_ref ?? t('origin_default_branch') })}
              </dd>
              <dt>{t('origin_commit')}</dt>
              <dd>
                <code title={detail.origin.commit}>{detail.origin.commit.slice(0, 12)}</code>
                {' · '}
                {t('origin_added', { at: (detail.origin.refreshed_at ?? detail.origin.added_at).slice(0, 10) })}
              </dd>
            </>
          )}
        </dl>
      </header>

      {failed ? (
        <p className={styles.note}>{t('contents_unavailable')}</p>
      ) : !c ? (
        <Skeleton className={styles.skeletonLine} />
      ) : (
        <Contents kit={kit} c={c} context={context} t={t} />
      )}
    </article>
  );
}
