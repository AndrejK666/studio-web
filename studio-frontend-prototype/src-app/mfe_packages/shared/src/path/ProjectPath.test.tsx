import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { available } = vi.hoisted(() => ({ available: { value: null as unknown } }));

vi.mock('@gears-frontx/react', async (importOriginal) => {
  const en = (await import('./i18n/en.json')).default as Record<string, string>;
  const fill = (s: string, p?: Record<string, unknown>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(p?.[k] ?? `{${k}}`));
  return {
    ...(await importOriginal<typeof import('@gears-frontx/react')>()),
    useMfeBridge: () => null,
    useSharedProperty: (id: string) => (id.includes('screens.available') ? available.value : null),
    useScreenTranslations: () => ({ isLoaded: true }),
    // The dictionary under the strip's namespace, as the registry answers it.
    useTranslation: () => ({
      language: 'en',
      t: (key: string, p?: Record<string, unknown>) => {
        const own = key.replace(/^screen\.shared\.project-path:/, '');
        return own in en ? fill(en[own], p) : key;
      },
    }),
  };
});

import { ProjectPath } from './ProjectPath';
import {
  joinStages,
  stageOf,
  stagesFromDelivery,
  stagesFromStatus,
  stagesOf,
  withFocus,
  type PathStage,
} from './stages';

afterEach(cleanup);

const whole: PathStage[] = withFocus([
  stageOf('sources', 'done', '1 repository attached, synced.'),
  stageOf('documents', 'done', '10 of 10 documents typed.'),
  stageOf('model', 'done', '10 of 10 documents read, 40 facts.'),
  stageOf('findings', 'done', 'No open findings.'),
  stageOf('product', 'done', '3 gears, resolves, saved as revision 4.'),
  stageOf('build', 'failed', 'Build b-7 failed: the gear api did not build.', {
    object: 'b-7',
    action: { kind: 'open_gear', label: 'Open the gear' },
  }),
  stageOf('images', 'todo', 'Waits for a build that passes.'),
  stageOf('environment', 'blocked', '1 thing is missing before a deploy to dev.'),
  stageOf('deploy', 'todo', 'Waits for the steps before it.'),
]);

const chips = () => [...document.querySelectorAll('[data-stage]')].map((b) => b.getAttribute('data-stage'));

describe('the project path', () => {
  beforeEach(() => {
    available.value = null;
  });

  it('numbers every stage by its place on the whole path, wherever it is drawn', () => {
    render(<ProjectPath stages={whole} only={['build', 'images', 'environment', 'deploy']} onOpen={vi.fn()} />);
    expect(chips()).toEqual(['build', 'images', 'environment', 'deploy']);
    const build = document.querySelector('[data-stage="build"]');
    expect(build?.getAttribute('data-stage-state')).toBe('failed');
    expect(build?.textContent).toContain('Build');
    expect(document.querySelector('[data-path-progress]')?.textContent).toBe('0 of 4 stages done');
    expect(build?.textContent).toContain('6.');
    // An unmarked stage carries its number in its circle.
    expect(document.querySelector('[data-stage="images"] [data-mark]')?.textContent).toBe('7');
    expect(document.querySelector('[data-path-progress]')?.getAttribute('data-path-progress')).toBe('0/4');
  });

  it('says the cause of the focus under the strip, and of a stage on hover', () => {
    render(<ProjectPath stages={whole} onOpen={vi.fn()} />);
    expect(document.querySelector('[data-focus]')?.getAttribute('data-stage')).toBe('build');
    expect(document.querySelector('[data-stage-detail]')?.getAttribute('data-stage-detail')).toBe('build');
    expect(document.querySelector('[data-stage-detail]')?.textContent).toContain('the gear api did not build');
    fireEvent.mouseEnter(document.querySelector('[data-stage="environment"]')!);
    expect(document.querySelector('[data-stage-detail]')?.textContent).toContain('1 thing is missing');
    expect(document.querySelector('[data-stage="build"]')?.getAttribute('title')).toContain('Build b-7 failed');
  });

  it('opens the tab that holds the evidence', () => {
    const onOpen = vi.fn();
    render(<ProjectPath stages={whole} onOpen={onOpen} />);
    fireEvent.click(document.querySelector('[data-stage="documents"]')!);
    expect(onOpen).toHaveBeenLastCalledWith('/projects/specs');
    fireEvent.click(document.querySelector('[data-stage="deploy"]')!);
    expect(onOpen).toHaveBeenLastCalledWith('/releases');
  });

  it('gives no dead navigation to a tab whose kit is not here', () => {
    available.value = { routes: ['/projects/sources', '/releases'], kits: ['delivery'] };
    const onOpen = vi.fn();
    render(<ProjectPath stages={whole} onOpen={onOpen} />);
    fireEvent.click(document.querySelector('[data-stage="documents"]')!);
    expect(onOpen).not.toHaveBeenCalled();
    // The click still shows its cause.
    expect(document.querySelector('[data-stage-detail]')?.getAttribute('data-stage-detail')).toBe('documents');
  });

  it('lets the screen keep its own stages as tabs', () => {
    const onOpen = vi.fn();
    const onSelect = vi.fn((s: PathStage) => s.tab === 'releases');
    render(
      <ProjectPath
        stages={whole}
        only={['build', 'images', 'environment', 'deploy']}
        selected="images"
        onSelect={onSelect}
        tabIdPrefix="release-stage-"
        panelId="panel"
        onOpen={onOpen}
      />
    );
    const images = document.getElementById('release-stage-images');
    expect(images?.getAttribute('role')).toBe('tab');
    expect(images?.getAttribute('aria-selected')).toBe('true');
    expect(images?.getAttribute('aria-controls')).toBe('panel');
    fireEvent.click(document.querySelector('[data-stage="deploy"]')!);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'deploy' }));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('acts on the focus from the line under the strip', () => {
    const onAction = vi.fn(() => true);
    render(<ProjectPath stages={whole} onAction={onAction} onOpen={vi.fn()} />);
    fireEvent.click(document.querySelector('[data-stage-action="open_gear"]')!);
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ id: 'build' }));
  });

  it('says the path could not be read rather than nothing', () => {
    render(<ProjectPath stages={[]} onOpen={vi.fn()} />);
    expect(document.querySelector('[data-path-empty]')).toBeTruthy();
  });
});

