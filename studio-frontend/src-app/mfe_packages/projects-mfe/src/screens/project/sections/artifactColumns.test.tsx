import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ArtifactRow } from '../../../model/artifact';
import {
  ARTIFACT_CELLS,
  ArtifactCellsProvider,
  ArtifactRowMenu,
  type ArtifactColumnLabels,
  type ArtifactOpen,
} from './artifactColumns';

/**
 * What a row offers depends on its kind: a file opens in the editor, anything
 * else opens on the forge. The rule is `opensInEditor`; this checks the cells
 * follow it, with the same `onOpen` for the name and the menu item.
 */

const LABELS: ArtifactColumnLabels = {
  name: 'Name',
  repository: 'Repository',
  path: 'Path',
  sync: 'Sync',
  updated: 'Updated',
  ingested: 'Ingested',
  provenance: {},
  actions: (name) => `Actions for ${name}`,
  open: 'Open',
  openInEditor: 'Open in editor',
  copyLink: 'Copy link',
  none: 'None',
};

const FILE: ArtifactRow = {
  id: 'file-1',
  kind: 'file',
  name: 'README.md',
  repository: 'group/repo',
  path: 'docs/README.md',
  url: null,
  sync: 'ingested',
  updatedAt: null,
  provenance: 'tree',
};

const ISSUE: ArtifactRow = {
  ...FILE,
  id: 'issue-1',
  kind: 'issue',
  name: '#12 Broken link',
  path: 'issues/12',
  url: 'https://forge.example/group/repo/-/issues/12',
  provenance: null,
};

function cell(Component: React.FC<{ item: ArtifactRow }>, row: ArtifactRow, onOpen?: ArtifactOpen) {
  return (
    <ArtifactCellsProvider value={{ labels: LABELS, formatRelative: () => '', onOpen }}>
      <Component item={row} />
    </ArtifactCellsProvider>
  );
}

describe('artifact name cell', () => {
  it('is a button for a file, and hands the row to onOpen', () => {
    const onOpen = vi.fn();
    render(cell(ARTIFACT_CELLS.name, FILE, onOpen));

    const button = screen.getByRole('button', { name: 'README.md' });
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledWith(FILE, 'name');
    // Native button: reachable by Tab, Enter and Space for free.
    expect(button.tagName).toBe('BUTTON');
  });

  it('stays text for an issue — its home is the forge', () => {
    render(cell(ARTIFACT_CELLS.name, ISSUE, vi.fn()));
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('#12 Broken link')).toBeTruthy();
  });

  it('stays text when nothing can open it', () => {
    render(cell(ARTIFACT_CELLS.name, FILE));
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('artifact repository cell', () => {
  it('names the repository, and none for a Studio document', () => {
    const { unmount } = render(cell(ARTIFACT_CELLS.repository, FILE));
    expect(screen.getByText('group/repo')).toBeTruthy();
    unmount();
    render(cell(ARTIFACT_CELLS.repository, { ...FILE, kind: 'document' }));
    expect(screen.queryByText('group/repo')).toBeNull();
    expect(screen.getByTitle('None')).toBeTruthy();
  });
});

describe('artifact row menu', () => {
  it('offers Open in editor for a file, even one without a forge url', async () => {
    const onOpen = vi.fn();
    render(cell(ArtifactRowMenu, FILE, onOpen));

    const trigger = screen.getByRole('button', { name: 'Actions for README.md' }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);
    fireEvent.click(trigger);

    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Open in editor')).toBeTruthy();
    expect(within(menu).queryByText('Open')).toBeNull();
    expect(within(menu).queryByText('Copy link')).toBeNull();

    fireEvent.click(within(menu).getByText('Open in editor'));
    expect(onOpen).toHaveBeenCalledWith(FILE, 'menu');
  });

  it('offers Open and Copy link for an issue', async () => {
    render(cell(ArtifactRowMenu, ISSUE, vi.fn()));

    fireEvent.click(screen.getByRole('button', { name: 'Actions for #12 Broken link' }));

    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Open')).toBeTruthy();
    expect(within(menu).getByText('Copy link')).toBeTruthy();
    expect(within(menu).queryByText('Open in editor')).toBeNull();
  });

  it('is disabled when the row has neither a path to edit nor a url to visit', () => {
    render(cell(ArtifactRowMenu, { ...ISSUE, url: null }, vi.fn()));
    const trigger = screen.getByRole('button', { name: /Actions for/ }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
  });
});
