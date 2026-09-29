/**
 * @jest-environment jsdom
 */
// Opening a product end to end against the REAL engine: the frontend's own
// stores and session over the backend's own `GearboxServiceImpl`, in one
// process. Runs only with GEARBOX_E2E_PRODUCT (a product.gdl) and GEARBOX_ENGINE
// set; skipped otherwise. The same flow against a fake engine is
// `open-product.test.ts`, which always runs.
import "reflect-metadata";

(globalThis as { DragEvent?: unknown }).DragEvent ??= class DragEvent {};
(document as unknown as { queryCommandSupported: () => boolean }).queryCommandSupported ??= () => false;
// The backend half runs in this jsdom process too, and its JSON-RPC wants Node's timers.
// eslint-disable-next-line @typescript-eslint/no-require-imports
Object.assign(globalThis, { setImmediate: require("timers").setImmediate, clearImmediate: require("timers").clearImmediate });
jest.mock("@theia/monaco/lib/browser/monaco-text-model-service", () => ({ MonacoTextModelService: class MonacoTextModelService {} }));
jest.mock("@theia/workspace/lib/browser/workspace-service", () => ({ WorkspaceService: class WorkspaceService {} }));
jest.mock("../reveal-service", () => ({ RevealService: class RevealService {} }));
jest.mock("./studio-context-service", () => ({ StudioContextService: class StudioContextService {} }));

import { Container } from "@theia/core/shared/inversify";
import { MessageService } from "@theia/core/lib/common/message-service";
import { StorageService } from "@theia/core/lib/browser/storage-service";
import { URI } from "@theia/core/lib/common/uri";
import { MonacoTextModelService } from "@theia/monaco/lib/browser/monaco-text-model-service";
import { WorkspaceService } from "@theia/workspace/lib/browser/workspace-service";
import { ILogger } from "@theia/core/lib/common/logger";

import { GearboxService } from "../../common/protocol";
import { GearboxServiceImpl } from "../../node/gearbox-service-impl";
import { CatalogueStore } from "../catalogue-store";
import { ProductStore } from "../product-store";
import { CommandRegistry } from "@theia/core/lib/common/command";
import { Event } from "@theia/core/lib/common/event";
import { Widget } from "@theia/core/shared/@lumino/widgets";
import { PendingCreateGear } from "../create/pending-create-gear";
import { GenerateService } from "../generate/generate-service";
import { ProductEditService } from "../product-edit-service";
import { ProductWidget } from "../product/product-widget";
import { RevealService } from "../reveal-service";
import { StudioContextService } from "./studio-context-service";
import { EngineConnectionService } from "./engine-connection-service";
import { GearSessionService } from "./gear-session-service";
import { ProductSessionService } from "./product-session-service";
import { SelectionService } from "./selection-service";

const PRODUCT = process.env.GEARBOX_E2E_PRODUCT;
const WORKSPACE = process.env.GEARBOX_E2E_WORKSPACE;
const run = PRODUCT !== undefined && PRODUCT !== "" && WORKSPACE !== undefined && WORKSPACE !== "" ? it : it.skip;

