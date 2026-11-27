import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OntologyView } from './OntologyView';

const t = ((key: string) => key) as unknown as Parameters<typeof OntologyView>[0]['t'];

describe('OntologyView', () => {
  it("lists node types with the project's counts and edge types with what they connect", () => {
    render(
      <OntologyView
        ontology={{
          nodes: { document: 'A Markdown file', requirement: 'A requirement' },
          edges: {
            realizes: { description: 'design realizes a requirement', from: ['design_element'], to: ['requirement'], kind: 'static (from the documents)' },
            judged_realizes: { description: 'a judge says so', from: ['design_element'], to: ['requirement'], kind: 'analysis (a judge\'s conclusion, with provenance)' },
          },
          keys: 'documents by doc:<path>',
          counts: { requirement: 225, document: 83, phantom_node: 49 },
        }}
        t={t}
      />
    );
    const rows = screen.getAllByRole('row').map((r) => r.textContent);
    expect(rows[1]).toContain('requirement225');
    expect(rows[2]).toContain('document83');
    expect(screen.getByText('phantom_node')).toBeTruthy();
    expect(screen.getAllByText('design_element → requirement')).toHaveLength(2);
    expect(screen.getByText('ontology_judged')).toBeTruthy();
    expect(screen.getByText('documents by doc:<path>')).toBeTruthy();
  });
});
