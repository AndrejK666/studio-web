// What the engine says about a product.gdl beyond the file itself.
//
// The language server's publishDiagnostics covers what evaluating the text can
// find: syntax, unknown arguments, forbidden constructs. A product's other
// failures need the catalogue — a gear no source declares (GBX0301), a plugin
// with no host (GBX0513), a host with no plugin (GBX0511) — and the engine
// answers those on two requests of its own, `gearbox/validate` and
// `gearbox/product/resolve`. Gearbox Studio shows them as a second marker set;
// so does this. The two answers overlap (validate's findings reappear in the
// resolution), so they are merged here, keyed on code, message and range.

export interface EngineDiagnostic {
  code: string;
  severity: string;
  message: string;
  help?: string;
  location?: {
    uri?: string;
    range?: { start: { line: number; character: number }; end: { line: number; character: number } };
  };
}

export interface ProductFinding {
  uri: string;
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

const WHOLE_FIRST_LINE = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

export function productFindings(fallbackUri: string, ...answers: (EngineDiagnostic[] | undefined)[]): ProductFinding[] {
  const out: ProductFinding[] = [];
  const seen = new Set<string>();
  for (const answer of answers) {
    for (const d of answer ?? []) {
      const uri = d.location?.uri ?? fallbackUri;
      const range = d.location?.range ?? WHOLE_FIRST_LINE;
      const key = [uri, d.code, d.message, range.start.line, range.start.character].join("\u0000");
      if (seen.has(key)) continue;
      seen.add(key);
      const severity = d.severity === "error" || d.severity === "warning" ? d.severity : "info";
      out.push({
        uri,
        code: d.code,
        severity,
        message: d.help ? `${d.message}\n${d.help}` : d.message,
        range,
      });
    }
  }
  return out;
}

/** Whether a file is a product description the engine can be asked about. */
export function isProductFile(fsPath: string): boolean {
  return /(^|[\\/])product\.gdl$/.test(fsPath);
}
