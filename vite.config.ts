import { defineConfig } from 'vite';

// `base: './'` keeps every asset path relative, so the build works from any
// sub-path (GitHub Pages project sites, a local file server, …).
export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 1000 },
  server: { host: '127.0.0.1', port: 8080 },
  preview: { host: '127.0.0.1', port: 8080 },
});
