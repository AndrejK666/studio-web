// Constructor Studio: deploying a generated `kubernetes` product from the
// desktop -- the rules, shared by the Generate view and the IDE backend.
//
// Generate writes, for a kubernetes profile, a Dockerfile per application
// under `docker/<app>/`, `docker/build.sh` that builds them, and a Helm chart
// under `helm/<product>/` with a subchart per application. What it leaves to
// the person is getting the images where the cluster can pull them and
// installing the chart. Deploy does that in a terminal, a step at a time, so
// every command is visible and nothing reaches a cluster without a click:
//
//   1. Build images: `docker build` per application, as `build.sh` would --
//      run directly rather than through `sh`, which a Windows desktop lacks.
//   2. Push: only with the profile's `image_registry`; without one the images
//      stay in the local Docker, which a cluster sharing it can use.
//   3. Preview manifests: `helm template`, no cluster needed.
//   4. Deploy: `helm upgrade --install` into the chosen kube context.
//
// The image names, tags and build context are read from `build.sh`, the
// engine's own answer, not re-derived here.

/** One application's image, as `docker/build.sh` builds it. */
export interface DeployImage {
  readonly app: string;
  /** `repository:tag`, as generated (no registry). */
  readonly image: string;
}

/** What `docker/build.sh` says: the build context and the images. */
export interface BuildScript {
  /** The context, relative to the `docker/` folder. */
  readonly contextFromDocker: string;
  readonly images: readonly DeployImage[];
}

/**
 * Read `docker/build.sh`: the `CONTEXT=...` line and the `build_one <app>
 * '<image>'` calls of its build-everything branch. `undefined` when the script
 * is not the shape the engine writes.
 */
export function parseBuildScript(text: string): BuildScript | undefined {
  const context = /CONTEXT=\$\(CDPATH= cd -- "\$SCRIPT_DIR\/"'([^']*)' && pwd\)/.exec(text)?.[1];
  if (context === undefined) return undefined;
  const all = /if \[ "\$#" -eq 0 \]; then([\s\S]*?)exit 0/.exec(text)?.[1] ?? "";
  const images = [...all.matchAll(/build_one\s+([A-Za-z0-9_-]+)\s+'([^']+)'/g)].map((m) => ({
    app: m[1] as string,
    image: m[2] as string,
  }));
  return images.length === 0 ? undefined : { contextFromDocker: context, images };
}

/** `repository:tag` split at the tag's colon, not a registry's port. */
export function splitImage(image: string): { repository: string; tag: string | undefined } {
  const at = image.lastIndexOf(":");
  if (at < 0 || image.indexOf("/", at) >= 0) return { repository: image, tag: undefined };
  return { repository: image.slice(0, at), tag: image.slice(at + 1) };
}

/** The image under the profile's registry, or as generated when there is none. */
export function registryImage(image: string, registry: string | undefined | null): string {
  const prefix = (registry ?? "").trim().replace(/\/+$/, "");
  return prefix === "" ? image : `${prefix}/${image}`;
}

/** What Deploy can use here, and the generated tree's plan. */
export interface DeployInfo {
  readonly docker: boolean;
  /** `helm version --short`, when helm answers. */
  readonly helm?: string;
  readonly kubectl: boolean;
  /** The kube contexts kubectl knows, and the current one. */
  readonly contexts: readonly string[];
  readonly currentContext?: string;
  /** From `docker/build.sh`; `undefined` when the tree has none (not a kubernetes profile, or not generated). */
  readonly script?: BuildScript;
  /** The chart, relative to the tree (`helm/<product>`). */
  readonly chart?: string;
}

export interface DeployInput {
  /** Absolute: the generated tree. */
  readonly outRoot: string;
  readonly script: BuildScript;
  /** The chart, relative to `outRoot` (`helm/<product>`). */
  readonly chart: string;
  /** The Helm release name: the product id. */
  readonly release: string;
  readonly namespace: string | undefined;
  readonly registry: string | undefined | null;
  /** The kube context; `undefined` for `helm template`. */
  readonly kubeContext?: string;
}

const q = (value: string): string => `"${value.replace(/"/g, '\\"')}"`;

function join(...parts: string[]): string {
  return parts.join("/").replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

function setImages(input: DeployInput): string[] {
  if ((input.registry ?? "").trim() === "") return [];
  return input.script.images.map(
    (image) => `--set ${image.app}.image.repository=${splitImage(registryImage(image.image, input.registry)).repository}`,
  );
}

/** The commands, in the order Deploy runs them, each one line for a terminal. */
export function deployCommands(input: DeployInput): {
  readonly build: readonly string[];
  readonly push: readonly string[];
  readonly template: string;
  readonly install: string | undefined;
} {
  const docker = join(input.outRoot, "docker");
  const context = join(docker, input.script.contextFromDocker);
  const build = input.script.images.map((image) =>
    [
      "docker build",
      `--ignorefile ${q(join(docker, ".dockerignore"))}`,
      `-f ${q(join(docker, image.app, "Dockerfile"))}`,
      `-t ${registryImage(image.image, input.registry)}`,
      q(context),
    ].join(" "),
  );
  const push =
    (input.registry ?? "").trim() === "" ? [] : input.script.images.map((image) => `docker push ${registryImage(image.image, input.registry)}`);
  const chart = q(join(input.outRoot, input.chart));
  const namespace = input.namespace?.trim() ? [`--namespace ${input.namespace.trim()}`] : [];
  const template = ["helm template", input.release, chart, ...namespace, ...setImages(input)].join(" ");
  const install =
    input.kubeContext === undefined
      ? undefined
      : [
          "helm upgrade --install",
          input.release,
          chart,
          ...namespace,
          ...(namespace.length > 0 ? ["--create-namespace"] : []),
          `--kube-context ${input.kubeContext}`,
          ...setImages(input),
        ].join(" ");
  return { build, push, template, install };
}
