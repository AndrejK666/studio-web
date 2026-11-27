/**
 * A component's page, drawn the way a kit's page is (#1099): the header says
 * what it is — its type glyph and word, state, version, owner, where it lives,
 * its passport and documents — then one block per question, each with a
 * count and an empty one said to be empty:
 *
 * - What it provides: capabilities, extension points and plugins (or the
 *   point a plugin fills and its hosts), MCP tools, types, contracts, ports;
 *   for an MFE its screens with the pictures a build took of them;
 * - What it needs: catalogued dependencies, the gears and services it calls,
 *   databases, runtime, connections;
 * - Where it is used: the projects declaring it, the projects and products
 *   using it, the components depending on it, the kits claiming it;
 * - Lifecycle: its state and the decision it needs, versions and downloads,
 *   the registry's history and moves (`lifecycle`, the registry's own panel);
 * - Quality: maturity and readiness.
 *
 * Everything is the catalogue's answer (`GET /components/{name}`) and the
 * registry entry; the field profile (`profile`) is its own tab.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Skeleton, Tabs, TabsList, TabsTrigger } from '@gears-frontx/ui-kit';
import {
  ComponentTypeIcon,
  loadScreenPreviews,
  pictureFor,
  type ComponentType,
  type ScreenPreview,
} from '@constructor-studio/mfe-shared';
import type { CatalogNode, ComponentDetail, ComponentScreen, RegistryEntry } from '../../api/types';
import { detailType, neededItems, providedItems, usedItems, type PageItem } from '../../model/component-page';
import { STATE_LABEL, STATE_TONE, ownerLabel, publishStatus } from '../../model/registry';
import { api, errText, statusOf, useScope, type Text } from './common';
import { TypeBadge } from './ComponentCards';
import { OutLink, StatusChip, toneOf } from './parts';
import styles from './ComponentView.module.css';

type Detail = { state: 'loading' } | { state: 'ready'; detail: ComponentDetail } | { state: 'none' } | { state: 'failed'; why: string };

/** The catalogue's page of `name`: none when it does not know it (404). */
function useDetail(org: string | null, name: string): Detail {
  const [read, setRead] = useState<{ key: string; detail: Detail } | null>(null);
  const key = `${org ?? ''}:${name}`;
  useEffect(() => {
    let live = true;
    api()
      .componentDetail({ org, name })
      .fetch({ staleTime: 0 })
      .then((detail) => {
        if (live) setRead({ key, detail: { state: 'ready', detail } });
      })
      .catch((e: unknown) => {
        if (live) setRead({ key, detail: statusOf(e) === 404 ? { state: 'none' } : { state: 'failed', why: errText(e) } });
      });
    return () => {
      live = false;
    };
  }, [org, name, key]);
  return read && read.key === key ? read.detail : { state: 'loading' };
}

function Block({
  id,
  title,
  hint,
  count,
  empty,
  unknown,
  wide,
  children,
}: {
  id: string;
  title: string;
  hint: string;
  count: number | null;
  /** Said when `count` is 0. */
  empty: string;
  /** Said when `count` is null: nothing was read for it (none while still reading). */
  unknown?: string;
  wide?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <section className={`${styles.block} ${wide ? styles.blockWide : ''}`} aria-labelledby={`component-block-${id}`} data-component-block={id}>
      <div className={styles.blockHead}>
        <h2 id={`component-block-${id}`} className={styles.blockTitle}>
          {title}
        </h2>
        {count !== null && (
          <span className={styles.blockCount} data-block-count={count}>
            {count}
          </span>
        )}
      </div>
      <p className={styles.blockHint}>{hint}</p>
      {count === null ? (
        // Nothing read for it: not "none", but not known.
        unknown ? <p className={styles.empty} data-block-unknown>{unknown}</p> : null
      ) : count === 0 ? (
        <p className={styles.empty} data-block-empty>
          {empty}
        </p>
      ) : (
        children
      )}
    </section>
  );
}

