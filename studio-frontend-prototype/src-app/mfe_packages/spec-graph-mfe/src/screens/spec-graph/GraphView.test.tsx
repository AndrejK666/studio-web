import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { service } = vi.hoisted(() => ({ service: {} as Record<string, unknown> }));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  apiRegistry: { getService: () => service },
}));

import { GraphView } from './GraphView';

const text = (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key);
const t = Object.assign(text, { count: (key: string, count: number) => `${key} ${count}` }) as unknown as Parameters<
  typeof GraphView
>[0]['t'];

const REQ = 'cpt-cf-mini-chat-fr-streaming-cancellation';
const SVC = 'cpt-cf-mini-chat-component-chat-service';
const graph: Record<string, { node: unknown; neighbors: unknown }> = {
  [REQ]: {
    node: { key: REQ, name: 'Streaming Cancellation', payload: { path: 'gears/mini-chat/docs/PRD.md', line: 226, kind: 'fr', text: 'The system MUST cancel…' } },
    neighbors: {
      key: REQ,
      in: { defines: ['doc:gears/mini-chat/docs/PRD.md'] },
      out: { defined_in: ['sec:gears/mini-chat/docs/PRD.md#streaming-cancellation'] },
      judged: [
        {
          edge: 'judged_realizes',
          from: SVC,
          path: 'gears/mini-chat/docs/DESIGN.md',
          lines: '32',
          quote: 'Cancellation propagates end-to-end',
          realized: 'yes',
          by: { model: 'local-main+cloud-mini' },
        },
      ],
    },
  },
  [SVC]: {
    node: { key: SVC, name: 'Chat service', payload: {} },
    neighbors: { key: SVC, in: {}, out: { realizes: [REQ] }, judged: [] },
  },
};

describe('GraphView', () => {
  beforeEach(() => {
    for (const k of Object.keys(service)) delete service[k];
    service.node = ({ key }: { key: string }) => ({ fetch: () => Promise.resolve({ answer: graph[key].node }) });
    service.neighbors = ({ key }: { key: string }) => ({ fetch: () => Promise.resolve({ answer: graph[key].neighbors }) });
  });

  it("draws a node's neighbours and a judge's conclusion, and centres on a neighbour", async () => {
    render(<GraphView projectId="p1" start={REQ} t={t} />);
    expect(await screen.findByText('Streaming Cancellation')).toBeTruthy();
    expect(screen.getByText('PRD.md')).toBeTruthy();
    expect(screen.getByText('§ streaming-cancellation')).toBeTruthy();
    expect(screen.getAllByText('component chat-service').length).toBeGreaterThan(0);
    expect(screen.getByText(/Cancellation propagates end-to-end/)).toBeTruthy();
    expect(screen.getByText('gears/mini-chat/docs/PRD.md:226')).toBeTruthy();

    fireEvent.click(screen.getAllByText('component chat-service')[0]);
    expect(await screen.findByText('Chat service')).toBeTruthy();
    fireEvent.click(screen.getByText('graph_back'));
    expect(await screen.findByText('Streaming Cancellation')).toBeTruthy();
  });

  it('finds a node by search and opens it', async () => {
    service.search = () => ({ fetch: () => Promise.resolve({ answer: [{ key: SVC, name: 'Chat service' }] }) });
    render(<GraphView projectId="p1" start={null} t={t} />);
    expect(screen.getByText('graph_hint')).toBeTruthy();
    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'chat service' } });
    fireEvent.click(screen.getByText('graph_find'));
    fireEvent.click(await screen.findByTitle(SVC));
    await waitFor(() => expect(screen.getAllByText('Chat service').length).toBeGreaterThan(1));
  });
});
