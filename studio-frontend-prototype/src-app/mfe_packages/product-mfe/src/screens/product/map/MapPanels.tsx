/**
 * The map's side panels and its other view (product-map-view.tsx): the
 * palette that adds screens, gears and infra services; the detail of what is
 * selected — a node's facts, parameters, description file and links, or a
 * link's reason; and product.gdl, the same product as the text the next save
 * writes, its lines tied to the map's nodes.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Button, Input } from '@gears-frontx/ui-kit';
import type { DescriptionOutline, GearConfigSchema, ProjectProduct } from '../../../api/types';
import type { Mfe } from '../../../model/frontend-constructor';
import { offers } from '../../../model/product-configurator';
import {
  catalogueMfe,
  gearConfigOf,
  gearParams,
  linksOf,
  productGdlLines,
  type MapLink,
  type MapNode,
  type NodeParam,
  type ProductMap as Map_,
} from '../../../model/product-map';
import type { ProductSectionId, infrastructureOf } from '../../../model/product-sections';
import type { DeployEnvironment } from '../../../api/types';
import { useMapTranslations } from '../../../i18n';
import { errText, Segmented, useProductApi, useScope } from '../../common';
import type { Catalogue } from '../catalogue';
import { InfraLane } from './InfraLane';
import { useKeptCheck, type KeptCheck } from '../keptCheck';
import { DRAG_GEAR, DRAG_MFE, hueOf, kindWord, stateWord } from './words';
import styles from './ProductMap.module.css';

const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ');

/* ── The palette ── */

