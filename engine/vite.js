// Vite plugin for pages that run the Silverstripe Playground engine (see index.js).
//
// - configures what @php-wasm needs: PHP 8.4 only (the other versions point to a stub, so their WebAssembly binaries
//   are not bundled), its data files as assets, ES module workers;
// - serves and emits the service worker as <base>sw.js;
// - serves and copies the site bundle (site.zip, manifest.json, _resources/ from bin/build-browser-bundle.mjs) as
//   <base>silverstripe/.

import { cpSync, createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchForWorkspaceRoot } from 'vite';

const OTHER_PHP_VERSIONS = ['8-5', '8-3', '8-2', '8-1', '8-0', '7-4', '5-2'];
const STUB = fileURLToPath(new URL('./php-version-stub.js', import.meta.url));
const SERVICE_WORKER = fileURLToPath(new URL('./sw.js', import.meta.url));
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

const TYPES = {
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.zip': 'application/zip',
};

/**
 * @param {object} options
 * @param {string} options.bundle The folder with the site bundle
 */
export default function silverstripePlayground({ bundle }) {
  const bundleDir = resolve(bundle);
  let config;

  return {
    name: 'silverstripe-playground',

    config: () => ({
      assetsInclude: [/\.dat$/, /\.so$/, /\.la$/],
      optimizeDeps: {
        // Imported as source: vite must see its workers and ?raw imports.
        exclude: ['silverstripe-playground', '@php-wasm/web', '@php-wasm/web-8-4'],
      },
      resolve: {
        alias: Object.fromEntries(OTHER_PHP_VERSIONS.map((version) => [`@php-wasm/web-${version}`, STUB])),
      },
      worker: { format: 'es' },
      build: { target: 'es2022' },
      // The engine may be a linked package outside the project (npm install ../silverstripe-playground).
      server: { fs: { allow: [searchForWorkspaceRoot(process.cwd()), PACKAGE_ROOT] } },
    }),

    configResolved(resolved) {
      config = resolved;
    },

    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        const base = config.base.startsWith('/') ? config.base : '/';

        if (path === `${base}sw.js`) {
          response.setHeader('Content-Type', 'text/javascript');
          response.end(readFileSync(SERVICE_WORKER));

          return;
        }

        if (path.startsWith(`${base}silverstripe/`)) {
          const file = join(bundleDir, path.slice(`${base}silverstripe/`.length));

          if (file.startsWith(bundleDir) && existsSync(file) && statSync(file).isFile()) {
            response.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
            createReadStream(file).pipe(response);

            return;
          }
        }

        next();
      });
    },

    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: readFileSync(SERVICE_WORKER, 'utf8') });
    },

    closeBundle() {
      if (config.command !== 'build') {
        return;
      }

      if (!existsSync(join(bundleDir, 'site.zip'))) {
        throw new Error(`No site bundle in ${bundleDir}: build it with "npm run bundle" in the playground repository`);
      }

      cpSync(bundleDir, join(resolve(config.root, config.build.outDir), 'silverstripe'), { recursive: true });
    },
  };
}