run("opens a real product to `ready`", async () => {
  const log = (...args: unknown[]): void => void process.stdout.write(`[${new Date().toISOString().slice(11, 23)}] ${args.join(" ")}\n`);
  const logger = { info: log, warn: log, error: log, debug: () => undefined } as unknown as ILogger;
  const backend = new GearboxServiceImpl();
  Object.assign(backend, { logger });
  // Every call the frontend makes, logged with how long it took, and given a
  // deadline: a phase that never answers says which one it is.
  const CALL_DEADLINE_MS = Number(process.env.GEARBOX_E2E_CALL_MS ?? 240000);
  const traced = new Proxy(backend, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (typeof value !== "function" || key === "setClient") return value;
      return (...args: unknown[]) => {
        const started = Date.now();
        const name = String(key);
        log(`-> ${name}`, JSON.stringify(args).slice(0, 120));
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${name} did not answer in ${CALL_DEADLINE_MS} ms`)), CALL_DEADLINE_MS);
        });
        const call = Promise.resolve((value as (...a: unknown[]) => unknown).apply(target, args));
        return Promise.race([call, deadline]).then(
          (result) => (clearTimeout(timer), log(`<- ${name} ${Date.now() - started} ms`), result),
          (error: unknown) => (clearTimeout(timer), log(`<- ${name} FAILED ${Date.now() - started} ms: ${String(error)}`), Promise.reject(error)),
        );
      };
    },
  });

  const root = URI.fromFilePath(WORKSPACE as string);
  const workspace = {
    ready: Promise.resolve(),
    workspace: { resource: root },
    tryGetRoots: () => [{ resource: root }],
    roots: Promise.resolve([{ resource: root }]),
  };
  const storage = new Map<string, unknown>();
  const container = new Container();
  container.bind(GearboxService).toConstantValue(traced);
  container.bind(WorkspaceService).toConstantValue(workspace as never);
  container.bind(MessageService).toConstantValue({ info: log, warn: log, error: log } as never);
  container.bind(MonacoTextModelService).toConstantValue({ models: [] } as never);
  container.bind(StorageService).toConstantValue({
    getData: async (key: string) => storage.get(key),
    setData: async (key: string, value: unknown) => void storage.set(key, value),
  } as never);
  container.bind(RevealService).toConstantValue(new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : () => undefined) }) as never);
  container.bind(StudioContextService).toConstantValue({ current: { kind: "home" } } as never);
  container.bind(CommandRegistry).toConstantValue({
    getCommand: () => undefined,
    isEnabled: () => false,
    onCommandsChanged: Event.None,
    executeCommand: async () => undefined,
  } as never);
  for (const cls of [
    SelectionService, EngineConnectionService, CatalogueStore, ProductStore, GearSessionService, ProductSessionService,
    ProductEditService, GenerateService, PendingCreateGear, ProductWidget,
  ]) {
    container.bind(cls as never).toSelf().inSingletonScope();
  }
  // The Product view, mounted as the app has it before a product is opened, so
  // it renders every state the store passes through. A render that throws
  // leaves React's last good DOM behind, which is a view stuck on a state the
  // store has left -- so errors are collected, and the DOM is read at the end.
  const errors: string[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" ").slice(0, 400));
    consoleError(...args);
  };
  const view = container.get(ProductWidget);
  (view as unknown as { scrollOptions: unknown }).scrollOptions = undefined;
  Widget.attach(view, document.body);
  const catalogue = container.get(CatalogueStore);
  backend.setClient(catalogue as never);
  // The catalogue's own progress, at most once a second: where an open's time goes.
  let lastCatalogueLog = 0;
  catalogue.onChanged(() => {
    const now = Date.now();
    const state = catalogue.current as unknown as { status: string; rows: Array<{ kind: string }> };
    if (now - lastCatalogueLog < 1000 && state.status !== "ready") return;
    lastCatalogueLog = now;
    const projected = state.rows.filter((row) => row.kind === "projected").length;
    log("catalogue:", state.status, `${state.rows.length} rows, ${projected} projected`);
  });
  const products = container.get(ProductStore);
  const session = container.get(ProductSessionService);
  session.onDidChangeOpening((state) => log("opening:", JSON.stringify(state).slice(0, 200)));
  products.onChanged(() => log("store:", products.current.status, products.current.open?.path ?? "-", products.current.error ?? ""));

  // As the app does: the catalogue's first load at start, then the Product view
  // asks for discovery, then the member opens the product.
  void catalogue.load();
  void products.ensureDiscovered();
  await new Promise((resolve) => setTimeout(resolve, 2000));
  // GEARBOX_E2E_OPEN_AFTER=ready: click only once the boot load has finished,
  // as a member does who opens a product a while after launch.
  for (let i = 0; process.env.GEARBOX_E2E_OPEN_AFTER === "ready" && i < 240 && catalogue.current.status === "loading"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const clicked = Date.now();
  const opened = await Promise.race([
    session.open({ path: PRODUCT as string, label: "shop" }),
    new Promise<boolean>((resolve) => setTimeout(() => (log("open: no answer in 240 s"), resolve(false)), 240000)),
  ]);
  log("open returned", opened, `after ${Date.now() - clicked} ms`);
  for (let i = 0; opened && i < 120 && products.current.status !== "ready" && products.current.status !== "error"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  log("final:", products.current.status, products.current.error ?? "");
  await new Promise((resolve) => setTimeout(resolve, 500));
  const text = view.node.textContent ?? "";
  log("view:", text.replace(/\s+/g, " ").slice(0, 300));
  log("render errors:", errors.length, errors.slice(0, 3).join(" || "));
  console.error = consoleError;
  // GEARBOX_E2E_REOPEN=1: close it and open it again in the same session, as
  // a member switching back to a product does.
  if (process.env.GEARBOX_E2E_REOPEN === "1" && opened) {
    await session.close();
    for (let i = 0; i < 240 && catalogue.current.status === "loading"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const again = Date.now();
    const reopened = await session.open({ path: PRODUCT as string, label: "shop" });
    log("reopen returned", reopened, `after ${Date.now() - again} ms`, products.current.status);
  }
  (backend as unknown as { disposeEngine(): void }).disposeEngine();
  expect(opened).toBe(true);
  expect(products.current.status).toBe("ready");
  expect(errors).toEqual([]);
  expect(text).not.toContain("Reading the description");
  expect(view.node.querySelector("[data-product-name]")?.getAttribute("data-product-name")).toBe("shop");
}, 300000);
