import { eventBus } from '@gears-frontx/react';
import type { TypeDecisionRequest, TypesConfirmRequest } from '../events/specsEvents';
import '../events/specsEvents';

/** A person's decision on a repository file's type, from the Type menu (#690). */
export function requestTypeDecision(request: TypeDecisionRequest): void {
  eventBus.emit('mfe/projects/type-decision-requested', request);
}

/** A person accepts the proposed types of many rows at once, from the Specs header. */
export function requestTypesConfirm(request: TypesConfirmRequest): void {
  eventBus.emit('mfe/projects/types-confirm-requested', request);
}