export function Palette({
  mfes,
  product,
  catalogue,
  infra,
  environments,
  busy,
  onAddScreen,
  onAddGear,
}: {
  mfes: Mfe[];
  product: ProjectProduct | null;
  catalogue: Catalogue;
  infra: ReturnType<typeof infrastructureOf>['needs'];
  environments: DeployEnvironment[];
  busy: boolean;
  onAddScreen: (m: Mfe) => void;
  onAddGear: (name: string) => void;
}) {
  const { t } = useMapTranslations();
  const [tab, setTab] = useState<'screens' | 'gears' | 'infrastructure'>('screens');
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const mounted = product?.frontend?.mfes ?? [];
  const screens = mfes.filter(
    (m) =>
      !mounted.some((p) => catalogueMfe(p, [m])) &&
      (!q || `${m.name} ${m.description} ${m.calls.join(' ')}`.toLowerCase().includes(q))
  );
  const have = [...(product?.gears ?? []), ...(product?.last_preview?.gears ?? [])];
  const gearOffers = catalogue && 'index' in catalogue ? offers(catalogue.index, have, query) : null;

  return (
    <aside className={styles.palette} aria-label={t('palette_label')} data-pmap-palette>
      <Segmented
        label={t('palette')}
        value={tab}
        onChange={setTab}
        dataAttr="data-pmap-palette-tab"
        items={[
          { id: 'screens', label: t('palette_screens') },
          { id: 'gears', label: t('palette_gears') },
          { id: 'infrastructure', label: t('palette_infra') },
        ]}
      />
      {tab !== 'infrastructure' && (
        <Input
          type="search"
          placeholder={tab === 'screens' ? t('find_screen') : t('find_gear')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      {tab === 'screens' && (
        <div className={styles.paletteList}>
          <p className={cx(styles.muted, styles.hint)}>{t('screens_hint')}</p>
          {screens.length === 0 && <p className={styles.muted}>{mfes.length === 0 ? t('no_mfes') : t('nothing_to_mount')}</p>}
          {screens.map((m) => (
            <div
              key={m.name}
              className={styles.item}
              draggable={!busy}
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_MFE, m.name);
                e.dataTransfer.effectAllowed = 'copy';
              }}
              data-pmap-offer-screen={m.name}
            >
              <div className={styles.grow}>
                <div className={styles.itemName}>{m.name.replace(/^@[^/]+\//, '')}</div>
                <div className={styles.itemSub}>
                  {m.calls.length > 0 ? t('calls_list', { gears: m.calls.join(', ') }) : m.description || t('calls_none')}
                </div>
              </div>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAddScreen(m)}>
                {t('add')}
              </Button>
            </div>
          ))}
        </div>
      )}
      {tab === 'gears' && (
        <div className={styles.paletteList}>
          <p className={cx(styles.muted, styles.hint)}>{t('gears_hint')}</p>
          {!catalogue && <p className={styles.muted}>{t('reading_catalogue')}</p>}
          {catalogue && 'error' in catalogue && <p className={styles.error}>{t('catalogue_failed', { error: catalogue.error })}</p>}
          {gearOffers?.length === 0 && <p className={styles.muted}>{q ? t('nothing_more_matches') : t('nothing_more')}</p>}
          {gearOffers?.map((g) => (
            <div key={g.category}>
              {/* In its subsystem's hue, as its column on the map. */}
              <div className={styles.itemGroup} style={{ '--g-h': hueOf(g.category) } as CSSProperties}>
                {g.category}
              </div>
              {g.items.map((o) => (
                <div
                  key={o.name}
                  className={styles.item}
                  style={{ '--g-h': hueOf(g.category) } as CSSProperties}
                  draggable={!busy}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_GEAR, o.name);
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  title={o.description ?? undefined}
                  data-pmap-offer-gear={o.name}
                >
                  <div className={styles.grow}>
                    <div className={styles.itemName}>
                      <span className={styles.glyph} aria-hidden>
                        ⚙
                      </span>
                      {o.label}
                    </div>
                    {o.description && <div className={styles.itemSub}>{o.description}</div>}
                  </div>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAddGear(o.name)}>
                    {t('add')}
                  </Button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {tab === 'infrastructure' && (
        <div className={styles.paletteList}>
          {/* Deployable infra services (ADR-0064): each need of the gears met
              by a catalogue service, with its image or chart source. */}
          <InfraLane needs={infra} environments={environments} />
        </div>
      )}
    </aside>
  );
}

/* ── The detail panel ── */

/** What a node's Parameters say: a gear's or plugin's configuration -- the
 *  product's, over the saved product.gdl's -- read against its config schema;
 *  anything else's as the map drew them. `note` is a key of the words. */
export type Params = { list: NodeParam[]; note: { key: string; revision?: number } | null; revision: number | null };

export function paramsOf(
  n: MapNode,
  product: ProjectProduct | null,
  described: ReadonlyMap<string, Record<string, unknown>>,
  schemas: ReadonlyMap<string, GearConfigSchema> | null,
  revision: number | null
): Params {
  const d = n.detail;
  if ((d.kind !== 'gear' && d.kind !== 'plugin') || !d.gear) return { list: d.params ?? [], note: null, revision: null };
  const config = gearConfigOf(d.gear, product?.config as Record<string, Record<string, unknown>> | undefined, described);
  const schema = schemas?.get(d.gear);
  const list = gearParams(d.gear, schema, config);
  return {
    list,
    revision,
    note: !schemas
      ? { key: 'params_reading' }
      : !schema?.id
        ? { key: 'params_undescribed' }
        : list.length === 0
          ? { key: 'params_none' }
          : null,
  };
}

/** A node's parameters, as a list of fields: a secret only as set. */
function ParamList({ params }: { params: Params }) {
  const { t } = useMapTranslations();
  const [open, setOpen] = useState(true);
  const from = params.revision !== null && params.note?.key !== 'params_none' ? t('params_revision', { revision: String(params.revision) }) : '';
  const note = [params.note ? t(params.note.key) : '', from].filter(Boolean).join(' ');
  if (params.list.length === 0 && !note) return null;
  return (
    <>
      <button
        type="button"
        className={cx(styles.detailKind, styles.linklike)}
        aria-expanded={open}
        aria-controls="pmap-params"
        onClick={() => setOpen((o) => !o)}
        data-pmap-params-toggle
      >
        {open ? '▾' : '▸'} {t('params', { count: String(params.list.length) })}
      </button>
      {open && (
        <div id="pmap-params" data-pmap-params>
          {note && <p className={cx(styles.muted, styles.small)}>{note}</p>}
          {params.list.length > 0 && (
            <dl className={styles.params}>
              {params.list.map((p) => (
                <div key={p.key} className={cx(styles.param, p.missing && styles.missing)} data-pmap-param={p.key}>
                  <dt>
                    <code>{p.key}</code>
                  </dt>
                  <dd title={p.full}>
                    {p.secret ? <span className={styles.secret}>{p.value}</span> : p.value}
                    {p.note && <span className={styles.muted}> · {p.note}</span>}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </>
  );
}

/** Which description file says a node: a gear's or a plugin's `gear.gdl`, a
 *  micro-frontend's or the shell's `frontx.gdl`. */
export function gdlOf(node: MapNode): { gear: string } | { path: string } | null {
  const d = node.detail;
  if ((d.kind === 'gear' || d.kind === 'plugin') && (d.gear ?? node.label)) return { gear: d.gear ?? node.label };
  if (d.kind === 'mfe' && d.path) return { path: `${d.path.replace(/\/$/, '')}/frontx.gdl` };
  if (d.kind === 'shell') {
    const at = d.params?.find((p) => p.key === 'path')?.value;
    return { path: at ? `${at.replace(/^\.?\/?/, '').replace(/\/$/, '')}/frontx.gdl`.replace(/^\//, '') : 'frontx.gdl' };
  }
  return null;
}

/** A node's description file, read when asked: what the engine reads it
 *  from, in the repository the server checked out. */
function GdlSection({ what }: { what: { gear: string } | { path: string } }) {
  const { projectId } = useScope();
  const productApi = useProductApi();
  const { t } = useMapTranslations();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<{ source: string; path: string; text: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const name = 'gear' in what ? 'gear.gdl' : (what.path.split('/').pop() ?? what.path);
  // The ask by value: the node's detail makes a new object each render.
  const ask = JSON.stringify(what);
  useEffect(() => {
    if (!open || file || err) return;
    let live = true;
    productApi.gdlFile(projectId, JSON.parse(ask) as { gear: string } | { path: string }).then(
      (f) => live && setFile(f),
      (e: unknown) => live && setErr(errText(e))
    );
    return () => {
      live = false;
    };
  }, [open, file, err, projectId, ask, productApi]);
  return (
    <div data-pmap-gdl-file={name}>
      <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} {name}
      </Button>
      {open && !file && !err && <p className={styles.muted}>{t('gdl_reading', { name })}</p>}
      {err && <p className={styles.muted}>{t('gdl_failed', { name, error: err })}</p>}
      {file && (
        <>
          <div className={cx(styles.muted, styles.small)}>
            {file.source}/{file.path}
          </div>
          <pre className={styles.pre}>{file.text}</pre>
        </>
      )}
    </div>
  );
}

const SECTION_KEY: Record<'frontend' | 'backend' | 'infrastructure', string> = {
  frontend: 'open_in_frontend',
  backend: 'open_in_backend',
  infrastructure: 'open_in_infrastructure',
};

export function Detail({
  map,
  node,
  params,
  link,
  nodeById,
  product,
  busy,
  view,
  onSelect,
  onLink,
  onSection,
  onShowMap,
  onAddGear,
  onRemoveGear,
  onRemoveScreen,
}: {
  map: Map_;
  node: MapNode | null;
  params: Params | null;
  link: MapLink | null;
  nodeById: Map<string, MapNode>;
  product: ProjectProduct | null;
  busy: boolean;
  view: 'map' | 'gdl';
  onSelect: (id: string | null) => void;
  onLink: (l: MapLink) => void;
  onSection: (id: ProductSectionId) => void;
  onShowMap: () => void;
  onAddGear: (name: string) => void;
  onRemoveGear: (name: string) => void;
  onRemoveScreen: (path: string) => void;
}) {
  const { t } = useMapTranslations();
  const name = (id: string) => nodeById.get(id)?.label ?? id;
  if (link) {
    return (
      <aside className={styles.detail} id="pmap-detail" data-pmap-detail="link">
        <div className={styles.detailKind}>{t('link_kind', { kind: link.kind })}</div>
        <p className={link.state === 'bad' ? styles.error : undefined}>{link.why}</p>
        <div className={styles.row}>
          <Button size="sm" variant="ghost" onClick={() => onSelect(link.from)}>
            {name(link.from)}
          </Button>
          <span>→</span>
          <Button size="sm" variant="ghost" onClick={() => onSelect(link.to)}>
            {name(link.to)}
          </Button>
        </div>
      </aside>
    );
  }
  if (!node) {
    return (
      <aside className={styles.detail} id="pmap-detail" data-pmap-detail="none">
        <div className={styles.detailKind}>{t('detail_title')}</div>
        <p className={styles.muted}>{t('detail_hint')}</p>
        <ul className={styles.legend}>
          <li>
            <span className={cx(styles.swatch, styles.missing)} /> {t('legend_missing')}
          </li>
          <li>
            <span className={cx(styles.swatch, styles.bad)} /> {t('legend_bad')}
          </li>
          <li>
            <span className={cx(styles.swatch, styles.unused)} /> {t('legend_unused')}
          </li>
        </ul>
      </aside>
    );
  }
  const d = node.detail;
  const its = linksOf(map, node.id);
  const lacks = d.kind === 'mfe' ? its.filter((l) => l.state === 'bad' && l.from === node.id).map((l) => nodeById.get(l.to)) : [];
  const gdl = gdlOf(node);
  return (
    <aside className={styles.detail} id="pmap-detail" data-pmap-detail={node.id}>
      <div className={styles.detailKind}>
        {kindWord(t, d.kind)}
        {node.state !== 'ok' && <span className={styles.nodeState}> · {stateWord(t, node.state)}</span>}
      </div>
      <h3 className={styles.detailTitle}>{node.label}</h3>
      <p>{d.what}</p>
      {d.problem && <p className={styles.error}>{d.problem}</p>}
      <ul className={styles.facts}>
        {d.facts.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      {params && <ParamList key={`params:${node.id}`} params={params} />}
      {gdl && <GdlSection key={`gdl:${node.id}`} what={gdl} />}
      {its.length > 0 && (
        <>
          <div className={styles.detailKind}>{t('links', { count: String(its.length) })}</div>
          <ul className={styles.facts}>
            {its.map((l, i) => (
              <li key={i}>
                <button type="button" className={cx(styles.linklike, l.state === 'bad' && styles.error)} onClick={() => onLink(l)} title={l.why}>
                  {l.from === node.id ? `→ ${name(l.to)}` : `← ${name(l.from)}`}
                </button>{' '}
                <span className={styles.muted}>{l.kind}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className={styles.row}>
        {lacks.map((g) =>
          g?.detail.gear ? (
            <Button key={g.id} size="sm" disabled={busy} onClick={() => onAddGear(g.detail.gear!)} data-pmap-add-gear={g.detail.gear}>
              {t('add_named', { name: g.label })}
            </Button>
          ) : null
        )}
        {d.kind === 'missing-gear' && d.gear && (
          <Button size="sm" disabled={busy} onClick={() => onAddGear(d.gear!)} data-pmap-add-gear={d.gear}>
            {t('add_named', { name: node.label })}
          </Button>
        )}
        {(d.kind === 'gear' || d.kind === 'plugin') && d.picked && d.gear && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onRemoveGear(d.gear!)} data-pmap-remove-gear={d.gear}>
            {t('remove_from_product')}
          </Button>
        )}
        {(d.kind === 'gear' || d.kind === 'plugin') && !d.picked && <span className={styles.muted}>{t('pulled_in')}</span>}
        {d.kind === 'mfe' && d.path && product?.frontend && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onRemoveScreen(d.path!)}>
            {t('remove_from_product')}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => onSection(d.section)}>
          {t(SECTION_KEY[d.section])}
        </Button>
        {view === 'gdl' && (
          <Button size="sm" variant="ghost" onClick={onShowMap}>
            {t('show_on_map')}
          </Button>
        )}
      </div>
    </aside>
  );
}

/* ── product.gdl: the map's other view ── */

/**
 * The saved product.gdl -- the revision Studio keeps -- with the engine's
 * verdict on it as the server kept it, and when it was made. Opening it runs
 * nothing: a check is queued on the server only when the kept verdict is about
 * another text (`useKeptCheck`), or on Check now. Which lines say which node
 * is the server's reading of the text (`POST product-description-outlines`);
 * `productGdlLines` keeps the map's nodes of it.
 */
export function GdlView({
  product,
  profile,
  description,
  nodeIds,
  selected,
  onSelect,
}: {
  product: ProjectProduct | null;
  /** The profile the verdict is for. */
  profile: string;
  /** The saved revision, as the map read it; `null` when there is none. */
  description: { revision: number; text: string; sha256: string } | null;
  nodeIds: string[];
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { projectId } = useScope();
  const { t } = useMapTranslations();
  const kept = useMemo(
    () => (description ? { revision: description.revision, sha256: description.sha256 } : null),
    [description]
  );
  const verdict = useKeptCheck(projectId, product, profile, kept);
  return (
    <GdlText
      key={`${projectId}|${description?.revision ?? ''}`}
      projectId={projectId}
      text={description?.text ?? ''}
      revision={description?.revision ?? null}
      verdict={verdict}
      nodeIds={nodeIds}
      selected={selected}
      onSelect={onSelect}
      t={t}
    />
  );
}

/** When a verdict was made, as a person reads it. */
function whenText(at: string | undefined): string {
  if (!at) return '';
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : d.toLocaleString();
}

/** Keyed by the revision: another revision is another text, from nothing. */
function GdlText({
  projectId,
  text,
  revision,
  verdict,
  nodeIds,
  selected,
  onSelect,
  t,
}: {
  projectId: string;
  text: string;
  revision: number | null;
  verdict: KeptCheck;
  nodeIds: string[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  t: ReturnType<typeof useMapTranslations>['t'];
}) {
  const productApi = useProductApi();
  const box = useRef<HTMLDivElement | null>(null);
  const draft = useMemo(() => (text ? { text } : null), [text]);

  // The server says which lines are which node; until it answers, no line is tied.
  const [outline, setOutline] = useState<DescriptionOutline['lines'] | null>(null);
  useEffect(() => {
    if (!draft?.text) return;
    let live = true;
    productApi
      .outlineProductDescription(projectId, { text: draft.text })
      .then((o) => live && setOutline(o.lines))
      .catch(() => live && setOutline([]));
    return () => {
      live = false;
    };
  }, [projectId, draft, productApi]);
  const lines = useMemo(() => (outline ? productGdlLines(outline, nodeIds) : null), [outline, nodeIds]);
  const rows = useMemo((): { kind: 'same' | 'add' | 'del'; text: string; n: number | null }[] => {
    if (!draft) return [];
    return draft.text
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line, i) => ({ kind: 'same', text: line, n: i + 1 }));
  }, [draft]);
  const mine = useMemo(() => (selected ? (lines?.byNode.get(selected) ?? []) : []), [selected, lines]);

  useEffect(() => {
    const el = box.current;
    if (!el || mine.length === 0) return;
    const row = el.querySelector<HTMLElement>(`[data-gdl-line="${mine[0]}"]`);
    if (row) el.scrollTop = Math.max(0, row.offsetTop - el.clientHeight / 3);
  }, [mine]);

  const { check, run, current, checking, stillChecking, error, start } = verdict;
  const said = check
    ? check.ok
      ? t('gdl_verdict_ok')
      : t.count('gdl_verdict_errors', check.errors)
    : t('gdl_verdict_none');
  const head = (
    <div className={styles.gdlHead} data-pmap-gdl-verdict={check ? (current ? 'current' : 'other') : 'none'}>
      {revision !== null ? t('gdl_saved', { revision: String(revision) }) : t('gdl_nothing_saved')}{' '}
      <span data-pmap-gdl-check={check ? (check.ok ? 'ok' : 'failed') : 'none'}>{said}</span>{' '}
      {check?.checked_at && (
        <span className={styles.muted}>{t('gdl_checked_at', { when: whenText(check.checked_at) })} </span>
      )}
      {check && !current && <span className={styles.muted}>{t('gdl_verdict_other')} </span>}
      {checking && <span className={styles.muted} data-pmap-gdl-checking>{t('gdl_checking')} </span>}
      {stillChecking && <span className={styles.muted}>{t('gdl_still_checking')} </span>}
      {!checking && run?.state === 'failed' && run.error && (
        <span className={styles.error}>{t('gdl_check_failed', { error: run.error })} </span>
      )}
      {error && <span className={styles.error}>{error} </span>}
      {revision !== null && (
        <Button size="sm" variant="ghost" disabled={checking} onClick={start} data-pmap-gdl-check-now>
          {t('gdl_check_now')}
        </Button>
      )}{' '}
      <span className={styles.muted}>{t('gdl_click')}</span>
    </div>
  );
  if (!draft) return <div className={styles.gdl} data-pmap-gdl="none">{head}</div>;
  return (
    <div className={styles.gdl} data-pmap-gdl="kept" data-project={projectId}>
      {head}
      <div className={styles.gdlBox} ref={box}>
        {rows.map((r, i) => {
          const owner = r.n !== null ? lines?.byLine.get(r.n) : undefined;
          const on = r.n !== null && mine.includes(r.n);
          return (
            <div
              key={i}
              className={cx(
                styles.gdlLine,
                r.kind === 'add' && styles.gdlAdd,
                r.kind === 'del' && styles.gdlDel,
                owner && styles.owned,
                on && styles.on
              )}
              data-gdl-line={r.n ?? undefined}
              onClick={owner ? () => onSelect(owner) : undefined}
              title={owner ? t('gdl_select', { name: owner.replace(/^[a-z]+:/, '') }) : undefined}
            >
              <span className={styles.gdlMark}>{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ''}</span>
              <span className={styles.gdlN}>{r.n ?? ''}</span>
              <span className={styles.gdlText}>{r.text || ' '}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
