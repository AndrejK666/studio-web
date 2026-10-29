// Constructor Studio: the product's description read from and saved to Studio
// (ADR-0053 §1, §2). The rules are `common/description-sync.ts`; this is
// where they meet the file system, the server and the person.
//
// When the desktop opens a product from Studio, the latest revision is written
// into the checkout at the product's path. From then on every change of the
// file -- a save in the editor, an Apply in Gearbox, which writes the file as
// before -- is handed to Studio as a new revision against the one the file was
// in step with. When somebody saved a newer one meanwhile, the person sees
// both texts and chooses. Builds report the revision the file is in step with.
//
// Only through the Studio extension's `ProductDescriptions`: in Gearbox
// Studio proper, and in a folder that is no Studio project, nothing here does
// anything.

import { Disposable, DisposableCollection } from "@theia/core/lib/common/disposable";
import { MessageService } from "@theia/core/lib/common/message-service";
import { ConfirmSaveDialog } from "@theia/core/lib/browser/dialogs";
import { URI } from "@theia/core/lib/common/uri";
import { inject, injectable, optional, preDestroy } from "@theia/core/shared/inversify";
import { FileService } from "@theia/filesystem/lib/browser/file-service";

import { type ConflictChoice, type InStep, afterSave, isChange, onConflict, onOpen } from "../../common/description-sync";
import { ProductDescriptions, type StudioDescriptionRevision } from "../../common/protocol";

/** How long a file is left to settle after a change before it is handed over. */
const SETTLE_MS = 800;

@injectable()
export class ProductDescriptionSync implements Disposable {
  @inject(FileService) protected readonly files!: FileService;
  @inject(MessageService) protected readonly messages!: MessageService;
  @inject(ProductDescriptions) @optional() protected readonly descriptions?: ProductDescriptions;

  /** Files opened from Studio, by URI string, and what each is in step with. */
  protected readonly tracked = new Map<string, InStep>();
  protected readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  protected readonly toDispose = new DisposableCollection();
  protected listening = false;

  /** The revision the product at `path` (absolute) is in step with, for a build's report. */
  revisionOf(path: string): number | undefined {
    return this.tracked.get(URI.fromFilePath(path).toString())?.revision;
  }

  /**
   * The product at `file` is opened from Studio: write the latest revision
   * into it when it differs, and hand every later change to Studio. Quietly
   * nothing without Studio, or for a project Studio keeps no description of
   * yet -- its first change then becomes revision 1.
   */
  async open(file: URI): Promise<void> {
    const descriptions = this.descriptions;
    if (descriptions === undefined) return;
    const path = file.path.fsPath();
    let latest: StudioDescriptionRevision | undefined;
    try {
      latest = await descriptions.latest(path);
    } catch (error) {
      console.warn("[gearbox] the description could not be read from Studio", error);
      return;
    }
    const current = await this.files
      .read(file)
      .then((c) => c.value)
      .catch(() => undefined);
    const step = onOpen(current, latest);
    // In step first, so the write below is not taken for a change.
    this.tracked.set(file.toString(), step.inStep);
    this.listen();
    if (step.write !== undefined) {
      await this.files.write(file, step.write);
      this.messages.info(`${file.path.base} now holds revision ${latest?.revision} of the product's description, from Studio.`);
    }
  }

  protected listen(): void {
    if (this.listening) return;
    this.listening = true;
    this.toDispose.push(
      this.files.onDidFilesChange((event) => {
        for (const key of this.tracked.keys()) {
          if (event.contains(new URI(key))) this.settle(key);
        }
      }),
    );
  }

  protected settle(key: string): void {
    const timer = this.timers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.handOver(key).catch((error) => console.warn("[gearbox] the description was not handed to Studio", error));
      }, SETTLE_MS),
    );
  }

  /** The file's text to Studio, as the next revision, when it changed. */
  protected async handOver(key: string, against?: number): Promise<void> {
    const descriptions = this.descriptions;
    const before = this.tracked.get(key);
    if (descriptions === undefined || before === undefined) return;
    const uri = new URI(key);
    const text = await this.files.read(uri).then((c) => c.value);
    if (against === undefined && !isChange(text, before)) return;
    const answer = await descriptions.save(uri.path.fsPath(), text, against ?? before.revision);
    if (answer.kind === "conflict") {
      await this.settleConflict(key, uri, answer.latest, before);
      return;
    }
    this.tracked.set(key, afterSave(text, answer, before));
  }

  protected async settleConflict(key: string, uri: URI, latest: StudioDescriptionRevision, before: InStep): Promise<void> {
    const choice = await this.ask(uri, latest, await this.files.read(uri).then((c) => c.value));
    const next = onConflict(choice, latest, before);
    if (next.write !== undefined) {
      this.tracked.set(key, next.inStep);
      await this.files.write(uri, next.write);
      return;
    }
    if (next.saveAgainst !== undefined) await this.handOver(key, next.saveAgainst);
  }

  /** Both texts, and the person's choice. */
  protected async ask(uri: URI, latest: StudioDescriptionRevision, mine: string): Promise<ConflictChoice> {
    const body = document.createElement("div");
    const intro = document.createElement("p");
    intro.textContent =
      `Studio has revision ${latest.revision} of this product's description` +
      `${latest.createdAt ? `, saved ${latest.createdAt}` : ""}, newer than the one ${uri.path.base} was opened at. ` +
      "Keep yours (it becomes the next revision), or take Studio's into the file.";
    body.appendChild(intro);
    const both = document.createElement("div");
    both.style.display = "grid";
    both.style.gridTemplateColumns = "1fr 1fr";
    both.style.gap = "8px";
    for (const [title, text] of [
      ["Yours", mine],
      [`Revision ${latest.revision} in Studio`, latest.text],
    ] as const) {
      const column = document.createElement("div");
      const heading = document.createElement("b");
      heading.textContent = title;
      const pre = document.createElement("pre");
      pre.style.maxHeight = "320px";
      pre.style.overflow = "auto";
      pre.textContent = text;
      column.append(heading, pre);
      both.appendChild(column);
    }
    body.appendChild(both);
    const answer = await new ConfirmSaveDialog({
      title: "The product's description changed in Studio",
      msg: body,
      save: "Keep mine",
      dontSave: "Take Studio's",
      cancel: "Decide later",
    }).open();
    return answer === true ? "mine" : answer === false ? "theirs" : "later";
  }

  @preDestroy()
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.toDispose.dispose();
  }
}
