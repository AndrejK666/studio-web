import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { service } = vi.hoisted(() => ({ service: {} as Record<string, unknown> }));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  apiRegistry: { getService: () => service },
}));

// jsdom has no WebGL: a stand-in for sigma keeps the graph it was given and its handlers
type Drawn = { graph: { nodes: () => string[] }; handlers: Record<string, (e: { node: string }) => void> };
const { drawn } = vi.hoisted(() => ({ drawn: [] as Drawn[] }));
vi.mock('sigma', () => ({
  default: class {
    graph: { nodes: () => string[] };
    handlers: Record<string, (e: { node: string }) => void> = {};
    constructor(graph: { nodes: () => string[] }) {
      this.graph = graph;
      drawn.push(this);
    }
    on(name: string, f: (e: { node: string }) => void) {
      this.handlers[name] = f;
    }
    refresh() {}
    kill() {}
    getCamera() {
      return { on() {}, animate() {}, animatedReset() {}, getState: () => ({ ratio: 1 }) };
    }
    getNodeDisplayData() {
      return { x: 0, y: 0 };
    }
    framedGraphToViewport() {
      return { x: 0, y: 0 };
    }
  },
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
    // the hits give way to the node's map
    await waitFor(() => expect(screen.queryByTitle(SVC)).toBeNull());
    expect(await screen.findByText('Chat service')).toBeTruthy();
  });

  it('says the graph is not built yet instead of opening on nothing', () => {
    render(<GraphView projectId="p1" start={REQ} counts={{}} t={t} />);
    expect(screen.getByText('graph_empty')).toBeTruthy();
  });

  it('says a node is not in the graph when the gear answers 404', async () => {
    service.node = () => ({ fetch: () => Promise.reject(new Error('404 not found')) });
    service.neighbors = () => ({ fetch: () => Promise.reject(new Error('404 not found')) });
    render(<GraphView projectId="p1" start="doc:missing.md" counts={{ document: 3 }} t={t} />);
    expect(await screen.findByText('graph_not_in_graph')).toBeTruthy();
  });

  it('draws the graph to a depth, 2 by default and up to 4, and the whole graph', async () => {
    const subgraph = vi.fn(({ depth }: { depth: number }) => ({
      fetch: () =>
        Promise.resolve({
          answer: {
            key: REQ,
            depth,
            nodes: [
              { key: REQ, type: 'requirement', name: 'Streaming Cancellation' },
              { key: SVC, type: 'design_element', name: 'Chat service' },
              { key: 'sec:gears/mini-chat/docs/PRD.md#x', type: 'section', name: 'X' },
            ],
            edges: [{ from: SVC, to: REQ, type: 'realizes', kind: 'static' }],
          },
        }),
    }));
    const overview = vi.fn(() => ({
      fetch: () =>
        Promise.resolve({
          answer: { nodes: [{ key: 'doc:a.md', type: 'document', name: 'A' }], edges: [], counts: { document: 1 } },
        }),
    }));
    Object.assign(service, { subgraph, overview });
    drawn.length = 0;
    render(<GraphView projectId="p1" start={REQ} counts={{ requirement: 1, section: 1, fact: 9, concept: 5 }} t={t} />);
    fireEvent.click(screen.getByText('graph_mode_depth'));
    await waitFor(() => expect(subgraph).toHaveBeenCalledWith(expect.objectContaining({ key: REQ, depth: 2 })));
    await waitFor(() => expect(drawn.length).toBeGreaterThan(0));
    // sections fold into their documents: the section became its document's node
    expect(drawn[drawn.length - 1].graph.nodes().sort()).toEqual([SVC, REQ, 'doc:gears/mini-chat/docs/PRD.md'].sort());
    expect(screen.getByText(/graph_size/)).toBeTruthy();
    fireEvent.change(screen.getByRole('slider'), { target: { value: '4' } });
    await waitFor(() => expect(subgraph).toHaveBeenCalledWith(expect.objectContaining({ depth: 4 })));
    fireEvent.click(screen.getByText('graph_mode_whole'));
    await waitFor(() => expect(overview).toHaveBeenCalledWith({ projectId: 'p1', types: 'requirement,section' }));
    await waitFor(() => expect(drawn[drawn.length - 1].graph.nodes()).toEqual(['doc:a.md']));
    expect(screen.getByRole('combobox')).toBeTruthy();   // colour by cluster or by type
    // a click on a node of the whole graph opens it to a depth
    act(() => drawn[drawn.length - 1].handlers.clickNode({ node: 'doc:a.md' }));
    await waitFor(() => expect(subgraph).toHaveBeenCalledWith(expect.objectContaining({ key: 'doc:a.md' })));
  });

  it('names the document of each section it finds', async () => {
    service.search = () => ({
      fetch: () =>
        Promise.resolve({ answer: { hits: [{ key: 'sec:docs/auth/PRD.md#11-purpose', type: 'section', name: '1.1 Purpose', path: 'docs/auth/PRD.md' }] } }),
    });
    render(<GraphView projectId="p1" start={null} counts={{ section: 1 }} t={t} />);
    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'purpose' } });
    fireEvent.click(screen.getByText('graph_find'));
    expect(await screen.findByText('docs/auth/PRD.md')).toBeTruthy();
  });
});
