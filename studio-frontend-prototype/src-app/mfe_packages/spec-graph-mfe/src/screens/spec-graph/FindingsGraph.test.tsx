import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { service, drawn } = vi.hoisted(() => ({
  service: {} as Record<string, unknown>,
  drawn: [] as { handlers: Record<string, (e: { node: string }) => void> }[],
}));
vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  apiRegistry: { getService: () => service },
}));
vi.mock('sigma', () => ({
  default: class {
    handlers: Record<string, (e: { node: string }) => void> = {};
    constructor() {
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

import { FindingsGraph, fingerprintOf } from './FindingsGraph';

const t = ((key: string, p?: Record<string, unknown>) =>
  p ? `${key} ${JSON.stringify(p)}` : key) as unknown as Parameters<typeof FindingsGraph>[0]['t'];
const anchor = (line: number, quote: string) => ({ section: null, line_start: line, line_end: line, quote });

describe('FindingsGraph', () => {
  it("opens a finding's panel beside the graph: both passages, the judge's explanation, and a decision", async () => {
    const decide = vi.fn((..._a: unknown[]) => Promise.resolve({}));
    const open = vi.fn();
    Object.assign(service, {
      overview: () => ({
        fetch: () =>
          Promise.resolve({
            answer: {
              nodes: [
                { key: 'finding:95d2:run1', type: 'finding', name: 'contradiction.value: canonical set' },
                { key: 'doc:docs/PRD.md', type: 'document', name: 'PRD — Identity' },
              ],
              edges: [
                {
                  from: 'finding:95d2:run1',
                  to: 'sec:docs/PRD.md#14-glossary',
                  type: 'finding_cites',
                  kind: 'analysis',
                },
              ],
            },
          }),
      }),
      findings: () => ({
        fetch: () =>
          Promise.resolve({
            items: [
              {
                path: 'docs/PRD.md',
                detector: 'spec_graph',
                findings: [
                  {
                    id: '95d2',
                    rule: 'contradiction.value',
                    detector: 'spec_graph',
                    severity: 'medium',
                    gate: 'advise',
                    title: 'Two passages give different values for one thing',
                    message: 'A includes employee_id; B keeps four canonical types.',
                    anchor: anchor(92, 'Canonical set: id, email, …, employee_id'),
                    related: [
                      {
                        path: 'docs/ADR/0002.md',
                        anchor: anchor(78, 'Canonical value-types are id, email, username, display_name'),
                      },
                    ],
                    evidence: [],
                    source: 'llm:cloud-strong',
                    suggestion: null,
                  },
                ],
              },
            ],
            total: 1,
            dismissed: 0,
          }),
      }),
      decide: (_p: string, fp: string) => ({ fetch: (body: unknown) => decide(fp, body) }),
    });
    drawn.length = 0;
    render(<FindingsGraph projectId="p1" onOpen={open} t={t} />);
    await waitFor(() => expect(drawn.length).toBeGreaterThan(0));
    // hovering says what it is, where, what about, and that a click opens it
    act(() => drawn[drawn.length - 1].handlers.enterNode({ node: 'finding:95d2:run1' }));
    const card = await screen.findByRole('tooltip');
    expect(card.textContent).toContain('gate_advise');
    expect(card.textContent).toContain('Two passages give different values for one thing');
    expect(card.textContent).toContain('canonical set');
    expect(card.textContent).toContain('PRD.md:92  ↔  0002.md:78');
    expect(card.textContent).toContain('«A includes employee_id;');
    expect(card.textContent).toContain('tip_open_finding');
    act(() => drawn[drawn.length - 1].handlers.enterNode({ node: 'doc:docs/PRD.md' }));
    expect((await screen.findByRole('tooltip')).textContent).toContain(
      'tip_document_findings {"count":1,"block":0,"advise":1}',
    );
    act(() => drawn[drawn.length - 1].handlers.leaveNode({ node: 'doc:docs/PRD.md' }));
    act(() => drawn[drawn.length - 1].handlers.clickNode({ node: 'finding:95d2:run1' }));
    expect(await screen.findByText('A includes employee_id; B keeps four canonical types.')).toBeTruthy();
    expect(screen.getByText(/Canonical set: id, email/)).toBeTruthy();
    expect(screen.getByText(/Canonical value-types are id/)).toBeTruthy();
    fireEvent.click(screen.getByText('confirm'));
    await waitFor(() =>
      expect(decide).toHaveBeenCalledWith('95d2', { decision: 'confirmed', rule: 'contradiction.value' }),
    );
    expect(await screen.findByText('decided_confirmed')).toBeTruthy();
    // a document still opens to a depth
    act(() => drawn[drawn.length - 1].handlers.clickNode({ node: 'doc:docs/PRD.md' }));
    expect(open).toHaveBeenCalledWith('doc:docs/PRD.md');
    fireEvent.click(screen.getByLabelText('finding_panel_close'));
    expect(screen.queryByText('A includes employee_id; B keeps four canonical types.')).toBeNull();
  });

  it('reads the fingerprint from a finding key', () => {
    expect(fingerprintOf('finding:95d2e9a3aa96ca9b:20261126T190000Z')).toBe('95d2e9a3aa96ca9b');
    expect(fingerprintOf('doc:a.md')).toBeNull();
  });
});
