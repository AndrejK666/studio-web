/* The Images stage's rows (owner feedback, 2026-11-24): one per image a
 * build made -- the application it is for, the image's name, its tag or
 * digest, where it lives, when it was built and whether it can run. What a
 * build recorded (`images`: app and reference) is joined with what Studio
 * recorded of the image in a registry (`/images`), where there is a record.
 *
 * A Research image's reference is `research-image/<bake>/<name>:<id>`
 * (environments/research_app.rs); a registry image's is
 * `host/path/name:tag` or `host/path/name@sha256:…`.
 *
 * Pure, so it is tested without a backend. */

import type { ProjectImage } from "../api/types";
import type { IdeBuild } from "@constructor-studio/mfe-shared";
import { recordFor, shortDigest } from "./images";

/** Whether an image can run: built and still there; being built; or not. A
 *  Research build that ended after it asked for its images leaves them
 *  `unconfirmed`: Research may have built them all, which only a deploy
 *  checks (deploy-only refuses until it has). */
export type ImageStatus = "ready" | "building" | "failed" | "unconfirmed" | "gone";

export interface ImageRow {
  /** The grid's row id: the application, unique within a build. */
  id: string;
  app: string;
  /** The image's name: its repository's path, without the host. */
  name: string;
  /** The tag, the digest, or Research's id, as written. */
  version: string;
  /** Short enough for a cell: a digest's first twelve, a long tag cut. */
  versionShort: string;
  /** The whole reference, as a deploy names it: what Copy copies. */
  reference: string;
  place: "research" | "registry";
  /** The registry's host; null for Research's own and for the default registry. */
  host: string | null;
  builtAt: string | null;
  status: ImageStatus;
}

const RESEARCH_PREFIX = "research-image/";

/** A reference's parts: name, version and host. */
export function parseImageRef(reference: string): { name: string; version: string; host: string | null; research: boolean } {
  if (reference.startsWith(RESEARCH_PREFIX)) {
    const rest = reference.slice(RESEARCH_PREFIX.length);
    const colon = rest.lastIndexOf(":");
    const repo = colon >= 0 ? rest.slice(0, colon) : rest;
    const name = repo.split("/").slice(1).join("/") || repo;
    return { name, version: colon >= 0 ? rest.slice(colon + 1) : "", host: null, research: true };
  }
  const at = reference.indexOf("@");
  let repo = at >= 0 ? reference.slice(0, at) : reference;
  let version = at >= 0 ? reference.slice(at + 1) : "";
  if (at < 0) {
    const colon = repo.lastIndexOf(":");
    // A colon after the last slash is a tag; before it, a host's port.
    if (colon > repo.lastIndexOf("/")) {
      version = repo.slice(colon + 1);
      repo = repo.slice(0, colon);
    }
  }
  const [head, ...path] = repo.split("/");
  const isHost = path.length > 0 && (head.includes(".") || head.includes(":") || head === "localhost");
  return { name: isHost ? path.join("/") : repo, version, host: isHost ? head : null, research: false };
}

/** A version short enough for a cell. */
export function shortVersion(version: string): string {
  if (/^sha256:/.test(version)) return shortDigest(version);
  return version.length > 16 ? `${version.slice(0, 12)}…` : version;
}

/** One build's images as rows. */
export function imageRows(build: IdeBuild, records: readonly ProjectImage[]): ImageRow[] {
  return build.images.map(({ app, image }) => {
    const ref = parseImageRef(image);
    const record = recordFor({ app, image }, records, build.buildId);
    const status: ImageStatus =
      record && (record.state === "deleted" || record.state === "missing")
        ? "gone"
        : build.status === "passed"
          ? "ready"
          : build.status === "running" || build.status === "queued"
            ? "building"
            : build.status === "failed" && build.where === "research"
              ? "unconfirmed"
              : "failed";
    const version = ref.version || record?.digest || "";
    return {
      id: app,
      app,
      name: ref.name,
      version,
      versionShort: shortVersion(version),
      reference: image,
      place: ref.research ? "research" : "registry",
      host: ref.host ?? record?.registry_host ?? null,
      builtAt: record?.pushed_at ?? (build.status === "passed" ? build.finishedAt : null),
      status,
    };
  });
}