/** A section's items, each with what it is. */
function Items({ items, t }: { items: PageItem[]; t: Text }) {
  return (
    <dl className={styles.items}>
      {items.map((i, n) => (
        <React.Fragment key={`${i.kind}:${i.name}:${n}`}>
          <dt>{t(i.kind)}</dt>
          <dd>
            <code className={styles.mono} data-item={i.name}>
              {i.name}
            </code>
            {i.note && <span className={styles.note}>{i.note}</span>}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

/** An MFE's screens, each with the newest build's picture of it. */
function Screens({ component, screens, t }: { component: string; screens: ComponentScreen[]; t: Text }) {
  const { org } = useScope();
  const orgId = org?.id ?? null;
  const [pictures, setPictures] = useState<ScreenPreview[] | 'loading'>('loading');
  useEffect(() => {
    let live = true;
    void loadScreenPreviews(component, () =>
      api()
        .screenPreviews({ org: orgId, component })
        .fetch({ staleTime: 0 })
        .then((r) => r?.items ?? [])
    ).then((items) => {
      if (live) setPictures(items);
    });
    return () => {
      live = false;
    };
  }, [component, orgId]);
  return (
    <ul className={styles.screens} data-component-screens>
      {screens.map((s) => {
        const label = s.label ?? s.id;
        const picture = pictures === 'loading' ? null : pictureFor(pictures, { route: s.route ?? null, label });
        return (
          <li key={s.id}>
            <figure className={styles.screen} data-screen={label} data-preview={picture ? 'picture' : pictures === 'loading' ? 'loading' : 'none'}>
              {picture ? (
                <img src={picture.image} alt={t('screen_picture_alt', { label })} loading="lazy" />
              ) : (
                <div className={styles.placeholder}>{pictures === 'loading' ? t('screen_picture_loading') : t('screen_no_picture')}</div>
              )}
              <figcaption className={styles.caption}>
                <b>{label}</b>
                {s.route && (
                  <>
                    {' · '}
                    <code className={styles.mono}>{s.route}</code>
                  </>
                )}
                {s.level && ` · ${t(`level_${s.level}`)}`}
              </figcaption>
            </figure>
          </li>
        );
      })}
    </ul>
  );
}

export interface ComponentViewProps {
  name: string;
  /** The catalogue node, when the catalogue holds it. */
  node?: CatalogNode;
  /** The registry entry, when a project declares it. */
  entry?: RegistryEntry;
  /** The type the list showed, until the page's answer arrives. */
  type: ComponentType;
  onBack: () => void;
  /** The registry's own panel: the history and the moves the state allows. */
  lifecycle?: React.ReactNode;
  /** The field profile (Filled / Empty / Sources), when the catalogue holds one. */
  profile?: React.ReactNode;
}

export function ComponentView({ name, node, entry, type: listType, onBack, lifecycle, profile }: ComponentViewProps) {
  const { org, t } = useScope();
  const read = useDetail(org?.id ?? null, name);
  const detail = read.state === 'ready' ? read.detail : null;
  const type = detailType(detail, listType);
  const [tab, setTab] = useState<'overview' | 'profile'>('overview');

  const provided = useMemo(() => (detail ? providedItems(detail) : []), [detail]);
  const needed = useMemo(() => (detail ? neededItems(detail) : []), [detail]);
  const used = useMemo(() => usedItems(detail, entry), [detail, entry]);
  const screens = detail?.provides.screens ?? [];
  const unknown = read.state === 'loading' ? undefined : t('sec_unknown');

  const state = entry?.state ?? (node ? 'published' : null);
  const published = entry ? publishStatus(entry) : null;
  const version =
    detail?.version ?? (node ? String(node.value.max_stable_version ?? node.value.newest_version ?? '') || null : null) ?? entry?.version ?? null;
  const repository = detail?.repository ?? (node?.value.repository ? String(node.value.repository) : null);
  const owner = ownerLabel(entry?.owner ?? null) ?? (node?.value.keywords?.[0] ? String(node.value.keywords[0]) : null);
  const description = detail?.description ?? (node?.value.description ? String(node.value.description) : null) ?? entry?.description ?? null;
  const decisions = entry?.decisions ?? [];
  const downloads = node?.value.downloads != null ? Number(node.value.downloads) : null;
  const versions = node?.value.num_versions != null ? Number(node.value.num_versions) : null;
  const quality = [
    detail?.maturity ? { kind: 'item_maturity', name: detail.maturity } : null,
    detail?.readiness?.stage ? { kind: 'item_stage', name: detail.readiness.stage } : null,
    detail?.readiness?.lifecycle ? { kind: 'item_lifecycle', name: detail.readiness.lifecycle } : null,
    detail?.readiness?.grade ? { kind: 'item_grade', name: detail.readiness.grade, note: (detail.readiness.grade_fixes ?? []).join(' · ') } : null,
    ...(detail?.readiness?.progress ?? []).map((p) => ({ kind: 'item_progress', name: `${p.label}: ${p.value}` })),
  ].filter((x): x is PageItem => x !== null);
  const lifecycleFacts = [
    state ? 1 : 0,
    version ? 1 : 0,
    versions !== null ? 1 : 0,
    downloads !== null ? 1 : 0,
    decisions.length,
  ].reduce((a, b) => a + b, 0);

  return (
    <article className={styles.page} data-component-view={name} data-component-type={type}>
      <div>
        <Button variant="ghost" size="sm" onClick={onBack} data-component-back>
          ← {t('back_to_list')}
        </Button>
      </div>
      <header className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>
          <ComponentTypeIcon type={type} className={styles.pageIcon} size={24} />
          {detail?.title ?? name}
          <TypeBadge type={type} t={t} reason={detail?.type_reason} hosts={detail?.provides.hosts} large />
          {state && (
            <StatusChip tone={STATE_TONE[state] !== undefined ? toneOf(STATE_TONE[state]) : state === 'published' ? 'ok' : 'neutral'} data-component-state={state}>
              {STATE_LABEL[state] ?? state}
            </StatusChip>
          )}
          {published && <StatusChip tone={published.kind === 'published' ? 'ok' : 'info'}>{published.label}</StatusChip>}
        </h1>
        {description && <p className={styles.description}>{description}</p>}
        <dl className={styles.facts}>
          {detail?.title && (
            <>
              <dt>{t('fact_name')}</dt>
              <dd>
                <code className={styles.mono}>{name}</code>
              </dd>
            </>
          )}
          <dt>{t('fact_type')}</dt>
          <dd data-component-type-reason>{detail?.type_reason ?? (read.state === 'loading' ? t('type_from_list') : t('type_from_list_only'))}</dd>
          <dt>{t('fact_version')}</dt>
          <dd>{version ? <code className={styles.mono}>{version}</code> : <span className={styles.muted}>{t('not_known')}</span>}</dd>
          <dt>{t('fact_owner')}</dt>
          <dd>{owner ?? <span className={styles.muted}>{t('nobody_yet')}</span>}</dd>
          {(detail?.category ?? entry?.category) && (
            <>
              <dt>{t('category')}</dt>
              <dd>{detail?.category ?? entry?.category}</dd>
            </>
          )}
          {detail?.tier && (
            <>
              <dt>{t('fact_tier')}</dt>
              <dd>{t(`tier_${detail.tier}`)}</dd>
            </>
          )}
          <dt>{t('repository')}</dt>
          <dd>
            {repository ? (
              <OutLink href={repository}>{repository.replace(/^https?:\/\/(www\.)?/, '')}</OutLink>
            ) : (
              <span className={styles.muted}>{t('not_known')}</span>
            )}
            {detail?.path && <code className={styles.mono}>{detail.path}</code>}
          </dd>
          <dt>{t('fact_passport')}</dt>
          <dd data-component-passport={detail?.passport?.label ?? ''}>
            {detail?.passport ? (
              detail.passport.url ? (
                <OutLink href={detail.passport.url} title={detail.passport.path}>
                  {detail.passport.label}
                </OutLink>
              ) : (
                <code className={styles.mono} title={detail.passport.path}>
                  {detail.passport.path}
                </code>
              )
            ) : (
              <span className={styles.muted}>{t('no_passport')}</span>
            )}
          </dd>
          <dt>{t('fact_docs')}</dt>
          <dd>
            {detail && detail.docs.length > 0 ? (
              detail.docs.map((d) =>
                d.url ? (
                  <OutLink key={d.path} href={d.url} title={d.path}>
                    {d.label}
                  </OutLink>
                ) : (
                  <code key={d.path} className={styles.mono}>
                    {d.path}
                  </code>
                )
              )
            ) : (
              <span className={styles.muted}>{t('no_docs')}</span>
            )}
          </dd>
        </dl>
      </header>

      {profile && (
        <Tabs value={tab} onValueChange={(v) => setTab(v as 'overview' | 'profile')}>
          <TabsList variant="line" aria-label={t('view')}>
            <TabsTrigger value="overview">{t('tab_overview')}</TabsTrigger>
            <TabsTrigger value="profile">{t('tab_profile')}</TabsTrigger>
          </TabsList>
        </Tabs>
      )}

      {tab === 'profile' && profile ? (
        profile
      ) : (
        <>
          {read.state === 'loading' && <Skeleton className={styles.placeholder} />}
          {read.state === 'none' && (
            <p className={styles.blockHint} data-component-detail="none">
              {t('detail_none')}
            </p>
          )}
          {read.state === 'failed' && (
            <p className={styles.blockHint} data-component-detail="failed">
              {t('detail_failed', { why: read.why })}
            </p>
          )}
          <div className={styles.blocks}>
            {screens.length > 0 && (
              <Block id="screens" wide title={t('sec_screens')} hint={t('sec_screens_hint')} count={screens.length} empty="">
                <Screens component={name} screens={screens} t={t} />
              </Block>
            )}
            <Block
              id="provides"
              title={t('sec_provides')}
              hint={t('sec_provides_hint')}
              count={detail ? provided.length + screens.length : null}
              empty={t('sec_provides_empty')} unknown={unknown}
            >
              {provided.length > 0 ? <Items items={provided} t={t} /> : <p className={styles.empty}>{t('sec_provides_screens_only')}</p>}
            </Block>
            <Block id="needs" title={t('sec_needs')} hint={t('sec_needs_hint')} count={detail ? needed.length : null} empty={t('sec_needs_empty')} unknown={unknown}>
              <Items items={needed} t={t} />
            </Block>
            <Block
              id="used"
              title={t('sec_used')}
              hint={t('sec_used_hint')}
              count={detail || entry ? used.length : null}
              empty={t('sec_used_empty')} unknown={unknown}
            >
              <Items items={used} t={t} />
            </Block>
            <Block id="quality" title={t('sec_quality')} hint={t('sec_quality_hint')} count={detail ? quality.length : null} empty={t('sec_quality_empty')} unknown={unknown}>
              <Items items={quality} t={t} />
            </Block>
            <Block id="lifecycle" wide title={t('sec_lifecycle')} hint={t('sec_lifecycle_hint')} count={lifecycleFacts} empty={t('sec_lifecycle_empty')}>
              <dl className={styles.facts}>
                {state && (
                  <>
                    <dt>{t('col_state')}</dt>
                    <dd>
                      {STATE_LABEL[state] ?? state}
                      {state === 'candidate' && <Badge variant="warning">{t('needs_decision_badge')}</Badge>}
                    </dd>
                  </>
                )}
                {version && (
                  <>
                    <dt>{t('fact_version')}</dt>
                    <dd>
                      <code className={styles.mono}>{version}</code>
                    </dd>
                  </>
                )}
                {versions !== null && (
                  <>
                    <dt>{t('fact_versions')}</dt>
                    <dd>{versions}</dd>
                  </>
                )}
                {downloads !== null && (
                  <>
                    <dt>{t('col_downloads')}</dt>
                    <dd>{downloads.toLocaleString('en-US')}</dd>
                  </>
                )}
                {decisions.length > 0 && (
                  <>
                    <dt>{t('fact_decisions')}</dt>
                    <dd>{t.count('n_decisions', decisions.length)}</dd>
                  </>
                )}
              </dl>
              {lifecycle}
            </Block>
          </div>
        </>
      )}
    </article>
  );
}
