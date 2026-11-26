import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * MapLibre 6 starts its worker from `maplibre-gl-worker.mjs` next to its own module.
 * In dev that works when the package isn't pre-bundled; for the production build the
 * worker and its shared chunk are copied to `dist/maplibre/` and main.ts points
 * MapLibre at them with `setWorkerUrl`.
 */
function maplibreWorker(): Plugin {
  return {
    name: 'copy-maplibre-worker',
    apply: 'build',
    closeBundle() {
      const out = resolve('dist/maplibre');
      mkdirSync(out, { recursive: true });
      for (const name of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) {
        copyFileSync(resolve('node_modules/maplibre-gl/dist', name), resolve(out, name));
      }
    },
  };
}

// `base: './'` keeps every asset path relative, so the build works from any
// sub-path (GitHub Pages project sites, a local file server, …).
export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 2500 },
  optimizeDeps: { exclude: ['maplibre-gl'] },
  plugins: [maplibreWorker()],
  server: { host: '127.0.0.1', port: 8080 },
  preview: { host: '127.0.0.1', port: 8080 },
});
