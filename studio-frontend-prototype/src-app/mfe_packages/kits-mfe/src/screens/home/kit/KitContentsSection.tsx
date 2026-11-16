/**
 * A kit's Contents: its files and what it is made of, every list with its count.
 *
 * - The kit's GDL: `kit.gdl` shown as text and downloaded, marked "rendered from …" when the
 *   server wrote it from another manifest; the source manifest as written; and an archive of
 *   everything (`.tar.gz`: manifest, model, claims, working material, bundles).
 * - The types inside, each with its GTS id, whether it is new or an existing type it adopts
 *   (ADR-0070), and its fields.
 * - The MCP tools it claims, with their descriptions; the write routes it claims, the reads it
 *   needs and the gears it relies on (ADR-0071 §2).
 * - Its Inbox sources, rules and functions.
 */

import React, { useState } from 'react';
import { Badge, Button } from '@gears-frontx/ui-kit';
import type { KitDetail } from '../../../api/KitsApiService';
import { fetchKitBlob, fetchKitText, kitFileUrl, saveBlob, type KitFile } from '../../../api/kitFiles';
import { archiveName, gdlName, gearsOf, readsOf, writeRoutes, type Route } from '../../../model/kitContents';
import type { Text } from './text';
import page from './KitPage.module.css';

/** How the section reads and saves a kit's files; the real ones by default. */
export interface KitFileIo {
  text: (url: string) => Promise<string>;
  blob: (url: string) => Promise<Blob>;
  save: (blob: Blob, name: string) => void;
}

const REAL_IO: KitFileIo = { text: fetchKitText, blob: fetchKitBlob, save: saveBlob };

/** A titled list with its count; an empty one says so. */
function List({
  id,
  title,
  count,
  t,
  children,
}: {
  id: string;
  title: string;
  count: number;
  t: Text;
  children: React.ReactNode;
}) {
  return (
    <section className={page.list} data-kit-list={id} aria-labelledby={`kit-list-${id}`}>
      <h5 id={`kit-list-${id}`} className={page.listTitle}>
        {title}
        <span className={page.count} data-kit-count>
          {count}
        </span>
      </h5>
      {count === 0 ? <p className={page.collapsed}>{t('contents_none')}</p> : <ul className={page.items}>{children}</ul>}
    </section>
  );
}

function RouteItem({ route }: { route: Route }) {
  return (
    <li>
      {route.method && <Badge variant="outline">{route.method}</Badge>}
      <code className={page.mono}>{route.path}</code>
    </li>
  );
}

/** Which file is shown as text, and what it said. */
type Shown = { file: 'kit.gdl' | 'manifest'; text: string | null; error: string | null };

