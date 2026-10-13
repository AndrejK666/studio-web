// Constructor Studio: the two terminals a generated product is built and run in.
//
// Named and reused, one pair per product: pressing Build again types into the
// Build terminal that is already there instead of opening another, and Run
// stops what the Run terminal is running (Ctrl+C) before starting it again, so
// a second press restarts the product rather than typing into its stdin.

import { FileUri } from "@theia/core/lib/common/file-uri";
import { inject, injectable } from "@theia/core/shared/inversify";
import { TerminalService } from "@theia/terminal/lib/browser/base/terminal-service";

export type ProductTerminalKind = "build" | "run";

/** The widget id of a product's terminal: stable, so the next press finds it. */
export function productTerminalId(kind: ProductTerminalKind, product: string): string {
  return `gearbox-${kind}-${product}`;
}

@injectable()
export class ProductTerminals {
  @inject(TerminalService) protected readonly terminals!: TerminalService;
  /** The environment each terminal was opened with: a terminal keeps it for life. */
  protected readonly opened = new Map<string, string>();

  /**
   * Type `command` into the product's `kind` terminal, opened in `cwd` with
   * `env` if it has to be created. Returns once the text is sent.
   */
  async send(
    kind: ProductTerminalKind,
    product: string,
    cwd: string,
    command: string,
    env: Record<string, string> = {},
  ): Promise<void> {
    const id = productTerminalId(kind, product);
    let terminal = this.terminals.getById(id);
    // A terminal opened before the environment changed (protoc fetched, a tool
    // found) would build without it: open a new one instead of reusing it.
    const envKey = JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)));
    if (terminal !== undefined && !terminal.isDisposed && this.opened.has(id) && this.opened.get(id) !== envKey) {
      terminal.dispose();
      terminal = undefined;
    }
    const reused = terminal !== undefined && !terminal.isDisposed;
    if (terminal === undefined || terminal.isDisposed) {
      terminal = await this.terminals.newTerminal({
        id,
        title: `${kind === "build" ? "Build" : "Run"} ${product}`,
        cwd: FileUri.create(cwd),
        env,
        destroyTermOnClose: true,
      });
      await terminal.start();
      this.opened.set(id, envKey);
    }
    await this.terminals.open(terminal, { mode: "activate" });
    if (reused && kind === "run") terminal.sendText("\x03");
    terminal.sendText(`${command}\r`);
  }
}
