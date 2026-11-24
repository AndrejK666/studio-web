/* The release map (owner feedback, 2026-11-24): Releases is four stages a
 * release goes through, left to right --
 *
 *   Build → Images → Environment → Deploy
 *
 * -- the product's sources made into a build; the images that build made and
 * where they live; the environment they are to run in; and the deploy of
 * those images there. Each stage has a state and a key fact, drawn as a node
 * of the map; picking a node shows that stage's detail under it.
 *
 * Which build's images and which environment the Images, Environment and
 * Deploy stages speak of are chosen on the page and kept in the address
 * (`rel.build`, `rel.env`), as is the stage shown (`rel.stage`). Without a
 * choice the page takes the release as it stands: the newest build whose
 * images can be deployed, and the environment deployed to last.
 *
 * Pure, so it is tested without a backend; the screen reads the facts and
 * draws them. */

import type { Deployment, DeployEnvironment } from "../api/types";
import { isLost, type IdeBuild } from "@constructor-studio/mfe-shared";
import { targetKindOf, type TargetKind } from "./environment-targets";
import { productUrls, promotionGap } from "./project-deploys";
import type { LadderStep } from "./releases";

export const STAGES = ["build", "images", "environment", "deploy"] as const;
export type StageId = (typeof STAGES)[number];

/** A stage's state as the map draws it: `blocked` is a stage that cannot go
 *  on as chosen (images the environment does not take, no product yet). */
export type StageState = "done" | "running" | "failed" | "blocked" | "todo";

export function isStage(v: unknown): v is StageId {
  return typeof v === "string" && (STAGES as readonly string[]).includes(v);
}

/** The builds the stages speak of: a product run is not a build. */
export function productBuilds(builds: readonly IdeBuild[]): IdeBuild[] {
  return builds.filter((b) => b.action !== "run");
}

/** Whether `build`'s images can go to `env`: a Research environment runs only
 *  images Research built -- a build that ended after it asked Research for
 *  them too, which Research's deploy-only route continues -- and a cluster
 *  one only a passed build with a published chart. */
export function imagesFit(build: Pick<IdeBuild, "where" | "status" | "images" | "chartRef" | "chartVersion">, env: Pick<DeployEnvironment, "kind">): boolean {
  if (targetKindOf(env) === "research") {
    return build.where === "research" && build.images.length > 0 && (build.status === "passed" || build.status === "failed");
  }
  return build.status === "passed" && !!build.chartRef && !!build.chartVersion;
}

/** Whether some kind of environment could take the build's images at all. */
export function hasDeployableImages(build: IdeBuild): boolean {
  return imagesFit(build, { kind: "research" }) || imagesFit(build, { kind: "kubernetes" });
}

/** Where a build's images live: Research's own registry, or the registry
 *  host its references (else its chart) name. */
export type ImagesPlace = { kind: "research" } | { kind: "registry"; host: string | null };

