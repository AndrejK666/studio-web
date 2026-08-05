import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev proxy: the backend (studio-backend) serves REST under /cf on :8090.
// In production the same /cf prefix is proxied by nginx (see nginx.conf).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The repo lives on the Windows FS (/mnt/c) while vite runs in WSL:
    // inotify events don't cross that boundary, so file edits made on the
    // Windows side are never picked up and HMR silently serves stale code.
    // Polling trades a little CPU for reliable change detection.
    watch: {
      usePolling: true,
      interval: 400,
    },
    proxy: {
      "/cf": {
        target: process.env.STUDIO_BACKEND_URL ?? "http://127.0.0.1:8090",
        changeOrigin: true,
      },
    },
  },
});
