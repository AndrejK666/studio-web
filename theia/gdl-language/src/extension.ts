// The `.gdl` language client.
//
// Gearbox's engine is already a language server: `gearbox rpc --stdio` speaks
// LSP-framed JSON-RPC and answers `initialize`, `textDocument/didOpen|didChange`
// with `publishDiagnostics`, `completion` and `hover`. This extension adds
// nothing to what the engine says about a file; it only starts the engine and
// lets vscode-languageclient carry the protocol.
//
// It runs in the plugin host (node), not in the browser. Gearbox Studio keeps
// its client native because `monaco-languageclient` would load a second Monaco
// in the frontend; a VS Code extension never touches Monaco, so that reason
// does not apply here.

import * as vscode from "vscode";
import { LanguageClient, LanguageClientOptions, ServerOptions } from "vscode-languageclient/node";

import { type EngineDiagnostic, isProductFile, productFindings } from "./product-checks";
import { sourceRoots } from "./roots";

let client: LanguageClient | undefined;
// The second marker set: what the engine says about a product.gdl once the
// catalogue is in scope (see product-checks.ts). Owned apart from the language
// server's own diagnostics, so neither publication erases the other.
let findings: vscode.DiagnosticCollection | undefined;
// Which files each product's last check put findings on, so a re-check
// clears what it no longer reports.
const touched = new Map<string, string[]>();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("GDL");
  context.subscriptions.push(output);
  findings = vscode.languages.createDiagnosticCollection("gearbox");
  context.subscriptions.push(findings);
  await start(context, output);

  const check = (doc: vscode.TextDocument) => {
    if (doc.uri.scheme === "file" && isProductFile(doc.uri.fsPath)) void checkProduct(doc.uri, output);
  };
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(check),
    vscode.workspace.onDidSaveTextDocument(check),
    vscode.workspace.onDidCloseTextDocument((doc) => clearProduct(doc.uri.toString())),
  );
  vscode.workspace.textDocuments.forEach(check);

  context.subscriptions.push(
    vscode.commands.registerCommand("gearbox.gdl.restart", async () => {
      await stop();
      await start(context, output);
    }),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration("gearbox.gdl")) {
        await stop();
        await start(context, output);
      }
    }),
  );
}

export function deactivate(): Promise<void> {
  return stop();
}

async function start(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  const config = vscode.workspace.getConfiguration("gearbox.gdl");
  const engine = config.get<string>("enginePath") || "gearbox";
  const roots = await resolveRoots(config.get<string[]>("roots") ?? []);
  if (roots.length === 0) {
    output.appendLine("No gear.gdl in the workspace: the language server was not started.");
    return;
  }
  output.appendLine(`Starting ${engine} rpc --stdio for ${roots.join(", ")}`);

  const serverOptions: ServerOptions = {
    command: engine,
    args: ["rpc", "--stdio", ...roots.flatMap((root) => ["--root", root])],
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "gdl" }],
    outputChannel: output,
  };
  client = new LanguageClient("gearbox.gdl", "GDL", serverOptions, clientOptions);
  try {
    await client.start();
  } catch (error) {
    // A missing binary is the likely cause, and it is not worth a modal: the
    // highlighting still works, and the output channel says why the rest does not.
    output.appendLine(`The Gearbox engine did not start: ${String(error)}`);
    client = undefined;
  }
  context.subscriptions.push({ dispose: () => void stop() });
}

async function stop(): Promise<void> {
  const running = client;
  client = undefined;
  if (running) {
    await running.stop().catch(() => undefined);
  }
}

async function resolveRoots(configured: string[]): Promise<string[]> {
  if (configured.length > 0) {
    return configured;
  }
  const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  const found = await vscode.workspace.findFiles("**/gear.gdl", "**/{node_modules,target}/**");
  return sourceRoots(
    folders,
    found.map((uri) => uri.fsPath),
  );
}

/** Ask the engine about a product description as it is on disk, and show the
 *  answer. The engine reads the file itself, so this runs on open and on save,
 *  not per keystroke; the language server's own diagnostics cover typing. */
async function checkProduct(uri: vscode.Uri, output: vscode.OutputChannel): Promise<void> {
  const running = client;
  if (!running || !findings) return;
  try {
    const [validated, resolved] = await Promise.all([
      running.sendRequest<{ diagnostics?: EngineDiagnostic[] }>("gearbox/validate", { product: uri.fsPath }),
      running
        .sendRequest<{ diagnostics?: EngineDiagnostic[] }>("gearbox/product/resolve", { path: uri.fsPath })
        .catch((error: { data?: { diagnostics?: EngineDiagnostic[] } }) => ({ diagnostics: error?.data?.diagnostics })),
    ]);
    const found = productFindings(uri.toString(), validated?.diagnostics, resolved?.diagnostics);
    clearProduct(uri.toString());
    const byUri = new Map<string, vscode.Diagnostic[]>();
    for (const f of found) {
      const d = new vscode.Diagnostic(
        new vscode.Range(f.range.start.line, f.range.start.character, f.range.end.line, f.range.end.character),
        f.message,
        f.severity === "error"
          ? vscode.DiagnosticSeverity.Error
          : f.severity === "warning"
            ? vscode.DiagnosticSeverity.Warning
            : vscode.DiagnosticSeverity.Information,
      );
      d.code = f.code;
      d.source = "gearbox";
      byUri.set(f.uri, [...(byUri.get(f.uri) ?? []), d]);
    }
    for (const [target, list] of byUri) findings.set(vscode.Uri.parse(target), list);
    touched.set(uri.toString(), [...byUri.keys()]);
  } catch (error) {
    output.appendLine(`Checking ${uri.fsPath} against the catalogue failed: ${String(error)}`);
  }
}

function clearProduct(product: string): void {
  for (const target of touched.get(product) ?? []) findings?.delete(vscode.Uri.parse(target));
  touched.delete(product);
}