describe('stages from an older server', () => {
  it('reads the status path as stages 1-6', () => {
    const stages = stagesFromStatus([
      { step: 'repos', state: 'done', flow: 'done', status: '1 repository attached.', action: 'Open Sources' },
      { step: 'types', state: 'current', flow: 'current', status: '74 of 75 typed.', action: 'Open Specs' },
      { step: 'findings', state: 'todo', flow: 'warn', status: '2 open findings, 1 high.', action: 'Open findings' },
      { step: 'product', state: 'todo', flow: 'failed', status: '2 gears, does not resolve.', action: 'Open Product' },
      { step: 'build', state: 'unknown', flow: 'later', status: 'Could not read the CI runs.', action: 'Open Releases' },
      { step: 'kind', state: 'todo', flow: 'todo', status: 'Decide.', action: 'Open Product' },
    ]);
    expect(stages.map((s) => [s.id, s.number, s.state])).toEqual([
      ['sources', 1, 'done'],
      ['documents', 2, 'todo'],
      ['findings', 4, 'blocked'],
      ['product', 5, 'failed'],
      ['build', 6, 'unknown'],
    ]);
    expect(stages[1].action).toEqual({ kind: 'open', label: 'Open Specs' });
  });

  it('reads the delivery path as stages 5-9 and joins it after the status', () => {
    const delivery = stagesFromDelivery([
      { id: 'product', state: 'done', reason: 'The product is described (revision 2).' },
      { id: 'build', state: 'active', reason: 'Build b-2 is running.', build_id: 'b-2' },
      { id: 'image', state: 'later', reason: 'Waits for a build that passes.' },
      { id: 'environment', state: 'blocked', reason: 'No environment takes this project yet.' },
      { id: 'running', state: 'later', reason: 'Waits for the steps before it.' },
    ]);
    expect(delivery.map((s) => [s.id, s.number, s.state])).toEqual([
      ['product', 5, 'done'],
      ['build', 6, 'running'],
      ['images', 7, 'todo'],
      ['environment', 8, 'blocked'],
      ['deploy', 9, 'todo'],
    ]);
    expect(delivery[1].object).toBe('b-2');
    const path = joinStages(
      stagesFromStatus([{ step: 'repos', state: 'done', flow: 'done', status: 'ok' }]),
      delivery
    );
    expect(path.map((s) => s.id)).toEqual(['sources', 'product', 'build', 'images', 'environment', 'deploy']);
    expect(path.filter((s) => s.focus).map((s) => s.id)).toEqual(['build']);
  });

  it('marks the first stage to do as current', () => {
    const path = withFocus([stageOf('sources', 'done', ''), stageOf('documents', 'todo', ''), stageOf('model', 'todo', '')]);
    expect(path.map((s) => s.state)).toEqual(['done', 'current', 'todo']);
  });

  it('takes the server stages only when it sent some', () => {
    expect(stagesOf(undefined)).toBeNull();
    expect(stagesOf([])).toBeNull();
    expect(stagesOf([{ id: 'nonsense' }])).toBeNull();
    expect(stagesOf([stageOf('build', 'done', '')])?.map((s) => s.id)).toEqual(['build']);
  });
});

describe('the dictionaries', () => {
  it('say every word in Russian too, with the plural forms Russian needs', async () => {
    const en = (await import('./i18n/en.json')).default as Record<string, string>;
    const ru = (await import('./i18n/ru.json')).default as Record<string, string>;
    const plain = (keys: string[]) => keys.filter((k) => !/_(one|few|many)$/.test(k)).sort();
    expect(plain(Object.keys(ru))).toEqual(plain(Object.keys(en)));
    expect(['progress_one', 'progress_few', 'progress_many'].every((k) => k in ru)).toBe(true);
  });
});
