// PHP worker of the Silverstripe Playground: runs Silverstripe in PHP compiled to WebAssembly (adapted from the
// Joomla Playground's).
//
// It unpacks the pre-built site (silverstripe/site.zip, see bin/build-browser-bundle.mjs) into PHP's in-memory
// filesystem, points it at this tab's scope URL, gives the admin a random password, logs in, and answers the
// requests the service worker sends for that scope.
//
// The page talks to it with messages { type, id, ... }; the worker answers { type: 'result', id, value | error }
// and sends { type: 'progress', message } while it works.

import { PHP, PHPRequestHandler, setPhpIniEntries } from '@php-wasm/universal';
import { certificateToPEM, generateCertificate, loadWebRuntime } from '@php-wasm/web';
import { PREPEND_FILE, prependCode } from './prepend.js';

export const PHP_VERSION = '8.4';

const PROJECT_ROOT = '/var/www/silverstripe';
const DOCUMENT_ROOT = `${PROJECT_ROOT}/public`;
const CA_BUNDLE = '/internal/shared/ca-bundle.crt';
const ADMIN_USERNAME = 'admin';

const channel = new BroadcastChannel('silverstripe-playground');

/** @type {{php: PHP, handler: PHPRequestHandler}|null} */
let state = null;

/**
 * Runs PHP requests one after the other. With a single PHP instance, @php-wasm rejects a request that arrives
 * while another one runs (SinglePHPInstanceManager), and the CMS fires several requests at once.
 */
let queue = Promise.resolve();

function serialized(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});

  return run;
}

const actions = { boot };

self.onmessage = async ({ data }) => {
  const action = actions[data?.type];

  if (!action) {
    return;
  }

  try {
    const { value, transfer = [] } = await action(data);
    self.postMessage({ type: 'result', id: data.id, value }, transfer);
  } catch (error) {
    self.postMessage({ type: 'result', id: data.id, error: String(error?.message ?? error) });
  }
};

function progress(message) {
  self.postMessage({ type: 'progress', message });
}

/**
 * @param {object} options
 * @param {string} options.base  URL of the playground (the folder of index.html)
 * @param {string} options.scope This tab's scope, e.g. "scope-abc123"
 * @param {boolean} [options.login] Log in as the admin (default)
 */
async function boot({ base, scope, login = true }) {
  const started = performance.now();
  const timings = {};
  const lap = (name) => (timings[name] = Math.round(performance.now() - started));
  const siteUrl = new URL(`${scope}/`, base).href.replace(/\/$/, '');
  const bundle = new URL('silverstripe/', base);

  progress(`Loading PHP ${PHP_VERSION}`);
  const caRoot = await generateCertificate({
    subject: { commonName: 'Silverstripe Playground CA', organizationName: 'Silverstripe Playground', countryName: 'DE' },
    basicConstraints: { ca: true },
  });
  const [php, manifest, zip] = await Promise.all([
    loadWebRuntime(PHP_VERSION, {
      // Silverstripe 6 requires ext-intl, which @php-wasm only loads on request.
      withIntl: true,
      // Outgoing HTTP(S) from PHP goes through the browser's fetch() (see enableNetwork()).
      tcpOverFetch: { CAroot: caRoot },
    }).then((runtime) => (lap('php'), new PHP(runtime))),
    fetch(new URL('manifest.json', bundle)).then((response) => response.json()),
    download(new URL('site.zip', bundle)).then((bytes) => (lap('download'), bytes)),
  ]);

  const password = randomPassword();

  // php.ini settings, before PHP runs anything.
  await enableNetwork(php, caRoot);
  php.writeFile(PREPEND_FILE, prependCode({ SS_BASE_URL: siteUrl, SS_DEFAULT_ADMIN_PASSWORD: password }));
  await setPhpIniEntries(php, { auto_prepend_file: PREPEND_FILE });

  progress('Unpacking Silverstripe');
  php.mkdir(PROJECT_ROOT);
  php.writeFile('/tmp/site.zip', zip);
  await runPhp(php, `
    $zip = new ZipArchive();
    if ($zip->open('/tmp/site.zip') !== true || !$zip->extractTo('${PROJECT_ROOT}')) {
        throw new RuntimeException('Cannot unpack the site');
    }
    $zip->close();
    unlink('/tmp/site.zip');
  `);
  lap('unpack');

  const createHandler = () =>
    new PHPRequestHandler({
      php,
      documentRoot: DOCUMENT_ROOT,
      absoluteUrl: siteUrl,
      // Silverstripe's .htaccess sends every path that is not a file to index.php.
      getFileNotFoundAction: () => ({ type: 'internal-redirect', uri: '/index.php' }),
    });

  state = { php, handler: createHandler() };

  if (login) {
    progress('Logging in');
    await logIn(state.handler, siteUrl, password);
    lap('login');
  }

  lap('ready');

  channel.onmessage = ({ data }) => {
    if (data?.type === 'request' && data.scope === scope) {
      answer(data);
    }
  };

  return {
    value: { siteUrl, username: ADMIN_USERNAME, password, manifest, timings, phpVersion: PHP_VERSION },
  };
}

