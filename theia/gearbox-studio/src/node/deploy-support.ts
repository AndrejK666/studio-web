// Constructor Studio: what Deploy needs from the machine and the generated
// tree -- see `common/deploy-product.ts` for the rules. Runs on the IDE
// backend, where Deploy's terminal runs too.

import * as fs from "fs";
import * as path from "path";

import { parseBuildScript, type BuildScript, type DeployInfo } from "../common/deploy-product";
import { exec, type Exec } from "./run-support";

/** The chart folder under `helm/`: the one with a `Chart.yaml`. */
function chartOf(outRoot: string): string | undefined {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(outRoot, "helm"), { withFileTypes: true });
  } catch {
    return undefined;
  }
  const chart = entries.find((e) => e.isDirectory() && fs.existsSync(path.join(outRoot, "helm", e.name, "Chart.yaml")));
  return chart === undefined ? undefined : `helm/${chart.name}`;
}

export async function deployInfo(outRoot: string, run: Exec = exec): Promise<DeployInfo> {
  let script: BuildScript | undefined;
  try {
    script = parseBuildScript(await fs.promises.readFile(path.join(outRoot, "docker", "build.sh"), "utf8"));
  } catch {
    script = undefined;
  }
  const chart = chartOf(outRoot);
  const docker = (await run("docker", ["version", "--format", "{{.Server.Version}}"])).ok;
  const helm = await run("helm", ["version", "--short"]);
  const contexts = await run("kubectl", ["config", "get-contexts", "-o", "name"]);
  const current = contexts.ok ? await run("kubectl", ["config", "current-context"]) : undefined;
  const names = contexts.ok ? contexts.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "") : [];
  const currentName = current?.ok ? current.stdout.trim() : "";
  return {
    docker,
    ...(helm.ok ? { helm: helm.stdout.trim() } : {}),
    kubectl: contexts.ok,
    contexts: names,
    ...(currentName !== "" ? { currentContext: currentName } : {}),
    ...(script !== undefined ? { script } : {}),
    ...(chart !== undefined ? { chart } : {}),
  };
}
