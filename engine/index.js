// The Silverstripe Playground engine: Silverstripe CMS in PHP compiled to WebAssembly, in a worker of this page
// (php-worker.js), with a service worker (sw.js) that sends the requests of the site's iframe to it.
//
// A page that uses it needs the Vite plugin (vite.js), which serves the service worker and the site bundle next to
// the page. The parts of the user interface are separate modules: code-editor.js (Monaco: large, import it when
// needed), preview.js, splitter.js, and the whole playground app in app.js.

export { createPreview } from './preview.js';
export { createSplitter } from './splitter.js';
export { deleteSite, freeSlug, isSiteOpen, listSites, renameSite } from './storage.js';

/**
 * The newest service worker: after a new deploy, the previous one would not know the bundle's URLs.
 */
async function newestServiceWorker(registration) {
  await registration.update().catch(() => {});

  const installing = registration.installing ?? registration.waiting;

  if (installing) {
    await new Promise((resolve) => {
      installing.addEventListener('statechange', () => ['activated', 'redundant'].includes(installing.state) && resolve());
    });
  }

  await navigator.serviceWorker.ready;
}

/**
 * @param {object} [options]
 * @param {string} [options.base] URL of the folder with sw.js and silverstripe/ (default: the page's folder)
 * @param {(message: string, fraction?: number) => void} [options.onProgress] Messages while the playground starts,
 *   with how far it is (0 to 1) where known
 */
export function createPlayground({ base = new URL('./', location.href).href, onProgress = () => {} } = {}) {
  let worker = null;
  let serviceWorker = null;
  const pending = new Map();
  let nextId = 1;

  function startWorker() {
    worker?.terminate();
    worker = new Worker(new URL('./php-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        onProgress(data.message, data.fraction);
      } else if (data.type === 'result' && pending.has(data.id)) {
        const { resolve, reject } = pending.get(data.id);

        pending.delete(data.id);
        data.error ? reject(new Error(data.error)) : resolve(data.value);
      }
    };
    worker.onerror = (event) => {
      for (const { reject } of pending.values()) {
        reject(new Error(event.message || 'The PHP worker failed'));
      }

      pending.clear();
    };
  }

  const playground = {
    /** The state of the running site (from boot()): siteUrl, site, username, password, manifest, timings, … */
    info: null,

    /**
     * Sends an action to the PHP worker and waits for its result (see php-worker.js for the actions).
     */
    call(type, payload = {}, transfer = []) {
      const id = nextId++;

      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ type, id, ...payload }, transfer);
      });
    },

    /**
     * Starts Silverstripe in a new PHP worker: from the bundle, or a saved site.
     *
     * @param {object} [options]
     * @param {string} [options.site]   Slug of a saved site to open
     * @param {boolean} [options.login] Log in as the admin (default)
     */
    async boot(options = {}) {
      if (!('serviceWorker' in navigator)) {
        throw new Error('This browser does not support service workers (they need HTTPS or localhost).');
      }

      if (!serviceWorker) {
        onProgress('Starting the service worker');

        const scope = new URL(base).pathname;

        serviceWorker = newestServiceWorker(await navigator.serviceWorker.register(new URL('sw.js', base), { scope }));
      }

      await serviceWorker;
      startWorker();

      const scope = `scope-${Math.random().toString(36).slice(2, 10)}`;

      playground.info = await playground.call('boot', { base, scope, ...options });

      return playground.info;
    },

    /** Saves the running site in this browser under a slug (see storage.freeSlug()). */
    async save(site, title) {
      // Ask the browser not to evict the saved sites when storage runs low.
      await navigator.storage.persist?.();
      await playground.call('save', { site, title });
      playground.info.site = site;
    },

    /** The site as an ordinary project to run with ddev, as zip bytes. */
    downloadProject: (folder) => playground.call('downloadProject', { folder }),

    /** A saved site writes its changes shortly after requests; this writes them now. */
    flush: () => (playground.info?.site ? playground.call('flush').catch(() => {}) : Promise.resolve()),
  };

  return playground;
}