async function answer({ id, request }) {
  try {
    const started = performance.now();
    const response = await serialized(() =>
      state.handler.request({
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: request.body ? new Uint8Array(request.body) : undefined,
      })
    );
    const duration = performance.now() - started;

    if (duration > 2000) {
      console.warn(`PHP took ${Math.round(duration)} ms (queue included) for ${request.method} ${request.url}`);
    }

    if (response.httpStatusCode >= 500) {
      console.warn(`PHP ${response.httpStatusCode} for ${request.method} ${request.url}`, response.errors, response.text.slice(0, 500));
    }

    channel.postMessage({ type: 'response', id, status: response.httpStatusCode, headers: response.headers, body: response.bytes });
  } catch (error) {
    channel.postMessage({
      type: 'response',
      id,
      status: 500,
      headers: { 'content-type': ['text/plain; charset=utf-8'] },
      body: new TextEncoder().encode(String(error?.stack ?? error)),
    });
  }
}

/**
 * PHP has no sockets in the browser. With tcpOverFetch, @php-wasm turns the bytes PHP writes to a socket into a
 * fetch(): it ends PHP's TLS connection itself, with a certificate for the host signed by the given CA, which PHP
 * must trust. The browser's rules apply: only servers that allow cross-origin requests answer.
 */
async function enableNetwork(php, caRoot) {
  php.writeFile(CA_BUNDLE, certificateToPEM(caRoot.certificate));
  await setPhpIniEntries(php, { 'openssl.cafile': CA_BUNDLE, 'curl.cainfo': CA_BUNDLE });
}

/**
 * Logs in as the default admin (SS_DEFAULT_ADMIN_USERNAME/PASSWORD), so the cookie store of the request handler
 * holds an admin session. The cookies stay in this worker: the browser never sees them.
 */
async function logIn(handler, siteUrl, password) {
  const form = await handler.request({ url: `${siteUrl}/Security/login` });
  const token = form.text.match(/name="SecurityID" value="([^"]+)"/)?.[1];

  if (!token) {
    const page = form.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);

    throw new Error(`No login form (HTTP ${form.httpStatusCode}): ${page} ${form.errors}`);
  }

  const body = new URLSearchParams({
    Email: ADMIN_USERNAME,
    Password: password,
    SecurityID: token,
    AuthenticationMethod: 'SilverStripe\\Security\\MemberAuthenticator\\MemberAuthenticator',
    action_doLogin: '1',
  });
  const response = await handler.request({
    url: `${siteUrl}/Security/login/default/LoginForm`,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new TextEncoder().encode(body.toString()),
  });

  if (response.httpStatusCode !== 302 || /Security\/login/.test(response.headers.location?.[0] ?? '')) {
    throw new Error(`Logging in failed (HTTP ${response.httpStatusCode})`);
  }
}

async function runPhp(php, code) {
  const response = await php.run({ code: `<?php ${code}` });

  if (response.exitCode !== 0 || response.errors) {
    throw new Error(`PHP failed: ${response.errors || response.text}`);
  }

  return response;
}

async function download(url) {
  progress('Downloading Silverstripe');

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Cannot download ${url}: HTTP ${response.status}`);
  }

  const total = Number(response.headers.get('content-length')) || 0;
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    chunks.push(value);
    received += value.length;

    if (total) {
      progress(`Downloading Silverstripe: ${Math.round((received / total) * 100)}% of ${(total / 1048576).toFixed(1)} MB`);
    }
  }

  const bytes = new Uint8Array(received);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return bytes;
}

function randomPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
