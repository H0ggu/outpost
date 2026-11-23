/**
 * Vite 8 multi-page build (PLAN §1, §2):
 *   - index.html  → the React SPA (src/app/main.tsx)
 *   - studio.html → the vendored lila analysis board (src/studio/main.ts)
 * public/ (vendored Lichess assets under /lichess, manifest, icons) is copied as-is.
 *
 * Dev: `npm run dev` proxies /api and /assets/lifat to the Fastify server (OUTPOST_API_URL,
 * default http://localhost:8080) without changing the Host header, so the server's same-host
 * Origin check passes. Dev and preview send COOP/COEP like the server does, so stockfish-web
 * can use SharedArrayBuffer.
 */
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type ProxyOptions } from 'vite';

const API_TARGET = process.env.OUTPOST_API_URL ?? 'http://localhost:8080';

const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

const proxy: Record<string, ProxyOptions> = {
  '/api': { target: API_TARGET, changeOrigin: false },
  '/assets/lifat': { target: API_TARGET, changeOrigin: false },
};

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // pgn-viewer's exports map ("./*" → "./dist/*.js") hides its stylesheet; alias the file directly.
      { find: 'lpv-css', replacement: here('../node_modules/@lichess-org/pgn-viewer/dist/lichess-pgn-viewer.css') },
      // Studio imports vendored lila as `lila/<package>/<module>` → web/vendor/lila/<package>/src/<module>.
      // tsc maps the same specifier to hand-written declarations instead (tsconfig.studio.json, PLAN §1).
      { find: /^lila\/([^/]+)\/(.+)$/, replacement: `${here('./vendor/lila')}/$1/src/$2` },
    ],
  },
  server: {
    port: 5173,
    strictPort: true,
    headers: crossOriginIsolation,
    proxy,
  },
  preview: {
    port: 4173,
    strictPort: true,
    headers: crossOriginIsolation,
    proxy,
  },
  build: {
    // No source maps in the image (~2.5 MB, served publicly). Debug build: `npm run build -w @outpost/web -- --sourcemap`.
    sourcemap: false,
    chunkSizeWarningLimit: 1024,
    rolldownOptions: {
      input: {
        main: here('./index.html'),
        studio: here('./studio.html'),
      },
    },
  },
});
