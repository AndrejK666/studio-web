// Constructor Studio: a product.gdl opened in the editor is checked against the
// catalogue, whether or not it is the product Gearbox has open.
//
// The engine's language server marks what evaluating the text can find
// (`DescriptionMarkers`). A product's other failures — a gear no source
// declares (GBX0301), a plugin with no host (GBX0513), a host with no plugin
// (GBX0511) — need the catalogue, and Gearbox Studio shows them only for the
// product opened through it (`ResolutionMarkers`). In a Studio session a person
// mostly meets a product.gdl as a file in a checkout, opened from the Explorer
// or from the portal's "Open in IDE", so that file is asked about too: on open
// and on save, through `validate` and `resolve`, merged, under an owner of its
// own. This is what theia/gdl-language did before it was retired.

import { FrontendApplicationContribution } from "@theia/core/lib/browser";
import { DisposableCollection } from "@theia/core/lib/common/disposable";
import { URI } from "@theia/core/lib/common/uri";
import {
  Diagnostic as LspDiagnostic,
  DiagnosticSeverity,
} from "@theia/core/shared/vscode-languageserver-protocol";
import { inject, injectable } from "@theia/core/shared/inversify";
import { ProblemManager } from "@theia/markers/lib/browser/problem/problem-manager";
import type { MonacoEditorModel } from "@theia/monaco/lib/browser/monaco-editor-model";
import { MonacoTextModelService } from "@theia/monaco/lib/browser/monaco-text-model-service";

import type { Diagnostic } from "../../common/generated/Diagnostic";
import { GearboxService } from "../../common/protocol";
import { ProductStore } from "../product-store";
import { EngineConnectionService } from "../shell/engine-connection-service";

/** Distinct from `gearbox` (resolution) and `gearbox-gdl` (the file's text). */
export const PRODUCT_FILE_MARKER_OWNER = "gearbox-product-file";

const TOP: LspDiagnostic["range"] = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

export function isProductFile(uri: string): boolean {
  return /(^|\/)product\.gdl$/.test(uri);
}

/**
 * The two answers as markers per file: `validate` has the precise ranges for
 * the catalogue checks, `resolve` adds what only a resolution finds, and the
 * same finding reported by both is shown once.
 */
export function productFindings(
  fallbackUri: string,
  ...answers: (readonly Diagnostic[] | undefined)[]
): Map<string, LspDiagnostic[]> {
  const byUri = new Map<string, LspDiagnostic[]>();
  const seen = new Set<string>();
  for (const answer of answers) {
    for (const d of answer ?? []) {
      const uri = d.location?.uri ?? fallbackUri;
      const range = d.location?.range ?? TOP;
      const key = [uri, d.code, d.message, range.start.line, range.start.character].join("\u0000");
      if (seen.has(key)) continue;
      seen.add(key);
      const severity =
        d.severity === "error"
          ? DiagnosticSeverity.Error
          : d.severity === "warning"
            ? DiagnosticSeverity.Warning
            : d.severity === "hint"
              ? DiagnosticSeverity.Hint
              : DiagnosticSeverity.Information;
      const list = byUri.get(uri) ?? [];
      list.push({
        range,
        severity,
        code: d.code,
        source: "gearbox",
        message: d.help ? `${d.message}\n${d.help}` : d.message,
      });
      byUri.set(uri, list);
    }
  }
  return byUri;
}

@injectable()
export class ProductFileChecks implements FrontendApplicationContribution {
  @inject(GearboxService) protected readonly service!: GearboxService;
  @inject(ProblemManager) protected readonly problems!: ProblemManager;
  @inject(MonacoTextModelService) protected readonly models!: MonacoTextModelService;
  @inject(ProductStore) protected readonly products!: ProductStore;
  @inject(EngineConnectionService) protected readonly engine!: EngineConnectionService;

  protected readonly toDispose = new DisposableCollection();
  protected readonly tracked = new Map<string, { model: MonacoEditorModel; disposables: DisposableCollection }>();
  /** Which files each product's last check put markers on, to clear them. */
  protected readonly written = new Map<string, string[]>();

  onStart(): void {
    for (const model of this.models.models) this.track(model);
    this.toDispose.push(this.models.onDidCreate((model) => this.track(model)));
    // A fresh engine knows nothing a dead one said; ask again.
    this.toDispose.push(
      this.engine.onDidChange((connected) => {
        if (connected) for (const uri of this.tracked.keys()) void this.check(uri);
      }),
    );
  }

  onStop(): void {
    this.toDispose.dispose();
    for (const { disposables } of this.tracked.values()) disposables.dispose();
    this.tracked.clear();
  }

  protected track(model: MonacoEditorModel): void {
    const uri = model.uri;
    if (!isProductFile(uri) || this.tracked.has(uri)) return;
    const disposables = new DisposableCollection();
    disposables.push(model.onDidSaveModel(() => void this.check(uri)));
    disposables.push(
      model.onDispose(() => {
        disposables.dispose();
        this.tracked.delete(uri);
        this.clear(uri);
      }),
    );
    this.tracked.set(uri, { model, disposables });
    void this.check(uri);
  }

  protected async check(uri: string): Promise<void> {
    // The product Gearbox has open is ResolutionMarkers' to mark.
    const open = this.products.current.open?.path;
    const path = new URI(uri).path.fsPath();
    if (open !== undefined && open === path) {
      this.clear(uri);
      return;
    }
    try {
      const [validated, resolved] = await Promise.all([
        this.service.validate(path),
        this.service.resolve(path).catch(() => undefined),
      ]);
      const found = productFindings(uri, validated?.diagnostics, resolved?.diagnostics);
      this.clear(uri);
      for (const [target, markers] of found) this.problems.setMarkers(new URI(target), PRODUCT_FILE_MARKER_OWNER, markers);
      this.written.set(uri, [...found.keys()]);
    } catch {
      // The engine is down or still loading; its reconnect asks again.
    }
  }

  protected clear(product: string): void {
    for (const target of this.written.get(product) ?? []) {
      this.problems.setMarkers(new URI(target), PRODUCT_FILE_MARKER_OWNER, []);
    }
    this.written.delete(product);
  }
}
