import {
  defineConfig,
  loadEnv,
  type Plugin,
  type PreviewServer,
  type ProxyOptions,
  type ViteDevServer,
} from 'vite';
import react from '@vitejs/plugin-react';
import { federation } from '@module-federation/vite';
import path from 'path';
import { renderRuntimeEnv, resolveStand, standProxy, type Stand } from './scripts/lib/stands';

/**
 * The dev server stands in for the container (ADR-0031): what nginx and
 * `docker/10-runtime-env.sh` do for a deployed portal — carry the backend
 * paths to a backend, and tell the bundle which IdP to sign in against — Vite
 * does here for the stand `STUDIO_STAND` names (`scripts/lib/stands.ts`). The
 * proxy is `standProxy`; this plugin is the `/env.js`, served ahead of the
 * placeholder in `public/env.js` — which stays, for `vite build`.
 *
 * `vite preview` gets both as well: Vite resolves it as `serve` and hands it
 * `server.proxy`, so a built bundle previewed here faces the same stand the
 * dev server would, with the issuer to match rather than the placeholder's
 * none.
 */
function standRuntimeEnv(stand: Stand, shadowed: string[]): Plugin {
  const serve = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use('/env.js', (_req, res) => {
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(renderRuntimeEnv(stand));
    });
    const printUrls = server.printUrls.bind(server);
    server.printUrls = () => {
      printUrls();
      server.config.logger.info(`  ➜  Stand:   ${stand.name} → ${stand.url} (issuer ${stand.issuer})`);
      if (shadowed.length) {
        server.config.logger.warn(
          `  ➜  ${shadowed.join(', ')} set but not read: /env.js carries the stand's issuer and client id`,
        );
      }
    };
  };
  return { name: 'studio-stand-runtime-env', apply: 'serve', configureServer: serve, configurePreviewServer: serve };
}

/**
 * A local gears-matcher service for the project's Gears section, in development only.
 *
 * The matcher is reached with a shared secret and has no ingress, so a browser cannot call it. Until
 * the backend has a route that does (ADR-0071), this carries `/gears-matcher/*` to the service the
 * developer runs, and adds the secret here, so it never reaches the bundle. Both variables must be
 * set (shell, `.env` or `.env.local`): `GEARS_MATCHER_URL=http://127.0.0.1:8099` and
 * `GEARS_MATCHER_SECRET=...`. Without them the section says the matcher cannot be reached.
 */
function gearsMatcherProxy(env: Record<string, string>): Record<string, ProxyOptions> {
  const target = env.GEARS_MATCHER_URL?.trim();
  const secret = env.GEARS_MATCHER_SECRET?.trim();
  if (!target || !secret) return {};
  return {
    '/gears-matcher': {
      target,
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/gears-matcher/, ''),
      headers: { Authorization: `Bearer ${secret}` },
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(({ command, mode }) => {
  // STUDIO_* from the shell and from .env / .env.local; `envPrefix` stays
  // VITE_, so none of it reaches the bundle. A server has a stand — the dev
  // server, and preview; a build is pointed at one by the container it ends
  // up in. A VITE_OIDC_* value would reach the bundle only to be shadowed by
  // /env.js, so the server says when it sees one.
  const stand = command === 'serve' ? resolveStand(loadEnv(mode, __dirname, 'STUDIO_')) : null;
  const shadowed = stand ? Object.keys(loadEnv(mode, __dirname, 'VITE_OIDC_')) : [];

  return {
    server: {
      port: 5173,
      proxy: {
        ...(stand ? standProxy(stand) : {}),
        ...(command === 'serve'
          ? gearsMatcherProxy(loadEnv(mode, __dirname, 'GEARS_MATCHER_'))
          : {}),
      },
    },
    plugins: [
      react(),
      ...(stand ? [standRuntimeEnv(stand, shadowed)] : []),
      federation({
        name: 'host',
        shared: {
          react: { singleton: true, requiredVersion: '^19.0.0' },
          'react-dom': { singleton: true, requiredVersion: '^19.0.0' },
          // Same React Query instance as the host when remotes use federation scope;
          // separately mounted MFEs still receive the host QueryClient via runtime mount context.
          '@tanstack/react-query': {
            singleton: true,
            requiredVersion: '^5.90.0',
          },
        },
      }),
    ],
    resolve: {
      alias: [
        { find: '@', replacement: path.resolve(__dirname, './src-app') },
        // Every entry of use-sync-external-store (shim, with-selector, both)
        // is served by ESM on React 19's own hook. Bundled as CommonJS it
        // blanks the portal; see src-app/app/lib/syncExternalStore.ts.
        {
          find: /^use-sync-external-store(\/shim)?(\/index|\/with-selector)?(\.js)?$/,
          replacement: path.resolve(__dirname, './src-app/app/lib/syncExternalStore.ts'),
        },
      ],
      dedupe: ['@gears-frontx/api', '@gears-frontx/framework', '@gears-frontx/react'],
    },
    optimizeDeps: {
      include: ['react', 'react-dom', 'react/jsx-runtime', '@globaltypesystem/gts-ts'],
    },
    build: {
      target: 'esnext',
      // No manualChunks: @module-federation/vite ignores them in a federated
      // build ("conflicts with module federation"), so the chunks are its own.
      // Increase chunk size warning limit or disable it
      chunkSizeWarningLimit: 500,
    },
  };
});