export function imagesPlace(build: Pick<IdeBuild, "where" | "images" | "chartRef">): ImagesPlace | null {
  if (build.where === "research") return build.images.length > 0 ? { kind: "research" } : null;
  const ref = build.images[0]?.image ?? build.chartRef?.replace(/^oci:\/\//, "") ?? null;
  if (!ref) return null;
  const head = ref.split("/")[0] ?? "";
  // `postgres:16` names no host: the default registry.
  return { kind: "registry", host: head.includes(".") || head.includes(":") || head === "localhost" ? head : null };
}

/** Why the chosen images cannot go to the chosen environment, as a code the
 *  screen words; `null` when they can. */
export type FitGap = "research_only" | "chart_only" | "promotion" | null;

export function fitGap(
  build: IdeBuild,
  env: DeployEnvironment,
  deployments: readonly Deployment[],
): { gap: FitGap; promotion: string | null } {
  if (!imagesFit(build, env)) return { gap: targetKindOf(env) === "research" ? "research_only" : "chart_only", promotion: null };
  const promotion = promotionGap(env, build, deployments, (id) => id);
  return promotion ? { gap: "promotion", promotion: env.promote_from ?? null } : { gap: null, promotion: null };
}

export interface MapInput {
  /** The product's builds, newest first. */
  builds: readonly IdeBuild[];
  /** The environments with what runs there (`ladderSteps`). */
  steps: readonly LadderStep[];
  deployments: readonly Deployment[];
  /** The build chosen in the address, by build id. */
  build?: string | null;
  /** The environment chosen in the address, by id. */
  environment?: string | null;
  /** The project has no product yet: nothing can be built. */
  productMissing?: boolean;
  /** When the screen last read: what "lost" is measured against. */
  now?: number;
}

export interface ReleaseMap {
  build: { state: StageState; current: IdeBuild | null };
  images: {
    state: StageState;
    /** The build whose images the next stages take. */
    build: IdeBuild | null;
    count: number;
    place: ImagesPlace | null;
    /** The environments those images can go to. */
    fits: DeployEnvironment[];
  };
  environment: {
    state: StageState;
    step: LadderStep | null;
    kind: TargetKind | null;
    gap: FitGap;
  };
  deploy: {
    state: StageState;
    /** The newest deploy to the chosen environment. */
    deployment: Deployment | null;
    url: string | null;
    /** Why it failed, in one line. */
    cause: string | null;
  };
}

const at = (b: IdeBuild) => b.finishedAt ?? b.startedAt ?? "";

/** A build's state as a stage's. */
export function buildState(b: IdeBuild | null, now = Date.now()): StageState {
  if (!b) return "todo";
  if (isLost(b, now)) return "failed";
  switch (b.status) {
    case "passed":
      return "done";
    case "running":
    case "queued":
      return "running";
    case "failed":
      return "failed";
    default:
      return "todo";
  }
}

/** A deploy's state as a stage's. */
export function deployState(d: Deployment | null): StageState {
  if (!d) return "todo";
  switch (d.state) {
    case "succeeded":
      return (d.action ?? "install") === "install" ? "done" : "todo";
    case "queued":
    case "running":
    case "awaiting_approval":
      return "running";
    case "failed":
    case "declined":
      return "failed";
    default:
      return "todo";
  }
}

/** A failed deploy's cause in one line: the first line its cause quotes
 *  from the log -- what actually went wrong, where the summary may only say
 *  "its log says why" -- without the log's timestamp; else the cause's
 *  summary, else its outcome's first line, else the reason it was declined. */
export function deployCause(d: Deployment): string | null {
  const line = (s: string | null | undefined) => s?.split("\n").find((l) => l.trim())?.trim() || null;
  const quoted = line(d.cause?.lines?.find((l) => l.trim()))?.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z?\s+/, "") || null;
  return quoted || d.cause?.summary?.trim() || line(d.outcome) || line(d.reason);
}

/** The build the Images stage opens on: the chosen one; else the newest
 *  passed build some environment takes; else the newest whose images may be
 *  deployed at all; else the newest build. */
export function imagesBuild(builds: readonly IdeBuild[], chosen?: string | null): IdeBuild | null {
  const picked = chosen ? builds.find((b) => b.buildId === chosen) : undefined;
  if (picked) return picked;
  const sorted = [...builds].sort((a, b) => at(b).localeCompare(at(a)));
  return (
    sorted.find((b) => b.status === "passed" && hasDeployableImages(b)) ??
    sorted.find(hasDeployableImages) ??
    builds[0] ??
    null
  );
}

/** The environment the Environment stage opens on: the chosen one; else the
 *  one deployed to last; else the one the build ran for; else the first. */
export function chosenStep(
  steps: readonly LadderStep[],
  deployments: readonly Deployment[],
  build: IdeBuild | null,
  chosen?: string | null,
): LadderStep | null {
  const byId = (id: string | null | undefined) => (id ? steps.find((s) => s.environment.id === id) : undefined);
  const last = [...deployments]
    .filter((d) => !d.preview)
    .sort((a, b) => b.requested_at.localeCompare(a.requested_at))
    .find((d) => byId(d.environment_id));
  return byId(chosen) ?? byId(last?.environment_id) ?? byId(build?.place?.environmentId) ?? steps[0] ?? null;
}

