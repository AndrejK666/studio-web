import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev proxy: the backend (studio-backend) serves REST under /cf on :8090.
// In production the same /cf prefix is proxied by nginx (see nginx.conf).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/cf": {
        target: process.env.STUDIO_BACKEND_URL ?? "http://127.0.0.1:8090",
        changeOrigin: true,
      },
    },
  },
});
