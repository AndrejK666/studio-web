// Constructor Studio: Deploy, under Generate's Apply, for a kubernetes
// profile -- in place of Build and Run, which start a process on this
// machine. Drawn from plain props, like the Run panel; the rules are in
// `common/deploy-product.ts`. Every step is a command typed into the Deploy
// terminal, and the one that reaches a cluster asks first.

import React from "@theia/core/shared/react";

import type { DeployImage } from "../../common/deploy-product";

export interface DeployPanelProps {
  /** Whether the generated tree is on disk (applied, or nothing left to write). */
  readonly generated: boolean;
  /** `undefined` while the backend is being asked. */
  readonly ready: boolean | undefined;
  readonly images: readonly DeployImage[];
  readonly chart: string | undefined;
  readonly registry: string | undefined;
  readonly namespace: string | undefined;
  readonly docker: boolean;
  readonly helm: string | undefined;
  readonly contexts: readonly string[];
  readonly context: string | undefined;
  readonly onContext: (context: string) => void;
  readonly onBuildImages: () => void;
  readonly onPush: () => void;
  readonly onTemplate: () => void;
  readonly onDeploy: () => void;
}

export function DeployPanel(props: DeployPanelProps): React.ReactElement {
  const { images } = props;
  return (
    <div className="gbx-generate-run" data-generate-deploy>
      <div className="gbx-group-label">Deploy</div>
      {!props.generated ? (
        <p className="gbx-waiting" data-deploy-state="not-generated">
          Apply writes the images&apos; Dockerfiles and the chart; Deploy works on them once they are on disk.
        </p>
      ) : props.ready === undefined ? (
        <p className="gbx-waiting" data-deploy-state="checking">
          Checking for docker, helm and kubectl…
        </p>
      ) : images.length === 0 || props.chart === undefined ? (
        <p className="gbx-inline-error" data-deploy-state="no-plan">
          The generated tree has no docker/build.sh or Helm chart to deploy: generate this kubernetes profile again.
        </p>
      ) : (
        <>
          <p data-deploy-images>
            Images: {images.map((image) => <code key={image.app}>{image.image}</code>).reduce<React.ReactNode[]>((all, one, i) => (i === 0 ? [one] : [...all, ", ", one]), [])}
            {props.registry ? (
              <>
                {" "}
                pushed to <code>{props.registry}</code>
              </>
            ) : (
              <> -- no image_registry in the profile, so they stay in this machine&apos;s Docker, which only a cluster sharing it can pull from</>
            )}
            . Chart <code>{props.chart}</code>
            {props.namespace ? (
              <>
                {" "}
                into namespace <code>{props.namespace}</code>
              </>
            ) : null}
            .
          </p>
          {!props.docker && (
            <p className="gbx-inline-error" data-deploy-missing="docker">
              docker does not answer on this machine: the images cannot be built here.
            </p>
          )}
          {props.helm === undefined && (
            <p className="gbx-inline-error" data-deploy-missing="helm">
              helm is not on this machine: install Helm to preview the manifests and deploy.{" "}
              <a href="https://helm.sh/docs/intro/install/" target="_blank" rel="noreferrer">
                helm.sh
              </a>
            </p>
          )}
          <div className="gbx-generate-actions" data-deploy-state="ready">
            <button type="button" className="gbx-start-primary" data-deploy-build disabled={!props.docker} onClick={props.onBuildImages}>
              Build images
            </button>
            <button type="button" className="gbx-choice" data-deploy-push disabled={!props.docker || !props.registry} onClick={props.onPush}
              title={props.registry ? `docker push to ${props.registry}` : "Set image_registry on the profile to push"}>
              Push
            </button>
            <button type="button" className="gbx-choice" data-deploy-template disabled={props.helm === undefined} onClick={props.onTemplate}>
              Preview manifests
            </button>
          </div>
          <div className="gbx-generate-actions">
            <label>
              Kube context{" "}
              <select data-deploy-context value={props.context ?? ""} onChange={(e) => props.onContext(e.target.value)} disabled={props.contexts.length === 0}>
                {props.contexts.length === 0 && <option value="">kubectl knows no context</option>}
                {props.contexts.map((context) => (
                  <option key={context} value={context}>
                    {context}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="gbx-start-primary" data-deploy-install disabled={props.helm === undefined || props.context === undefined}
              onClick={props.onDeploy} title="helm upgrade --install into the chosen cluster; asks first">
              Deploy
            </button>
          </div>
        </>
      )}
    </div>
  );
}
