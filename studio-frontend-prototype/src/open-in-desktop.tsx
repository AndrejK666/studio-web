// "Open in desktop": the project, in the desktop Studio the member has
// installed (ADR-0027 §6).
//
// The link names this Studio and the project, and carries no token -- the app
// signs the member in itself and clones through Studio, as a click in its own
// Studio view does. The Studio is named by this portal's address and by the
// realm it signs in with: the desktop's list may know this Studio by another
// address, and the realm is what the two agree on.
//
// A browser cannot ask whether an app is installed. So the button is always
// offered, and when the page keeps the focus after the click -- nothing took
// the link -- it says where the app comes from.
import { useEffect, useRef, useState } from "react";
import { env } from "./env";

/** Where the desktop installer is published: the workflow that builds it. */
export const DESKTOP_DOWNLOAD_URL =
  "https://github.com/constructorfabric/studio-web/actions/workflows/desktop-windows.yml";

/** The link the desktop app opens a project with. Mirrors
 *  `theia/studio/src/common/desktop-link.ts`, which reads it. */
export function desktopLink(project: { id: string; name?: string }): string {
  const params = new URLSearchParams();
  params.set("studio", window.location.origin);
  if (env.oidcIssuer) params.set("issuer", env.oidcIssuer.replace(/\/+$/, ""));
  params.set("project", project.id);
  if (project.name) params.set("name", project.name);
  return `cfstudio://open?${params.toString()}`;
}

/** How long to wait for the app to take the focus before saying it may be missing. */
const NO_APP_AFTER_MS = 1500;

export function OpenInDesktop({ project }: { project: { id: string; name: string } }) {
  const [missing, setMissing] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const open = () => {
    setMissing(false);
    window.clearTimeout(timer.current);
    // The app taking the link takes the focus from the page.
    const taken = () => window.clearTimeout(timer.current);
    window.addEventListener("blur", taken, { once: true });
    timer.current = window.setTimeout(() => {
      window.removeEventListener("blur", taken);
      setMissing(true);
    }, NO_APP_AFTER_MS);
    window.location.href = desktopLink(project);
  };

  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 4 }}>
      <button
        type="button"
        onClick={open}
        title="Open this project in the Constructor Studio app on your machine: it signs you in, clones the sources and opens them"
      >
        Open in desktop
      </button>
      {missing && (
        <span className="hint" style={{ fontSize: 12 }}>
          Nothing opened? Install the desktop app —{" "}
          <a href={DESKTOP_DOWNLOAD_URL} target="_blank" rel="noreferrer">
            get Constructor Studio for Windows
          </a>
          , then try again.
        </span>
      )}
    </span>
  );
}
