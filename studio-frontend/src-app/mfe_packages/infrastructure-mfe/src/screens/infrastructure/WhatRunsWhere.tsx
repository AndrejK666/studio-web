/**
 * What runs where (ADR-0056 §2): the deploys waiting for an administrator's
 * decision, with Approve and Decline, and a grid of projects by
 * environments — per cell what runs and, beside it, the newest deploy when
 * that is not what runs. The prototype's "What runs where" tab of
 * OrgInfrastructure (environments-screen.tsx at 00828880).
 */

import { useState } from 'react';
import { Button, Card, CardContent, Input } from '@gears-frontx/ui-kit';
import type { DeployEnvironment, Deployment } from '../../api/types';
import type { ProjectRuns } from '../../model/releases';
import { DeploymentLine, errText, useApi, useInfra, type PeopleNames } from './parts';
import { RunsWhereGrid } from './RunsWhereGrid';
import styles from './InfrastructureScreen.module.css';

export function WhatRunsWhere({
  waiting,
  ladder,
  rows,
  mayManage,
  people,
  onDecided,
}: {
  waiting: Deployment[];
  ladder: DeployEnvironment[];
  /** `null` while the environments are read. */
  rows: ProjectRuns[] | null;
  mayManage: boolean;
  people: PeopleNames;
  /** A decision was made: what it said, and the page reads its deploys again. */
  onDecided: (notice: string) => void;
}) {
  const { t, org } = useInfra();
  const api = useApi();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [declining, setDeclining] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const decide = async (d: Deployment, action: 'approve' | 'decline') => {
    setBusy(d.id);
    setError(null);
    try {
      await api
        .decideDeployment(org.id, d.id)
        .fetch(action === 'approve' ? { action } : { action, reason: reason.trim() });
      if (action === 'decline') {
        setDeclining(null);
        setReason('');
      }
      onDecided(
        action === 'approve'
          ? t('approved_notice', { product: d.product, environment: d.environment_name })
          : t('declined_notice', { product: d.product, environment: d.environment_name })
      );
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={styles.stack} data-what-runs-where>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {waiting.length > 0 && (
        <Card data-deploys-awaiting>
          <CardContent className={styles.cardBody}>
            <h3 className={styles.formTitle}>{t('waiting_title')}</h3>
            <ul className={styles.list}>
              {waiting.map((d) => (
                <li key={d.id} data-deploy-awaiting={d.id}>
                  <DeploymentLine d={d} showProject people={people} />
                  {mayManage ? (
                    <div className={styles.actions}>
                      <Button
                        size="sm"
                        disabled={busy === d.id}
                        data-deploy-approve
                        onClick={() => void decide(d, 'approve')}
                      >
                        {t('approve')}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy === d.id}
                        onClick={() => setDeclining(declining === d.id ? null : d.id)}
                        data-deploy-decline-open
                      >
                        {t('decline_open')}
                      </Button>
                      {declining === d.id && (
                        <>
                          <Input
                            className={styles.grow}
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            placeholder={t('decline_reason_placeholder')}
                            aria-label={t('decline_reason')}
                          />
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={busy === d.id || !reason.trim()}
                            onClick={() => void decide(d, 'decline')}
                            data-deploy-decline
                          >
                            {t('decline')}
                          </Button>
                        </>
                      )}
                    </div>
                  ) : (
                    <p className={styles.hint}>{t('admin_decides')}</p>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      <Card data-runs-where>
        <CardContent className={styles.cardBody}>
          {rows === null ? (
            <p className={styles.hint}>{t('loading')}</p>
          ) : (
            <RunsWhereGrid rows={rows} ladder={ladder} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
