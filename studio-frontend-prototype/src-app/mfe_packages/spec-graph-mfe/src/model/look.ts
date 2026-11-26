/**
 * A node type's colour and shape on the graph pictures and the ontology: blue,
 * amber, pink, purple and greys, so a type is never told by a red/green or an
 * amber/orange pair (nor by colour alone where a shape can be drawn).
 */

export const LOOK: Record<string, { shape: 'square' | 'circle' | 'diamond' | 'triangle' | 'dot'; colour: string }> = {
  document: { shape: 'square', colour: '#2563eb' },
  requirement: { shape: 'circle', colour: '#d97706' },
  design_element: { shape: 'diamond', colour: '#db2777' },
  decision: { shape: 'triangle', colour: '#7c3aed' },
  section: { shape: 'dot', colour: '#94a3b8' },
};
const OTHER = { shape: 'circle' as const, colour: '#64748b' };

export const lookOf = (type: string) => LOOK[type] ?? OTHER;
export const colourOf = (type: string) => lookOf(type).colour;
