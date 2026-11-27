/** Pure helpers of Project › Spec graph: what the screen draws from the gear's answers. */

import type { Anchor, DocumentFindings, Finding } from '../api/types';

/** `path:line` (or `path:start–end`), or the path alone. */
export function place(path: string | null, a: Anchor | null | undefined): string {
  const p = path ?? '';
  if (!a || a.line_start == null) return p;
  const end = a.line_end != null && a.line_end !== a.line_start ? `–${a.line_end}` : '';
  return `${p}:${a.line_start}${end}`;
}

/** Blocking findings first, then by rule, so a document's list reads the same every time. */
export function ordered(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (x, y) => Number(x.gate !== 'block') - Number(y.gate !== 'block') || x.rule.localeCompare(y.rule)
  );
}

/** Documents with at least one finding, the ones with blocking findings first. */
export function documentsInOrder(docs: DocumentFindings[]): DocumentFindings[] {
  const blocking = (d: DocumentFindings) => d.findings.some((f) => f.gate === 'block');
  return docs
    .filter((d) => d.findings.length > 0)
    .map((d) => ({ ...d, findings: ordered(d.findings) }))
    .sort((a, b) => Number(blocking(b)) - Number(blocking(a)) || (a.path ?? '').localeCompare(b.path ?? ''));
}

export function counts(docs: DocumentFindings[]): { total: number; blocking: number; documents: number } {
  const all = docs.flatMap((d) => d.findings);
  return {
    total: all.length,
    blocking: all.filter((f) => f.gate === 'block').length,
    documents: docs.filter((d) => d.findings.length > 0).length,
  };
}

/** The finding left out after a decision, until the next read says otherwise. */
export function without(docs: DocumentFindings[], fingerprint: string): DocumentFindings[] {
  return docs.map((d) => ({ ...d, findings: d.findings.filter((f) => f.id !== fingerprint) }));
}

/**
 * A review thread's body as text to read on the screen: the Markdown CI posts,
 * without its machine parts (the `specq:` markers, the footer, the HTML of the
 * folded reasons) and with links reduced to their text.
 */
export function plainThread(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<sub>[\s\S]*?<\/sub>/g, '')
    .replace(/<details><summary>([\s\S]*?)<\/summary>/g, '$1:')
    .replace(/<\/?details>/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/```suggestion\n([\s\S]*?)\n```/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
