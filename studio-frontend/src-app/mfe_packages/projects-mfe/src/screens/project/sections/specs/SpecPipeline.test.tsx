import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpecPipelineDto } from '../../../../api/documentTypes';

const { read, put, run } = vi.hoisted(() => ({
  read: vi.fn(),
  put: vi.fn(),
  run: vi.fn(),
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  apiRegistry: {
    getService: () => ({
      specPipeline: () => ({ fetch: read }),
      putSpecPipelineSettings: () => ({ fetch: put }),
      runSpecPipeline: () => ({ fetch: run }),
    }),
  },
}));
vi.mock('@constructor-studio/mfe-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@constructor-studio/mfe-shared')>()),
  useStudioEventRefresh: () => undefined,
}));
vi.mock('../../../../api/DocumentsApiService', () => ({ DocumentsApiService: class {} }));
vi.mock('../../../../i18n', () => {
  const t = (key: string, params?: Record<string, string>) =>
    params ? `${key} ${Object.values(params).join(' ')}` : key;
  return { useSpecsText: () => t };
});

import { SpecPipeline, percentOf, thresholdOf } from './SpecPipeline';

const pipeline = (over: Partial<SpecPipelineDto> = {}): SpecPipelineDto => ({
  project_id: 'p-1',
  enabled: true,
  auto_confirm_threshold: 0.8,
  status: 'ready',
  computed_at: '2026-11-25T10:00:00Z',
  requested_at: null,
  error: null,
  steps: [
    { step: 'specs', state: 'done', summary: '3 bound (2 confirmed automatically)', reason: null, at: null, link: null },
    {
      step: 'domain_model',
      state: 'stopped',
      summary: null,
      reason: 'no AI connection with a chat model is set up',
      at: null,
      link: null,
    },
    { step: 'mapping', state: 'waiting', summary: null, reason: 'waits for the project domain model', at: null, link: null },
    { step: 'product', state: 'waiting', summary: null, reason: 'waits for the project domain model', at: null, link: null },
  ],
  ...over,
});

beforeEach(() => {
  read.mockReset();
  put.mockReset();
  run.mockReset();
});

describe('the threshold', () => {
  it('reads as a whole percent and goes back as a fraction', () => {
    expect(percentOf(0.8)).toBe(80);
    expect(thresholdOf('95')).toBe(0.95);
    expect(thresholdOf('100')).toBe(1);
    expect(thresholdOf('')).toBeNull();
    expect(thresholdOf('120')).toBeNull();
    expect(thresholdOf('-1')).toBeNull();
    expect(thresholdOf('high')).toBeNull();
  });
});

describe('the automatic pipeline', () => {
  it('shows every step, and why the chain stopped', async () => {
    read.mockResolvedValue(pipeline());
    render(<SpecPipeline projectId="p-1" />);
    await screen.findByText('pipeline_title');
    const model = document.querySelector('[data-spec-pipeline-step="domain_model"]')!;
    expect(model.getAttribute('data-state')).toBe('stopped');
    expect(model.textContent).toContain('no AI connection');
    expect(document.querySelector('[data-spec-pipeline-step="specs"]')!.textContent).toContain(
      '2 confirmed automatically'
    );
    expect((screen.getByDisplayValue('80') as HTMLInputElement).value).toBe('80');
  });

  it('says it has not run before the first sync', async () => {
    read.mockResolvedValue(pipeline({ steps: [], status: null, computed_at: null }));
    render(<SpecPipeline projectId="p-1" />);
    expect(await screen.findByText('pipeline_never')).toBeTruthy();
  });

  it('saves a new threshold as a fraction', async () => {
    read.mockResolvedValue(pipeline());
    put.mockResolvedValue(pipeline({ auto_confirm_threshold: 0.9 }));
    render(<SpecPipeline projectId="p-1" />);
    const input = (await screen.findByDisplayValue('80')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '90' } });
    fireEvent.blur(input);
    await waitFor(() => expect(put).toHaveBeenCalledWith({ project_id: 'p-1', auto_confirm_threshold: 0.9 }));
  });

  it('runs the pipeline again on request', async () => {
    read.mockResolvedValue(pipeline());
    run.mockResolvedValue({ run_id: 'r-1' });
    render(<SpecPipeline projectId="p-1" />);
    fireEvent.click(await screen.findByText('pipeline_run'));
    await waitFor(() => expect(run).toHaveBeenCalledWith({ project_id: 'p-1' }));
  });

  it('says so when the pipeline cannot be read', async () => {
    read.mockRejectedValue(new Error('503'));
    render(<SpecPipeline projectId="p-1" />);
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});
