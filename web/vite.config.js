import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// @php-wasm/web can load every PHP version; the playground ships PHP 8.4 only (see php-worker.js).
// The other versions point to a stub, so the build does not include their WebAssembly binaries.
const otherPhpVersions = ['8-5', '8-3', '8-2', '8-1', '8-0', '7-4', '5-2'];
const stub = fileURLToPath(new URL('./src/php-version-stub.js', import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // Relative URLs, so the playground also works in a subfolder (e.g. GitHub Pages).
  base: './',
  assetsInclude: [/\.dat$/, /\.so$/, /\.la$/],
  optimizeDeps: {
    exclude: ['@php-wasm/web', '@php-wasm/web-8-4'],
  },
  resolve: {
    alias: Object.fromEntries(otherPhpVersions.map((version) => [`@php-wasm/web-${version}`, stub])),
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    // Monaco (code-editor.js) is one large chunk, loaded only when the Code panel opens.
    chunkSizeWarningLimit: 3000,
  },
  server: {
    port: 5410,
  },
});
