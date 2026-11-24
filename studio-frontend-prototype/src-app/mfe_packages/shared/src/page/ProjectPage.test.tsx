import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ProjectPage } from './ProjectPage';
import { PageEmpty, PageError, PageLoading } from './PageStates';

afterEach(cleanup);

describe('ProjectPage', () => {
  it('draws the title as the tab heading, its chips, actions and body', () => {
    render(
      <ProjectPage title="Tests" chips={<span>mainline red</span>} actions={<button>Sync</button>} section="tests">
        <p>rows</p>
      </ProjectPage>,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Tests' })).toBeTruthy();
    expect(screen.getByText('mainline red')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sync' })).toBeTruthy();
    expect(screen.getByText('rows').parentElement?.getAttribute('data-section')).toBe('tests');
  });

  it('keeps the paragraph about the tab behind the "?"', async () => {
    render(<ProjectPage title="Tests" help={<p>What the project built works.</p>} helpLabel="About Tests" />);
    expect(screen.queryByText('What the project built works.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'About Tests' }));
    expect(await screen.findByText('What the project built works.')).toBeTruthy();
  });

  it('holds the title, chips and actions back while busy', () => {
    render(<ProjectPage title="Tests" busy chips={<span>chip</span>} actions={<button>Sync</button>} />);
    expect(screen.queryByText('Tests')).toBeNull();
    expect(screen.queryByText('chip')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sync' })).toBeNull();
  });
});

describe('page states', () => {
  it('says it is loading to a screen reader', () => {
    render(<PageLoading label="Loading…" />);
    expect(screen.getByRole('status').textContent).toBe('Loading…');
  });

  it('shows the empty state with its note and actions', () => {
    render(<PageEmpty title="No tests yet" note="Connect CI" actions={<button>Connect</button>} />);
    expect(screen.getByText('No tests yet')).toBeTruthy();
    expect(screen.getByText('Connect CI')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy();
  });

  it('retries a failed read', () => {
    const retry = vi.fn();
    render(<PageError message="Could not read" retry="Retry" onRetry={retry} />);
    expect(screen.getByRole('alert').textContent).toBe('Could not read');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
