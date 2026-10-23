// Main page of the Silverstripe Playground: registers the service worker, starts the PHP worker, shows Silverstripe
// in an iframe and offers saving, exporting and importing playgrounds (adapted from the Joomla Playground's), and a
// code editor for app/ (see code-editor.js).
//
// ?site=<slug> opens a site saved in this browser; without it, a new temporary playground starts.
// ?url=<path> sets the page to open first (default: the CMS), ?login=no starts logged out.

import { deleteSite, freeSlug, isSiteOpen, listSites, renameSite } from './storage.js';

const base = new URL('./', location.href);

const elements = {
  status: document.querySelector('#status'),
  frame: document.querySelector('#site'),
  site: document.querySelector('#open-site'),
  admin: document.querySelector('#open-admin'),
  code: document.querySelector('#toggle-code'),
  codePanel: document.querySelector('#code-panel'),
  newSite: document.querySelector('#new-site'),
  reset: document.querySelector('#reset-site'),
  save: document.querySelector('#save-site'),
  exportSite: document.querySelector('#export-site'),
  importSite: document.querySelector('#import-site'),
  importFile: document.querySelector('#import-file'),
  sitesMenu: document.querySelector('#sites-menu'),
  sitesList: document.querySelector('#sites-list'),
  credentials: document.querySelector('#credentials'),
  info: document.querySelector('#info'),
};

let worker = null;
let playground = null;

/** The code editor, once the Code panel was opened (see toggleCode()). */
let codeEditor = null;
const pending = new Map();
let nextId = 1;

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle('error', isError);
}

function setBusy(busy) {
  for (const button of [elements.site, elements.admin, elements.code, elements.newSite, elements.exportSite, elements.importSite]) {
    button.disabled = busy;
  }

  // A saved site keeps its changes; saving again and starting over are for temporary playgrounds.
  elements.save.disabled = busy || Boolean(playground?.site);
  elements.reset.disabled = busy || Boolean(playground?.site);
}

/**
 * Sends an action to the PHP worker and waits for its result.
 */
function call(type, payload = {}, transfer = []) {
  const id = nextId++;

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ type, id, ...payload }, transfer);
  });
}

function startWorker() {
  worker?.terminate();
  worker = new Worker(new URL('./php-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') {
      setStatus(data.message);
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

/**
 * Starts a playground in a new PHP worker: from the bundle, a saved site or an imported zip.
 */
async function boot({ landingPage, ...options } = {}, transfer = []) {
  setBusy(true);
  elements.frame.src = 'about:blank';
  startWorker();

  const scope = `scope-${Math.random().toString(36).slice(2, 10)}`;

  playground = await call('boot', { base: base.href, scope, ...options }, transfer);
  show(landingPage);
  await codeEditor?.reset();

  return playground;
}

/**
 * Shows the state of the playground in the toolbar and, unless path is null, opens that page of the site.
 */
function show(path = '/admin/pages') {
  const seconds = (playground.timings.ready / 1000).toFixed(1);
  const where = playground.site ? `saved as "${playground.site}"` : 'temporary';

  setStatus(`Ready in ${seconds} s (${where})`);
  elements.credentials.textContent = `${playground.username} / ${playground.password}`;
  elements.info.textContent = `Silverstripe ${playground.manifest.silverstripe} · PHP ${playground.phpVersion}`;
  elements.info.title = Object.entries(playground.timings).map(([step, ms]) => `${step}: ${ms} ms`).join('\n');

  if (path !== null) {
    elements.frame.src = `${playground.siteUrl}${path}`;
  }

  setBusy(false);

  // For tests and debugging.
  window.silverstripePlayground = playground;
}

/**
 * Shows or hides the Code panel. Monaco is loaded the first time it opens.
 */
async function toggleCode() {
  const open = elements.codePanel.hidden;

  elements.codePanel.hidden = !open;
  elements.code.setAttribute('aria-pressed', String(open));

  if (open && !codeEditor) {
    setStatus('Loading the code editor');

    const { createCodeEditor } = await import('./code-editor.js');

    codeEditor = createCodeEditor({
      root: elements.codePanel,
      call,
      setStatus,
      reloadSite: () => elements.frame.contentWindow?.location.reload(),
    });
    await codeEditor.reset();
    setStatus('Edit the files in app/; dev/build updates the database and caches');
  }
}

async function saveSite() {
  const title = prompt('Save this playground in your browser as:', 'My Silverstripe site')?.trim();

  if (!title) {
    return;
  }

  setBusy(true);

  try {
    const site = await freeSlug(title);

    // Ask the browser not to evict the saved sites when storage runs low.
    await navigator.storage.persist?.();
    await call('save', { site, title });

    playground.site = site;
    history.replaceState(null, '', `?site=${encodeURIComponent(site)}`);
    show(null);
  } catch (error) {
    setStatus(error.message, true);
    setBusy(false);
  }
}

async function exportSite() {
  setBusy(true);
  setStatus('Exporting the site');

  try {
    const bytes = await call('exportSite');
    const name = `${playground.site ?? 'silverstripe-playground'}-${new Date().toISOString().slice(0, 10)}.zip`;
    const link = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([bytes], { type: 'application/zip' })),
      download: name,
    });

    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    show(null);
  } catch (error) {
    setStatus(error.message, true);
    setBusy(false);
  }
}

