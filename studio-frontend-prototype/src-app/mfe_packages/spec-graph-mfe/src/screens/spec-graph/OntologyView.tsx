/**
 * Project › Spec graph › Ontology: what the spec graph is built of. Each node
 * type with what it stands for and how many the project's graph holds, each
 * edge type with what it connects and whether the documents state it or a
 * judge concluded it, and how keys are formed. This is the kit's own model of
 * a project's documents; Studio's Project domain model is another thing.
 */

import React, { useMemo, useState } from 'react';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@gears-frontx/ui-kit';
import type { Ontology } from '../../api/types';
import { useSpecGraphTranslations } from '../../i18n';
import { lookOf } from '../../model/look';
import { ontologyPicture } from '../../model/picture';
import { GraphCanvas } from './GraphCanvas';
import styles from './SpecGraphScreen.module.css';

type Text = ReturnType<typeof useSpecGraphTranslations>['t'];

export const OntologyView: React.FC<{ ontology: Ontology; t: Text }> = ({ ontology, t }) => {
  const [as, setAs] = useState<'table' | 'graph'>('table');
  const picture = useMemo(() => ontologyPicture(ontology), [ontology]);
  const toggle = (
    <div className={styles.modes} role="group" aria-label={t('ontology_as')}>
      <Button size="sm" variant={as === 'table' ? undefined : 'outline'} onClick={() => setAs('table')}>
        {t('ontology_as_table')}
      </Button>
      <Button size="sm" variant={as === 'graph' ? undefined : 'outline'} onClick={() => setAs('graph')}>
        {t('ontology_as_graph')}
      </Button>
    </div>
  );
  if (as === 'graph') {
    return (
      <>
        {toggle}
        <p className={styles.muted}>{t('ontology_graph_hint')}</p>
        <GraphCanvas
          picture={picture}
          layout="around"
          colouring="type"
          onOpen={() => undefined}
          labelAll
          clickHint={null}
          t={t}
        />
      </>
    );
  }
  const counts = ontology.counts ?? {};
  const nodeTypes = Object.keys(ontology.nodes).sort(
    (a, b) => (counts[b] ?? 0) - (counts[a] ?? 0) || a.localeCompare(b),
  );
  const extra = Object.keys(counts).filter((k) => !(k in ontology.nodes));
  return (
    <>
      {toggle}
      <Card className={styles.document}>
        <CardHeader>
          <CardTitle>{t('ontology_nodes')}</CardTitle>
        </CardHeader>
        <CardContent>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{t('ontology_type')}</th>
                <th>{t('ontology_count')}</th>
                <th>{t('ontology_meaning')}</th>
              </tr>
            </thead>
            <tbody>
              {[...nodeTypes, ...extra].map((type) => (
                <tr key={type}>
                  <td>
                    <span className={styles.legendItem}>
                      <svg width={12} height={12} viewBox="-6 -6 12 12" aria-hidden>
                        <circle r={5} fill={lookOf(type).colour} />
                      </svg>
                      <code>{type}</code>
                    </span>
                  </td>
                  <td>{counts[type] ?? 0}</td>
                  <td>{ontology.nodes[type] ?? t('ontology_unlisted')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
      <Card className={styles.document}>
        <CardHeader>
          <CardTitle>{t('ontology_edges')}</CardTitle>
        </CardHeader>
        <CardContent>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{t('ontology_type')}</th>
                <th>{t('ontology_connects')}</th>
                <th>{t('ontology_kind')}</th>
                <th>{t('ontology_meaning')}</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(ontology.edges)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([name, e]) => (
                  <tr key={name}>
                    <td>
                      <code>{name}</code>
                    </td>
                    <td>
                      {e.from.join(', ')} → {e.to.join(', ')}
                    </td>
                    <td>
                      <Badge variant={e.kind.startsWith('analysis') ? 'info' : 'outline'}>
                        {e.kind.startsWith('analysis') ? t('ontology_judged') : t('ontology_static')}
                      </Badge>
                    </td>
                    <td>{e.description}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
      {ontology.keys && <p className={styles.muted}>{ontology.keys}</p>}
    </>
  );
};
