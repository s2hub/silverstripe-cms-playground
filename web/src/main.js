// Main page of the Silverstripe Playground: registers the service worker, starts the PHP worker and shows
// Silverstripe in an iframe (adapted from the Joomla Playground's).
//
// ?url=<path> sets the page to open first (default: the CMS), ?login=no starts logged out.

const base = new URL('./', location.href);

const elements = {
  status: document.querySelector('#status'),
  frame: document.querySelector('#site'),
  site: document.querySelector('#open-site'),
  admin: document.querySelector('#open-admin'),
  reset: document.querySelector('#reset-site'),
  credentials: document.querySelector('#credentials'),
  info: document.querySelector('#info'),
};

let worker = null;
let playground = null;
const pending = new Map();
let nextId = 1;

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle('error', isError);
}

function setBusy(busy) {
  for (const button of [elements.site, elements.admin, elements.reset]) {
    button.disabled = busy;
  }
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

async function boot({ landingPage, login }) {
  setBusy(true);
  elements.frame.src = 'about:blank';
  startWorker();

  const scope = `scope-${Math.random().toString(36).slice(2, 10)}`;

  playground = await call('boot', { base: base.href, scope, login });
  show(landingPage);
}

function show(path) {
  const seconds = (playground.timings.ready / 1000).toFixed(1);

  setStatus(`Ready in ${seconds} s`);
  elements.credentials.textContent = `${playground.username} / ${playground.password}`;
  elements.info.textContent = `Silverstripe ${playground.manifest.silverstripe} · PHP ${playground.phpVersion}`;
  elements.info.title = Object.entries(playground.timings).map(([step, ms]) => `${step}: ${ms} ms`).join('\n');
  elements.frame.src = `${playground.siteUrl}${path}`;
  setBusy(false);

  // For tests and debugging.
  window.silverstripePlayground = playground;
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
  elements.reset.onclick = () => confirm('Throw this playground away and start again?') && location.reload();

  const url = new URL(location.href);
  const login = url.searchParams.get('login') !== 'no';
  const landingPage = url.searchParams.get('url') ?? (login ? '/admin/pages' : '/');

  await boot({ landingPage: landingPage.startsWith('/') ? landingPage : `/${landingPage}`, login });
}

start().catch((error) => {
  console.error(error);
  setStatus(error.message, true);
  setBusy(false);
});