async function importSite(file) {
  const bytes = await file.arrayBuffer();

  // An imported site starts as a temporary playground; it can be saved from there.
  history.replaceState(null, '', base.pathname);

  try {
    const result = await boot({ zip: bytes }, [bytes]);
    const from = result.importedFrom?.silverstripe;

    if (from && from !== result.manifest.silverstripe) {
      setStatus(`Imported a Silverstripe ${from} site into the Silverstripe ${result.manifest.silverstripe} playground: module resources may not match`, true);
    }
  } catch (error) {
    setStatus(`Import failed: ${error.message}`, true);
    setBusy(false);
  }
}

async function renderSites() {
  const sites = await listSites();

  elements.sitesList.replaceChildren();

  if (sites.length === 0) {
    elements.sitesList.append(Object.assign(document.createElement('li'), { className: 'empty', textContent: 'No saved sites yet' }));

    return;
  }

  for (const site of sites) {
    const item = document.createElement('li');
    const open = Object.assign(document.createElement('a'), { href: `?site=${encodeURIComponent(site.slug)}`, textContent: site.title });
    const details = Object.assign(document.createElement('span'), {
      className: 'details',
      textContent: `Silverstripe ${site.silverstripe} · ${new Date(site.updated).toLocaleString()}`,
    });
    const actions = Object.assign(document.createElement('span'), { className: 'actions' });
    const rename = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Rename' });
    const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'delete', textContent: 'Delete' });

    rename.onclick = async () => {
      const title = prompt('New name for this site:', site.title)?.trim();

      if (title && title !== site.title) {
        await renameSite(site.slug, title);
        await renderSites();
      }
    };

    remove.onclick = async () => {
      if (await isSiteOpen(site.slug)) {
        alert(`"${site.title}" is open in a tab. Close it first (or start a new playground there).`);

        return;
      }

      if (confirm(`Delete "${site.title}" from this browser? This cannot be undone.`)) {
        await deleteSite(site.slug);
        await renderSites();
      }
    };

    actions.append(rename, remove);
    item.append(open, details, actions);
    elements.sitesList.append(item);
  }
}

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

async function start() {
  if (!('serviceWorker' in navigator)) {
    throw new Error('This browser does not support service workers (they need HTTPS or localhost).');
  }

  setStatus('Starting the service worker');
  await newestServiceWorker(await navigator.serviceWorker.register(new URL('sw.js', base), { scope: base.pathname }));

  elements.site.onclick = () => (elements.frame.src = `${playground.siteUrl}/`);
  elements.admin.onclick = () => (elements.frame.src = `${playground.siteUrl}/admin/`);
  elements.code.onclick = () => toggleCode().catch((error) => setStatus(error.message, true));
  elements.newSite.onclick = () => (location.href = base.pathname);
  elements.reset.onclick = () => confirm('Throw this playground away and start again from the same link?') && location.reload();
  elements.save.onclick = saveSite;
  elements.exportSite.onclick = exportSite;
  elements.importSite.onclick = () => elements.importFile.click();
  elements.importFile.onchange = () => elements.importFile.files[0] && importSite(elements.importFile.files[0]);
  elements.sitesMenu.ontoggle = () => elements.sitesMenu.open && renderSites();

  // A saved site writes its changes shortly after requests; when the tab is hidden or closed, write them now.
  const flush = () => playground?.site && call('flush').catch(() => {});

  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
  addEventListener('pagehide', flush);

  const url = new URL(location.href);
  const site = url.searchParams.get('site');
  const login = url.searchParams.get('login') !== 'no';
  const landingPage = url.searchParams.get('url') ?? (login ? '/admin/pages' : '/');

  await boot({ ...(site ? { site } : {}), login, landingPage: landingPage.startsWith('/') ? landingPage : `/${landingPage}` });
}

start().catch((error) => {
  console.error(error);
  setStatus(error.message, true);

  // No playground runs: only starting a new one or importing one makes sense.
  elements.newSite.disabled = false;
  elements.importSite.disabled = false;
});