export function KitContentsSection({
  detail,
  organizationId,
  t,
  io = REAL_IO,
}: {
  detail: KitDetail;
  /** The organization an organization's own kit is read in. */
  organizationId?: string | null;
  t: Text;
  io?: KitFileIo;
}) {
  const { kit, contents: c } = detail;
  // An organization's own kit is only found in its organization.
  const org = kit.shelf === 'organization' ? organizationId : null;
  const url = (file: KitFile) => kitFileUrl(kit.slug, file, org);
  const [shown, setShown] = useState<Shown | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<KitFile | null>(null);
  const source = detail.source_manifest ?? null;
  const renderedFrom = detail.gdl_rendered_from ?? null;

  const show = (file: 'kit.gdl' | 'manifest') => {
    if (shown?.file === file) {
      setShown(null);
      return;
    }
    setShown({ file, text: null, error: null });
    io.text(url(file)).then(
      (text) => setShown((now) => (now?.file === file ? { file, text, error: null } : now)),
      (e: unknown) => setShown((now) => (now?.file === file ? { file, text: null, error: String(e) } : now))
    );
  };

  const download = (file: KitFile, name: string) => {
    setBusy(file);
    setProblem(null);
    io.blob(url(file)).then(
      (blob) => {
        io.save(blob, name);
        setBusy(null);
      },
      (e: unknown) => {
        setProblem(t('contents_download_failed', { error: e instanceof Error ? e.message : String(e) }));
        setBusy(null);
      }
    );
  };

  const writes = writeRoutes(c);
  const reads = readsOf(c);
  const gears = gearsOf(c);
  return (
    <div className={page.columns} data-kit-contents>
      <section className={page.list} data-kit-files aria-label={t('contents_files')}>
        <h5 className={page.listTitle}>{t('contents_files')}</h5>
        <div className={page.files}>
          <Button
            size="sm"
            variant="outline"
            aria-expanded={shown?.file === 'kit.gdl'}
            onClick={() => show('kit.gdl')}
            data-kit-file="kit.gdl"
          >
            kit.gdl
          </Button>
          <Button size="sm" variant="ghost" disabled={busy === 'kit.gdl'} onClick={() => download('kit.gdl', gdlName(kit.slug))}>
            {t('contents_download')}
          </Button>
          {source && source !== 'kit.gdl' && (
            <>
              <Button
                size="sm"
                variant="outline"
                aria-expanded={shown?.file === 'manifest'}
                onClick={() => show('manifest')}
                data-kit-file="manifest"
              >
                {source}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy === 'manifest'} onClick={() => download('manifest', source)}>
                {t('contents_download')}
              </Button>
            </>
          )}
          <Button
            size="sm"
            disabled={busy === 'archive'}
            onClick={() => download('archive', archiveName(kit))}
            data-kit-archive
          >
            {busy === 'archive' ? t('contents_archive_busy') : t('contents_archive')}
          </Button>
        </div>
        <p className={page.collapsed} data-kit-gdl-from>
          {renderedFrom ? t('contents_gdl_rendered', { from: renderedFrom }) : t('contents_gdl_authored')}
        </p>
        {problem && (
          <p role="alert" className={page.note}>
            {problem}
          </p>
        )}
        {shown && (
          <div data-kit-file-text={shown.file}>
            {shown.error ? (
              <p role="alert" className={page.note}>
                {t('contents_read_failed', { error: shown.error })}
              </p>
            ) : shown.text === null ? (
              <p className={page.collapsed}>{t('contents_reading')}</p>
            ) : (
              <pre className={page.fileText} tabIndex={0}>
                {shown.text}
              </pre>
            )}
          </div>
        )}
      </section>

      <List id="types" title={t('contents_types')} count={c.types.length} t={t}>
        {c.types.map((type) => (
          <li key={type.gts} data-kit-type={type.id ?? type.gts}>
            <strong>{type.name}</strong>
            <Badge variant={type.adopts ? 'outline' : 'secondary'}>
              {type.adopts ? t('contents_type_existing') : t('contents_type_new')}
            </Badge>
            <code className={page.mono}>{type.gts}</code>
            <span className={page.note}>
              {(type.fields ?? []).length === 0
                ? t('contents_no_fields')
                : (type.fields ?? []).map((f) => `${f.name}${f.required ? '*' : ''}: ${f.type}`).join(', ')}
            </span>
          </li>
        ))}
      </List>

      <List id="tools" title={t('contents_tools')} count={c.mcp_tools.length} t={t}>
        {c.mcp_tools.map((tool) => (
          <li key={tool.name}>
            <code className={page.mono}>{tool.name}</code>
            {tool.description && <span className={page.note}>{tool.description}</span>}
          </li>
        ))}
      </List>

      <List id="writes" title={t('contents_writes')} count={writes.length} t={t}>
        {writes.map((r) => (
          <RouteItem key={`${r.method} ${r.path}`} route={r} />
        ))}
      </List>

      <List id="reads" title={t('contents_reads')} count={reads.length} t={t}>
        {reads.map((r) => (
          <RouteItem key={`${r.method} ${r.path}`} route={r} />
        ))}
      </List>

      <List id="gears" title={t('contents_gears')} count={gears.length} t={t}>
        {gears.map((g) => (
          <li key={g.gear} data-kit-gear-use={g.gear}>
            <code className={page.mono}>{g.gear}</code>
            {g.claims && <Badge variant="secondary">{t('contents_gear_claims')}</Badge>}
            {g.calls && <Badge variant="outline">{t('contents_gear_calls')}</Badge>}
            {g.types.length > 0 && <span className={page.note}>{g.types.join(', ')}</span>}
          </li>
        ))}
      </List>

      <List id="inbox" title={t('contents_inbox')} count={c.inbox.length} t={t}>
        {c.inbox.map((i) => (
          <li key={i.id}>
            <code className={page.mono}>{i.id}</code>
            <span className={page.note}>{i.label}</span>
          </li>
        ))}
      </List>

      <List id="rules" title={t('contents_rules')} count={c.rules.length} t={t}>
        {c.rules.map((r) => (
          <li key={r.name}>
            <code className={page.mono}>{r.name}</code>
            {r.description && <span className={page.note}>{r.description}</span>}
          </li>
        ))}
      </List>

      <List id="functions" title={t('contents_functions')} count={c.functions.length} t={t}>
        {c.functions.map((f) => (
          <li key={f.name}>
            <code className={page.mono}>{f.name}</code>
            <Badge variant="outline">{f.runtime}</Badge>
            {f.description && <span className={page.note}>{f.description}</span>}
          </li>
        ))}
      </List>
    </div>
  );
}
