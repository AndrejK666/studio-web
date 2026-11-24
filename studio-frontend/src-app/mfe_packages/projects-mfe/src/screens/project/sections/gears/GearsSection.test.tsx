/** The Gears section and its header button; only the store, the dispatch and the translations are stubbed. */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GearsActions } from './GearsActions';
import { GearsSection } from './GearsSection';

const { state, dispatched, translations, startMatch } = vi.hoisted(() => ({
  state: { current: {} as Record<string, unknown> },
  dispatched: [] as { type: string; payload?: unknown }[],
  translations: { isLoaded: true, error: null as Error | null },
  startMatch: vi.fn(),
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  useAppSelector: (select: (store: unknown) => unknown) => select(state.current),
  useAppDispatch: () => (action: { type: string; payload?: unknown }) => dispatched.push(action),
}));
vi.mock('../../../../actions/gearsMatchActions', () => ({
  startGearsMatch: startMatch,
}));
vi.mock('../../../../i18n', () => {
  const t = (key: string, params?: Record<string, unknown>) =>
    params ? `${key} ${Object.values(params).join(' ')}` : key;
  return {
    useGearsSectionTranslations: () => translations,
    useGearsText: () => t,
  };
});

const choice = { provider: 'litellm', model: 'glm-5.3-flash' };
const run = (more: Record<string, unknown>) => ({
  ...choice,
  spec: 'PRD.md',
  phase: 'running',
  done: 0,
  total: 0,
  calls: 0,
  state: null,
  report: null,
  error: null,
  ...more,
});
const store = (
  more: {
    spec?: unknown;
    runs?: Record<string, unknown>;
    choice?: unknown;
  } = {}
) => {
  state.current = {
    'projects/gearsMatch': { choice, spec: null, runs: {}, ...more },
  };
};

beforeEach(() => {
  dispatched.length = 0;
  startMatch.mockReset();
  translations.isLoaded = true;
  translations.error = null;
  store();
});

describe('GearsSection', () => {
  it('shows the chosen connection, its model and where requests go', () => {
    render(<GearsSection projectId="p1" />);
    expect(screen.getByText('provider_litellm')).toBeTruthy();
    expect(screen.getByText('glm-5.3-flash')).toBeTruthy();
    expect(screen.getByText('sent_to litellm.ext.constr.dev')).toBeTruthy();
  });

  it('does not offer Constructor', () => {
    render(<GearsSection projectId="p1" />);
    expect(screen.queryByText(/constructor/i)).toBeNull();
  });

  it('asks for a spec, and shows the one chosen with a way to change or remove it', () => {
    const { unmount } = render(<GearsSection projectId="p1" />);
    expect(screen.getByText('spec_choose')).toBeTruthy();
    unmount();
    store({ spec: { name: 'PRD.md', content: '# PRD' } });
    render(<GearsSection projectId="p1" />);
    expect(screen.getByText('PRD.md')).toBeTruthy();
    expect(screen.getByText('spec_change')).toBeTruthy();
    fireEvent.click(screen.getByText('spec_clear'));
    expect(dispatched.map((a) => a.type)).toContain('projects/gearsMatch/specCleared');
  });

  it('says there is no match yet', () => {
    render(<GearsSection projectId="p1" />);
    expect(screen.getByText('none_title')).toBeTruthy();
  });

  it('shows a match going, with its progress', () => {
    store({ runs: { p1: run({ done: 3, total: 8, calls: 5 }) } });
    render(<GearsSection projectId="p1" />);
    expect(screen.getAllByRole('status')[0].textContent).toContain('running_note');
    expect(screen.getByText('running_progress 3 8 5')).toBeTruthy();
  });

  it('shows a failed match as an alert with its reason', () => {
    store({
      runs: {
        p1: run({
          phase: 'failed',
          error: 'this service has no key for openai',
        }),
      },
    });
    render(<GearsSection projectId="p1" />);
    expect(screen.getByRole('alert').textContent).toContain('this service has no key for openai');
  });

  it('shows the report: counts, each requirement with its coverage and Gears, and the recommended Gears', () => {
    store({
      runs: {
        p1: run({
          phase: 'done',
          state: 'partial',
          calls: 7,
          report: {
            requirements: [
              {
                requirement_id: 'fr-feed',
                coverage: 'covered',
                confidence: 0.9,
                gears: [{ gear_id: 'gears-rust/event-broker' }],
              },
              {
                requirement_id: 'fr-sync',
                coverage: 'not_assessed',
                confidence: null,
                gears: [],
              },
            ],
            recommended_gears: [
              {
                gear_id: 'gears-rust/event-broker',
                name: 'event-broker',
                requirement_ids: ['fr-feed'],
              },
            ],
          },
        }),
      },
    });
    render(<GearsSection projectId="p1" />);
    expect(screen.getByText('fr-feed')).toBeTruthy();
    expect(screen.getByText('gears-rust/event-broker')).toBeTruthy();
    expect(screen.getByText('coverage_covered')).toBeTruthy();
    expect(screen.getByText('coverage_not_assessed')).toBeTruthy();
    expect(screen.getByText('partial_note')).toBeTruthy();
    expect(screen.getByText('recommended')).toBeTruthy();
    expect(screen.getByText('recommended_for_one')).toBeTruthy();
  });
});

describe('GearsActions', () => {
  it('waits for a spec', () => {
    render(<GearsActions projectId="p1" projectName="Studio" />);
    const button = screen.getByRole('button', { name: 'match' });
    expect(button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true').toBe(
      true
    );
    fireEvent.click(button);
    expect(startMatch).not.toHaveBeenCalled();
  });

  it('starts a match with the spec, the choice and the project', () => {
    store({ spec: { name: 'PRD.md', content: '# PRD' } });
    render(<GearsActions projectId="p1" projectName="Studio" />);
    fireEvent.click(screen.getByRole('button', { name: 'match' }));
    expect(startMatch).toHaveBeenCalledWith(expect.any(Function), {
      projectId: 'p1',
      projectName: 'Studio',
      spec: { name: 'PRD.md', content: '# PRD' },
      choice,
    });
  });

  it('is disabled while that project is matching', () => {
    store({
      spec: { name: 'PRD.md', content: '# PRD' },
      runs: { p1: run({}) },
    });
    render(<GearsActions projectId="p1" projectName="Studio" />);
    const button = screen.getByRole('button', { name: 'match_running_label' });
    expect(button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true').toBe(
      true
    );
  });
});
