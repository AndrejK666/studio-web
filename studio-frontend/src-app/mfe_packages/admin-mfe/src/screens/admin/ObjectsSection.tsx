/**
 * Admin › Objects — the prototype's `ObjectTypes` (`object-types.tsx`)
 * carried over (ADR-0069): every type the graph holds for this organization,
 * and which of them are components. Tick one and it becomes a component (the
 * Components page lists its nodes); untick it and it leaves. The nodes are
 * untouched either way: a mark is an opinion about a type.
 *
 * The counts come after the list, and a count nothing took stays a dash —
 * never a zero. The list is `ObjectTypesGrid`, on the kit's DataGrid (#1076).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiRegistry } from '@gears-frontx/react';
import { Badge, Card, CardContent } from '@gears-frontx/ui-kit';
import { useOrganization, type OrganizationRef } from '@constructor-studio/mfe-shared';
import { GridFailed } from '@constructor-studio/mfe-shared/grid';
import { AdminApiService } from '../../api/AdminApiService';
import type { CatalogType, TypeCount } from '../../api/types';
import { LENSES, inLens, shortName, titleize, type Lens } from '../../model/objects';
import { ErrorLine, Header, errText, useAdmin } from './common';
import { ObjectTypesGrid } from './ObjectTypesGrid';
import styles from './Admin.module.css';

export function ObjectsSection() {
  const { t } = useAdmin();
  const { org, loading } = useOrganization();
  if (loading) return <p className={styles.muted}>{t('reading')}</p>;
  if (!org) return <p className={styles.muted}>{t('no_org')}</p>;
  return <Objects key={org.id} org={org} />;
}

function Objects({ org }: { org: OrganizationRef }) {
  const { t, language } = useAdmin();
  const api = apiRegistry.getService(AdminApiService);
  const [types, setTypes] = useState<CatalogType[] | null>(null);
  // `gts_id -> title`, from the types-registry: the catalogue of meaning (ADR-0013).
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [objectCounts, setObjectCounts] = useState<Record<string, TypeCount> | null>(null);
  /** Why the types could not be read; a failed toggle is `err`, above the list. */
  const [readError, setReadError] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    api
      .catalogTypes({ orgId: org.id })
      .fetch({ staleTime: 0 })
      .then(
        ({ types: list }) => {
          if (!live) return;
          setTypes(list ?? []);
          setReadError(null);
        },
        (e: unknown) => {
          if (!live) return;
          setReadError(errText(e));
          setTypes([]);
        }
      );
    return () => {
      live = false;
    };
  }, [api, org.id, tick]);

  useEffect(() => {
    let live = true;
    api
      .typeCounts({ orgId: org.id })
      .fetch({ staleTime: 0 })
      .then(
        ({ counts }) => {
          if (!live) return;
          const next: Record<string, TypeCount> = {};
          for (const c of counts ?? []) next[c.leaf_id] = c;
          setObjectCounts(next);
        },
        // A count that cannot be taken leaves the column blank: zero would be a claim nothing checked.
        () => live && setObjectCounts(null)
      );
    return () => {
      live = false;
    };
  }, [api, org.id]);

  useEffect(() => {
    let live = true;
    api.gtsTypeTitles.fetch({ staleTime: 0 }).then(
      ({ entities }) => {
        if (!live) return;
        const next: Record<string, string> = {};
        for (const e of entities ?? []) {
          const title = e.content?.title?.trim();
          if (title) next[e.gts_id] = title;
        }
        setTitles(next);
      },
      // A registry that will not answer costs the names, not the page.
      () => live && setTitles({})
    );
    return () => {
      live = false;
    };
  }, [api]);

  const nameOf = useCallback(
    (ct: CatalogType) => titles[ct.leaf_id] ?? titles[ct.type_id] ?? titleize(shortName(ct.leaf_id)),
    [titles]
  );

  const toggle = useCallback(
    async (ct: CatalogType) => {
      setBusy(ct.leaf_id);
      setErr(null);
      try {
        await api.setTypeComponent(org.id, ct.leaf_id).fetch({ component: !ct.component });
        // The server prunes a mark that agrees with what the tenant inherits: read it back.
        setTick((n) => n + 1);
      } catch (e) {
        setErr(errText(e));
      } finally {
        setBusy(null);
      }
    },
    [api, org.id]
  );
  const onToggle = useCallback((ct: CatalogType) => void toggle(ct), [toggle]);

  const counts = useMemo(() => {
    const all = types ?? [];
    return Object.fromEntries(LENSES.map((l) => [l, all.filter((ct) => inLens(ct, l)).length])) as Record<Lens, number>;
  }, [types]);

  return (
    <>
      <Header
        title={t('objects_title')}
        status={
          types !== null && (
            <>
              <span className={styles.sub}>{t.count('objects_types', counts.all)}</span>
              <Badge variant={counts.components > 0 ? 'success' : 'secondary'}>
                {t.count('objects_components', counts.components)}
              </Badge>
            </>
          )
        }
        info={
          <>
            <p>{t('objects_about')}</p>
            <p>{t('objects_about_counts')}</p>
          </>
        }
      />

      {err && <ErrorLine>{err}</ErrorLine>}

      <Card data-objects>
        <CardContent className={styles.cardBody}>
          {types === null ? (
            <p className={styles.muted}>{t('objects_reading')}</p>
          ) : readError ? (
            <GridFailed message={readError} retry={t('retry')} onRetry={() => setTick((n) => n + 1)} />
          ) : (
            <ObjectTypesGrid
              types={types}
              counts={counts}
              t={t}
              language={language}
              busy={busy}
              objectCounts={objectCounts}
              nameOf={nameOf}
              onToggle={onToggle}
            />
          )}
        </CardContent>
      </Card>
    </>
  );
}
