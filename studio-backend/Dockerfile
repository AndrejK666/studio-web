# Runtime image for the Studio backend.
# The binary is built in CI (release.yml, backend-binary job) and placed at
# .release/studio-backend before `docker build` — compiling the gears
# dependency tree inside this Dockerfile would make every image build pay for
# it (Dockerfile.src does that, for the one-click compose path).
# trixie, not bookworm: the binary is built on the ubuntu-24.04 runner
# (glibc 2.39) and bookworm's glibc 2.36 cannot load it — the container
# died at start with "version GLIBC_2.39 not found". trixie ships 2.41;
# keep this base and release.yml's backend-binary runner in step.
# ONNX Runtime for the graph-storage gear's in-process embedding provider
# (`ort` is pinned `load-dynamic`; the library is dlopen'ed from ORT_DYLIB_PATH).
# Same version and checksum as Dockerfile.src. The
# model artifacts are deployment data, not image content: the Helm chart's
# init container fetches them into an emptyDir (see deploy/helm).
FROM debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132 AS onnxruntime
# The GitHub release (microsoft/onnxruntime) is gone — the repository answers
# 404, which broke every image build. Microsoft's NuGet package of the same
# version carries the same build: its runtimes/linux-x64/native/libonnxruntime.so
# is byte-identical (sha256 5715f06d…) to the one the 1.29.0 tarball shipped.
ARG ONNXRUNTIME_VERSION=1.29.0
ARG ONNXRUNTIME_SHA256=4557021fec4da3924e2e12ff44b1cc50b176de0d2c5c7daa89ab11c208b3a454
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/* \
 && curl -sSL --fail -o /tmp/onnxruntime.nupkg \
      "https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/${ONNXRUNTIME_VERSION}/microsoft.ml.onnxruntime.${ONNXRUNTIME_VERSION}.nupkg" \
 && echo "${ONNXRUNTIME_SHA256}  /tmp/onnxruntime.nupkg" | sha256sum --check \
 && mkdir -p /opt/onnxruntime/lib \
 && unzip -j /tmp/onnxruntime.nupkg runtimes/linux-x64/native/libonnxruntime.so -d /opt/onnxruntime/lib \
 && ln -s libonnxruntime.so /opt/onnxruntime/lib/libonnxruntime.so.1 \
 && rm /tmp/onnxruntime.nupkg

# Helm, for deploys to an organization's environments (environments/deploy.rs,
# ADR-0043): the server installs a product's generated chart with the
# environment's connection, so a member's machine never holds a cluster
# credential. Pinned with the checksum get.helm.sh publishes next to it.
FROM debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132 AS helm
ARG HELM_VERSION=v3.18.4
ARG HELM_SHA256=f8180838c23d7c7d797b208861fecb591d9ce1690d8704ed1e4cb8e2add966c1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && curl -sSL --fail -o /tmp/helm.tgz "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz" \
 && echo "${HELM_SHA256}  /tmp/helm.tgz" | sha256sum --check \
 && tar xzf /tmp/helm.tgz -C /tmp linux-amd64/helm \
 && install -m 0755 /tmp/linux-amd64/helm /usr/local/bin/helm \
 && rm -rf /tmp/helm.tgz /tmp/linux-amd64

# The Gearbox engine behind the gear catalogue and product previews
# (product/gearbox.rs), downloaded from the same constructorfabric/gearbox
# release as Dockerfile.src and the session image's `gearbox` stage
# (theia/Dockerfile), which the desktop build reads too: the portal, the IDE
# and the desktop must say the same thing about the same product.gdl, so move
# all three together. theia/Dockerfile says why it is a release and not a
# build. The archive is checked against the SHA-256 from the release's
# SHA256SUMS; the binary is built for glibc 2.35 and runs on the runtime below.
FROM debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132 AS gearbox
# Until constructorfabric/gearbox#17 (GDL 1.5, `frontend = frontx_product(...)`)
# merges, the engine is the snapshot of that PR's branch on its author's fork;
# move back to a constructorfabric/gearbox release once it does.
# Every STUDIO_GEARBOX_* value below is platform-release.toml's (ADR-0075),
# written by `node scripts/platform-release.mjs --write`; do not edit them here.
ARG STUDIO_GEARBOX_REPO=https://github.com/AndrejK666/gearbox
ARG STUDIO_GEARBOX_RELEASE=snapshot-82b909a
ARG STUDIO_GEARBOX_VERSION=0.1.0-82b909a
ARG STUDIO_GEARBOX_REF=82b909a1f3f087029432edfb02eb39a0018f4bf3
ARG STUDIO_GEARBOX_SHA256=449feec2e799e2ceb671383dbfb49ae18caa97bc7d52445342c4b24c6b0ca3cd
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && name="gearbox-${STUDIO_GEARBOX_VERSION}-x86_64-unknown-linux-gnu" \
 && curl -sSL --fail -o /tmp/gearbox.tar.gz \
      "${STUDIO_GEARBOX_REPO}/releases/download/${STUDIO_GEARBOX_RELEASE}/${name}.tar.gz" \
 && echo "${STUDIO_GEARBOX_SHA256}  /tmp/gearbox.tar.gz" | sha256sum --check \
 && tar xzf /tmp/gearbox.tar.gz -C /tmp \
 && install -m 0755 "/tmp/${name}/gearbox" /usr/local/bin/gearbox \
 && mkdir -p /usr/local/share/gearbox \
 && echo "${STUDIO_GEARBOX_REF}" > /usr/local/share/gearbox/REVISION \
 && rm -rf /tmp/gearbox.tar.gz "/tmp/${name}" \
 && gearbox --version

# What both the server and the builder below run on.
# git: the artifact-ingest gear shells out to it to clone repositories into
# STUDIO_ARTIFACT_WORKDIR and walk their files — the same reason Dockerfile.src
# installs it. Without it a sync in the cluster falls back to the connector's
# tree API, so File nodes carry paths and sizes but no content, and everything
# built on document text (the Specs tab) has nothing to read. A build's
# `prepare` step clones with it too.
FROM debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132 AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 1000 studio \
 && useradd --system --uid 1000 --gid 1000 --home /app studio

# `--target builder`: the image a build Job's `prepare` and `publish` steps run
# in (ADR-0048 §9, STUDIO_BUILDER_IMAGE). The same binary as the server, with
# what those two steps call -- git, the Gearbox engine, helm -- and nothing the
# server alone needs (its config, ONNX Runtime). It runs as uid 1000 from its
# first instruction: the Job's pod is `runAsNonRoot` with every capability
# dropped, so an image that starts as root and switches user (the stand's
# Dockerfile.src, through gosu) fails there with "operation not permitted".
# Checked by scripts/check-builder-image.sh.
FROM base AS builder
WORKDIR /app
COPY .release/studio-backend /app/studio-backend
COPY --from=gearbox /usr/local/bin/gearbox /usr/local/bin/gearbox
COPY --from=gearbox /usr/local/share/gearbox/REVISION /usr/local/share/gearbox/REVISION
COPY --from=helm /usr/local/bin/helm /usr/local/bin/helm
ENV STUDIO_GEARBOX_REPO=https://github.com/AndrejK666/gearbox \
    STUDIO_GEARBOX_FRONTX=1
RUN chmod +x /app/studio-backend && chown -R studio:studio /app
USER 1000
ENTRYPOINT ["/app/studio-backend"]
CMD ["--help"]

# The server: the default target, so it stays the last stage.
FROM base AS server

WORKDIR /app
COPY .release/studio-backend /app/studio-backend
COPY config/ /app/config/
COPY --from=onnxruntime /opt/onnxruntime/lib/libonnxruntime.so* /opt/onnxruntime/lib/
# Inert until STUDIO_GEARBOX_WORKDIR is set (the chart's backend.gearbox).
COPY --from=gearbox /usr/local/bin/gearbox /usr/local/bin/gearbox
# Its commit, which `gearbox --version` does not say (studio-product reads it).
COPY --from=gearbox /usr/local/share/gearbox/REVISION /usr/local/share/gearbox/REVISION
# The engine above reads GDL 1.5, and pipelines install it from the same repository.
ENV STUDIO_GEARBOX_REPO=https://github.com/AndrejK666/gearbox \
    STUDIO_GEARBOX_FRONTX=1
COPY --from=helm /usr/local/bin/helm /usr/local/bin/helm
ENV ORT_DYLIB_PATH=/opt/onnxruntime/lib/libonnxruntime.so
RUN chmod +x /app/studio-backend && chown -R studio:studio /app
# The builder CI published from the same commit, by digest
# (`…/studio-builder@sha256:…`, ADR-0062 §1): what a build runs in when the
# deploy names none (STUDIO_BUILDER_IMAGE). Empty in a local build, which then
# refuses builds with BUILDER_NOT_PINNED until one is named. Declared last so
# a new digest invalidates no layer above.
ARG STUDIO_BUILDER_IMAGE_BUILT=""
ENV STUDIO_BUILDER_IMAGE_BUILT=${STUDIO_BUILDER_IMAGE_BUILT}

# Numeric on purpose: with `runAsNonRoot: true` the kubelet must prove the
# container is non-root BEFORE starting it, and a named USER gives it nothing
# to verify — the pod dies with "image has non-numeric user (studio)".
# 1000 matches Dockerfile.src and the `node` uid in the Theia session image,
# so files this server creates stay writable across the stack.
USER 1000
EXPOSE 8090
# home_dir (SQLite/logs) lives under /app; mount a volume or use the postgres profile.
# Override APP__* env vars or mount your own config for real deployments.
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD curl -sf http://127.0.0.1:8090/healthz || exit 1

ENTRYPOINT ["/app/studio-backend"]
CMD ["--config", "/app/config/dev.yaml", "run"]
