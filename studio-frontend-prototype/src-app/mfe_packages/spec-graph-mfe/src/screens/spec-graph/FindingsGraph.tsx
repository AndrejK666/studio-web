/**
 * The findings on the graph: each finding stored in the project's graph, linked to the documents
 * it cites (sections folded into their documents), laid out as islands and coloured by rule
 * family; the legend filters the families. Used as Graph › Findings and on Quality, where a rule
 * chosen in the table keeps only its findings.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { apiRegistry } from '@gears-frontx/react';
import { Skeleton } from '@gears-frontx/ui-kit';
import { refusalText } from '@constructor-studio/mfe-shared';
import { SpecGraphApiService } from '../../api/SpecGraphApiService';
import type { Picture } from '../../api/types';
import { findingsPicture } from '../../model/picture';
import { useSpecGraphTranslations } from '../../i18n';
import { GraphCanvas } from './GraphCanvas';
import styles from './SpecGraphScreen.module.css';

type Text = ReturnType<typeof useSpecGraphTranslations>['t'];

const message = (e: unknown) => refusalText(e) ?? (e instanceof Error ? e.message : String(e));

export const FindingsGraph: React.FC<{
  projectId: string;
  /** Only this rule's findings; every rule's when absent. */
  rule?: string | null;
  onOpen?: (key: string) => void;
  t: Text;
}> = ({ projectId, rule = null, onOpen, t }) => {
  const api = apiRegistry.getService(SpecGraphApiService);
  const [all, setAll] = useState<Picture | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api
      .overview({ projectId, types: 'finding,section,document' })
      .fetch({ staleTime: 0 })
      .then((r) => live && setAll(r.answer))
      .catch((e: unknown) => live && setError(message(e)));
    return () => {
      live = false;
    };
  }, [api, projectId]);
  const picture = useMemo(() => (all ? findingsPicture(all, rule) : null), [all, rule]);

  if (error) return <p className={styles.error}>{error}</p>;
  if (!picture) return <Skeleton className={styles.skeleton} />;
  if (!picture.nodes.some((n) => n.type === 'finding'))
    return <p className={styles.muted}>{t('findings_graph_empty')}</p>;
  return (
    <GraphCanvas picture={picture} layout="islands" colouring="finding" onOpen={onOpen ?? (() => undefined)} t={t} />
  );
};
