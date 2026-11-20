export const KIT_CATEGORIES = [
  'planning',
  'product',
  'delivery',
  'research',
  'reporting',
  'studio',
  'other',
] as const;

export type KitCategory = (typeof KIT_CATEGORIES)[number];

const catalogCategories = new Map<string, KitCategory>([
  ['project-lifecycle', 'planning'],
  ['project-specs', 'planning'],
  ['project-domain-model', 'planning'],
  ['sdlc', 'planning'],
  ['project-product', 'product'],
  ['components', 'product'],
  ['gears-project', 'product'],
  ['gears-matcher', 'product'],
  ['spec-mapping', 'product'],
  ['project-git', 'delivery'],
  ['project-tests', 'delivery'],
  ['delivery', 'delivery'],
  ['constructor-research', 'delivery'],
  ['compete', 'research'],
  ['mna', 'research'],
  ['org-costs', 'reporting'],
  ['org-reports', 'reporting'],
  ['assistant', 'studio'],
  ['studio-api-docs', 'studio'],
]);

export function kitCategory(slug: string): KitCategory {
  return catalogCategories.get(slug) ?? 'other';
}
