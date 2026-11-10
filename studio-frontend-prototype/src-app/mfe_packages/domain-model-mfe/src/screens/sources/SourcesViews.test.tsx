import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RelatedRequirement } from '../../model/spec-model';

vi.mock('../../i18n', async () => (await import('../common/testText')).i18nMock());

import { AgainstTheCode, Elsewhere, relatedKey, Work } from './SourcesViews';

const pair: RelatedRequirement = {
  id: 'cpt-fr-order',
  text: 'The system places an order.',
  defined_in: { path: 'docs/PRD.md', line_start: 1, line_end: 1, quote: null },
  other_project_id: 'p2',
  other_project_name: 'Shop',
  other_workspace_name: 'Retail',
  other_id: 'cpt-fr-buy',
  other_text: 'A buyer places an order.',
  other_defined_in: { path: 'docs/PRD.md', line_start: 7, line_end: 7, quote: null },
  relation: 'same',
  score: 0.82,
  shared: ['order', 'places'],
} as RelatedRequirement;

describe('Sources views', () => {
  it('Against the code: no repository, nothing to compare', () => {
    render(<AgainstTheCode read={{ repo: null, items: [] }} />);
    expect(screen.getByText('no_code_title')).toBeTruthy();
  });

  it('Work: nothing syncs the work', () => {
    render(
      <Work read={{ items: [], total: 0, identifiers: 0, unlinked: 0, work: 0, synced: false } as never} />
    );
    expect(screen.getByText('no_work_title')).toBeTruthy();
  });

  it('Elsewhere: a match is decided, and decided again withdraws it', () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <Elsewhere read={{ items: [pair], total: 1, projects: 1, truncated: false } as never} onDecide={onDecide} />
    );
    fireEvent.click(screen.getByRole('button', { name: /expand.*cpt-fr-order/ }));
    fireEvent.click(screen.getByRole('button', { name: 'decision_reuse' }));
    expect(onDecide).toHaveBeenCalledWith(pair, 'reuse');
    expect(relatedKey(pair)).toBe('rel:cpt-fr-order|p2|cpt-fr-buy');

    rerender(
      <Elsewhere
        read={{ items: [pair], total: 1, projects: 1, truncated: false } as never}
        onDecide={onDecide}
        decisionOf={() => 'reuse'}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'decision_reuse' }));
    expect(onDecide).toHaveBeenLastCalledWith(pair, 'proposed');
  });
});