/** The four stages as they stand. */
export function releaseMap(input: MapInput): ReleaseMap {
  const now = input.now ?? Date.now();
  const builds = productBuilds(input.builds);
  const current = builds[0] ?? null;

  const buildStage: ReleaseMap["build"] = {
    state: input.productMissing ? "blocked" : buildState(current, now),
    current,
  };

  const imgBuild = imagesBuild(builds, input.build);
  const environments = input.steps.map((s) => s.environment);
  const fits = imgBuild ? environments.filter((e) => imagesFit(imgBuild, e)) : [];
  const deployable = !!imgBuild && hasDeployableImages(imgBuild);
  const imagesState: StageState = input.productMissing
    ? "todo"
    : !imgBuild
      ? "todo"
      : deployable
        ? imgBuild.status === "passed"
          ? "done"
          : "blocked"
        : buildState(imgBuild, now) === "running"
          ? "running"
          : buildState(imgBuild, now) === "failed"
            ? "failed"
            : "todo";

  const step = chosenStep(input.steps, input.deployments, imgBuild, input.environment);
  const gap = step && imgBuild && deployable ? fitGap(imgBuild, step.environment, input.deployments).gap : null;
  const envState: StageState = !step
    ? input.steps.length === 0
      ? "blocked"
      : "todo"
    : !imgBuild || !deployable
      ? "todo"
      : gap
        ? "blocked"
        : "done";

  const latest = step?.latest ?? null;
  return {
    build: buildStage,
    images: {
      state: imagesState,
      build: imgBuild,
      count: imgBuild?.images.length ?? 0,
      place: imgBuild ? imagesPlace(imgBuild) : null,
      fits,
    },
    environment: { state: envState, step, kind: step ? targetKindOf(step.environment) : null, gap },
    deploy: {
      state: deployState(latest),
      deployment: latest,
      url: latest && deployState(latest) === "done" ? (latest.public_url ?? productUrls(latest.outcome)[0] ?? null) : null,
      cause: latest && deployState(latest) === "failed" ? deployCause(latest) : null,
    },
  };
}

/** The stage the page opens on: the first that failed or runs, else Deploy;
 *  with no product yet, Build, which cannot start. */
export function attentionStage(map: ReleaseMap): StageId {
  if (map.build.state === "blocked") return "build";
  return STAGES.find((s) => map[s].state === "failed" || map[s].state === "running") ?? "deploy";
}

/* ── The address ─────────────────────────────────────────────────────────
 * `rel.stage`, `rel.build` and `rel.env` beside the shell's own entry, which
 * is kept byte for byte (the routing grammar splits on `;`, which
 * URLSearchParams would re-encode), as the lists keep theirs (listState.ts). */

export interface ReleaseAddress {
  stage: StageId | null;
  build: string | null;
  env: string | null;
}

const KEYS = { stage: "rel.stage", build: "rel.build", env: "rel.env" } as const;

function segmentKey(segment: string): string {
  const raw = segment.split("=")[0] ?? "";
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw;
  }
}

export function readReleaseAddress(search: string): ReleaseAddress {
  const params = new URLSearchParams(search);
  const stage = params.get(KEYS.stage);
  return {
    stage: isStage(stage) ? stage : null,
    build: params.get(KEYS.build) || null,
    env: params.get(KEYS.env) || null,
  };
}

/** `search` with the release's part replaced by `address`; what is not the
 *  release's is kept exactly as written, and nothing chosen writes nothing. */
export function writeReleaseAddress(search: string, address: ReleaseAddress): string {
  const ours = new Set<string>(Object.values(KEYS));
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const kept = raw.split("&").filter((s) => s !== "" && !ours.has(segmentKey(s)));
  const params = new URLSearchParams();
  if (address.stage) params.set(KEYS.stage, address.stage);
  if (address.build) params.set(KEYS.build, address.build);
  if (address.env) params.set(KEYS.env, address.env);
  const out = [...kept, params.toString()].filter((p) => p !== "").join("&");
  return out ? `?${out}` : "";
}
