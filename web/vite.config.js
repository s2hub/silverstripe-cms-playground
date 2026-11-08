import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import silverstripePlayground from '../engine/vite.js';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // Relative URLs, so the playground also works in a subfolder (e.g. GitHub Pages).
  base: './',
  plugins: [silverstripePlayground({ bundle: fileURLToPath(new URL('../build/bundle', import.meta.url)) })],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Monaco (code-editor.js) is one large chunk.
    chunkSizeWarningLimit: 3000,
  },
  server: {
    port: 5410,
  },
});
