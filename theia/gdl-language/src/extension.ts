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

import { sourceRoots } from "./roots";

let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("GDL");
  context.subscriptions.push(output);
  await start(context, output);

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
