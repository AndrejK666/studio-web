/** Sends a person's decision on a repository file's type (#690), or on many at once. */

import {
  apiRegistry,
  eventBus,
  invalidateQueryCacheForApp,
  type AppDispatch,
  type FrontXApp,
} from '@gears-frontx/react';
import { refusalFrom } from '@constructor-studio/mfe-shared';
import { DocumentsApiService } from '../api/DocumentsApiService';
import { decisionSettled, decisionStarted } from '../slices/typeDecisionSlice';
import { confirmOutcome } from '../model/specsConfirm';
import '../events/specsEvents';

export function initTypeDecisionEffects(dispatch: AppDispatch, app: FrontXApp): void {
  eventBus.on('mfe/projects/type-decision-requested', (request) => {
    const { projectId, workspaceId, bindingId, name, decision } = request;
    const documents = apiRegistry.getService(DocumentsApiService);
    dispatch(decisionStarted(bindingId));
    void documents
      .decideBinding({ workspaceId, bindingId })
      .fetch(decision)
      .then(
        () => {
          // A confirmation changes the Sources section's Specs counts.
          void invalidateQueryCacheForApp(app, documents.specsPerSource({ scope: projectId }));
          eventBus.emit('mfe/projects/specs-changed', { projectId });
        },
        (error: unknown) => {
          eventBus.emit('mfe/projects/type-decision-refused', {
            projectId,
            name,
            refusal: refusalFrom(error, 'type_refused'),
          });
        }
      )
      .finally(() => dispatch(decisionSettled(bindingId)));
  });

  // Bulk *Confirm*: one call for every target, each row pending until it settles.
  eventBus.on('mfe/projects/types-confirm-requested', (request) => {
    const { projectId, targets } = request;
    if (targets.length === 0) return;
    const documents = apiRegistry.getService(DocumentsApiService);
    targets.forEach((target) => dispatch(decisionStarted(target.id)));
    void documents
      .confirmTypes()
      .fetch({ project_id: projectId, binding_ids: targets.map((target) => target.id) })
      .then(
        (result) => {
          eventBus.emit('mfe/projects/types-confirmed', {
            projectId,
            outcome: confirmOutcome(targets, result),
          });
          if (result.confirmed.length === 0) return;
          // Confirmed documents change the Sources section's Specs counts, and the
          // list: their types settle and the domain model reads them.
          void invalidateQueryCacheForApp(app, documents.specsPerSource({ scope: projectId }));
          eventBus.emit('mfe/projects/specs-changed', { projectId });
        },
        (error: unknown) => {
          eventBus.emit('mfe/projects/types-confirmed', {
            projectId,
            outcome: { kind: 'refused', refusal: refusalFrom(error, 'confirm_refused') },
          });
        }
      )
      .finally(() => targets.forEach((target) => dispatch(decisionSettled(target.id))));
  });
}
