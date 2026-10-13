import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { deployInfo } from "./deploy-support";
import type { Exec, ExecResult } from "./run-support";

const ok = (stdout = ""): ExecResult => ({ ok: true, stdout, stderr: "" });
const fail = (): ExecResult => ({ ok: false, stdout: "", stderr: "not found" });

function fakeExec(answers: Record<string, ExecResult>): Exec {
  return async (file, args) => {
    const line = [file, ...args].join(" ");
    const key = Object.keys(answers).find((prefix) => line.startsWith(prefix));
    return key === undefined ? fail() : (answers[key] as ExecResult);
  };
}

describe("what Deploy finds", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gbx-deploy-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("reads the images from build.sh, the chart, and the kube contexts", async () => {
    fs.mkdirSync(path.join(root, "docker"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "docker", "build.sh"),
      `CONTEXT=$(CDPATH= cd -- "$SCRIPT_DIR/"'../..' && pwd)\nif [ "$#" -eq 0 ]; then\n  build_one api-gateway 'gbx-api-gateway:0.1.0'\n  exit 0\nfi\n`,
    );
    fs.mkdirSync(path.join(root, "helm", "shop"), { recursive: true });
    fs.writeFileSync(path.join(root, "helm", "shop", "Chart.yaml"), "name: shop\n");
    const info = await deployInfo(
      root,
      fakeExec({
        "docker version": ok("29.1"),
        "helm version": ok("v4.2.3+g43e8b7f\n"),
        "kubectl config get-contexts": ok("kind-local\r\ndev\r\n"),
        "kubectl config current-context": ok("kind-local\n"),
      }),
    );
    expect(info).toEqual({
      docker: true,
      helm: "v4.2.3+g43e8b7f",
      kubectl: true,
      contexts: ["kind-local", "dev"],
      currentContext: "kind-local",
      script: { contextFromDocker: "../..", images: [{ app: "api-gateway", image: "gbx-api-gateway:0.1.0" }] },
      chart: "helm/shop",
    });
  });

  it("says what is missing on a machine without helm or kubectl, for a tree without a chart", async () => {
    const info = await deployInfo(root, fakeExec({ "docker version": ok("29.1") }));
    expect(info).toEqual({ docker: true, kubectl: false, contexts: [] });
  });
});
