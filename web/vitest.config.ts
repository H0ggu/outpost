import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'lpv-css': fileURLToPath(
        new URL('../node_modules/@lichess-org/pgn-viewer/dist/lichess-pgn-viewer.css', import.meta.url),
      ),
    },
  },
  test: {
    name: 'web',
    environment: 'happy-dom',
    include: ['test/**/*.test.{ts,tsx}'],
    css: false,
  },
});
