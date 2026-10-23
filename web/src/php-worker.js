// PHP worker of the Silverstripe Playground: runs Silverstripe in PHP compiled to WebAssembly (adapted from the
// Joomla Playground's).
//
// It puts a Silverstripe project into PHP's in-memory filesystem, points it at this tab's scope URL, sets the admin
// password, logs in, and answers the requests the service worker sends for that scope. The project comes from:
// - the pre-built bundle (silverstripe/site.zip, see bin/build-browser-bundle.mjs): a temporary playground;
// - a saved site in the browser's private file system (OPFS): the zip it started from plus a snapshot of the files
//   that changed since, rewritten shortly after requests that change files (see storage.js).
// It also exports the site as an ordinary project to run with ddev (see export-project.php).
//
// The page talks to it with messages { type, id, ... }; the worker answers { type: 'result', id, value | error }
// and sends { type: 'progress', message } while it works.

import { PHP, PHPRequestHandler, setPhpIniEntries } from '@php-wasm/universal';
import { certificateToPEM, generateCertificate, loadWebRuntime } from '@php-wasm/web';
import { journalFSEvents } from '@php-wasm/fs-journal';
import { PREPEND_FILE, prependCode } from './prepend.js';
import exportProjectScript from './export-project.php?raw';
import { hasBase, readBase, readMeta, readSnapshot, siteLockName, writeBase, writeMeta, writeSnapshot } from './storage.js';

export const PHP_VERSION = '8.4';

const PROJECT_ROOT = '/var/www/silverstripe';
const DOCUMENT_ROOT = `${PROJECT_ROOT}/public`;
const CA_BUNDLE = '/internal/shared/ca-bundle.crt';
const ADMIN_USERNAME = 'admin';

/**
 * Caches and generated files, left out of snapshots (a PHP regular expression): the base brings the caches, and the
 * combined TinyMCE scripts depend on the scope URL and are made again when needed.
 */
const SKIP = '#^(silverstripe-cache|public/assets/_tinymce)(/|$)#';

/**
 * After a form submission (any method but GET and HEAD) that changed files, a snapshot is written before the next
 * request runs. After other requests (sessions, caches) it is written this long after the last one that changed
 * files, and at most this long after the first.
 */
const SNAPSHOT_DELAY = 500;
const SNAPSHOT_MAX_DELAY = 5000;

const channel = new BroadcastChannel('silverstripe-playground');

/**
 * base:    the zip the site started from; its bytes are kept until the site is saved
 * changes: paths below the project root that changed since the site was unpacked from its base, and the folders
 *          that were renamed (moved with all their files)
 * dirty:   whether files changed since the last snapshot
 *
 * @type {{php: PHP, siteUrl: string, handler: PHPRequestHandler, manifest: object, password: string, site: string|null,
 *   base: {id: string|null, bytes: Uint8Array|null}, changes: {paths: Set<string>, trees: Set<string>}, dirty: boolean}}
 */
let state = null;

/**
 * Runs PHP requests one after the other. With a single PHP instance, @php-wasm rejects a request that arrives
 * while another one runs (SinglePHPInstanceManager), and the CMS fires several requests at once. Snapshots run in
 * this queue too, so no request changes files while one is taken.
 */
let queue = Promise.resolve();

function serialized(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});

  return run;
}

const actions = { boot, save, downloadProject, flush, listFiles, readFile, writeFile, deleteFile, flushCaches, devBuild };

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
 * @param {string} options.base     URL of the playground (the folder of index.html)
 * @param {string} options.scope    This tab's scope, e.g. "scope-abc123"
 * @param {string} [options.site]   Slug of a saved site to open
 * @param {boolean} [options.login] Log in as the admin (default)
 */
async function boot({ base, scope, site = null, login = true }) {
  const started = performance.now();
  const timings = {};
  const lap = (name) => (timings[name] = Math.round(performance.now() - started));
  const siteUrl = new URL(`${scope}/`, base).href.replace(/\/$/, '');
  const bundle = new URL('silverstripe/', base);

  if (site) {
    await lockSite(site);
  }

  const meta = site ? await readMeta(site) : null;

  if (site && !meta) {
    throw new Error(`There is no saved site "${site}" in this browser`);
  }

  progress(`Loading PHP ${PHP_VERSION}`);
  const caRoot = await generateCertificate({
    subject: { commonName: 'Silverstripe Playground CA', organizationName: 'Silverstripe Playground', countryName: 'DE' },
    basicConstraints: { ca: true },
  });
  const [php, manifest, files] = await Promise.all([
    loadWebRuntime(PHP_VERSION, {
      // Silverstripe 6 requires ext-intl, which @php-wasm only loads on request.
      withIntl: true,
      // Outgoing HTTP(S) from PHP goes through the browser's fetch() (see enableNetwork()).
      tcpOverFetch: { CAroot: caRoot },
    }).then((runtime) => (lap('php'), new PHP(runtime))),
    fetch(new URL('manifest.json', bundle)).then((response) => response.json()),
    siteFiles({ bundle, site, meta }).then((files) => (lap(meta ? 'read' : 'download'), files)),
  ]);

  const password = meta?.password ?? randomPassword();

  // php.ini settings, before PHP runs anything.
  await enableNetwork(php, caRoot);
  php.writeFile(PREPEND_FILE, prependCode({ SS_BASE_URL: siteUrl, SS_DEFAULT_ADMIN_PASSWORD: password }));
  await setPhpIniEntries(php, { auto_prepend_file: PREPEND_FILE });

  progress(meta ? 'Opening the saved site' : 'Unpacking Silverstripe');
  php.mkdir(PROJECT_ROOT);
  php.writeFile('/tmp/site.zip', files.bytes);
  await runPhp(php, `
    $zip = new ZipArchive();
    if ($zip->open('/tmp/site.zip') !== true || !$zip->extractTo('${PROJECT_ROOT}')) {
        throw new RuntimeException('Cannot unpack the site');
    }
    $zip->close();
    unlink('/tmp/site.zip');
  `);
  lap('unpack');

  const changes = { paths: new Set(), trees: new Set() };

  if (files.snapshot) {
    for (const path of await restoreSnapshot(php, files.snapshot)) {
      changes.paths.add(path);
    }

    lap('restore');
  }

  // From here on, note every path below the project root that changes: those go into the snapshots.
  journalFSEvents(php, PROJECT_ROOT, (entry) => trackChange(changes, entry));

  const createHandler = () =>
    new PHPRequestHandler({
      php,
      documentRoot: DOCUMENT_ROOT,
      absoluteUrl: siteUrl,
      // Silverstripe's .htaccess sends every path that is not a file to index.php.
      getFileNotFoundAction: () => ({ type: 'internal-redirect', uri: '/index.php' }),
    });

  state = {
    php,
    siteUrl,
    handler: createHandler(),
    manifest,
    password,
    site: null,
    base: { id: meta?.base ?? null, bytes: meta ? null : files.bytes },
    changes,
    dirty: false,
  };

  if (meta) {
    state.site = site;
    await writeMeta(site, { ...meta, opened: new Date().toISOString() });
  }

  // The caches come from the base, not from the snapshot: after changes to the code they must be built again.
  if ([...changes.paths].some((path) => EDITABLE.some((folder) => path === folder || path.startsWith(`${folder}/`)))) {
    progress('Building the caches for the changed code');
    await state.handler.request({ url: `${siteUrl}/?flush=1` });
    lap('flush');
  }

  if (login) {
    progress('Logging in');
    await logIn(state.handler, siteUrl, password);
    lap('login');
  }

  lap('ready');
  scheduleSnapshot();

  channel.onmessage = ({ data }) => {
    if (data?.type === 'request' && data.scope === scope) {
      answer(data);
    }
  };

  return {
    value: {
      siteUrl,
      username: ADMIN_USERNAME,
      password,
      manifest,
      timings,
      phpVersion: PHP_VERSION,
      site: state.site,
    },
  };
}

/**
 * The zip to start from (the bundle, or a saved site's base), and a saved site's snapshot.
 */
async function siteFiles({ bundle, site, meta }) {
  if (!meta) {
    return { bytes: await download(new URL('site.zip', bundle)), snapshot: null };
  }

  const [bytes, snapshot] = await Promise.all([readBase(meta.base), readSnapshot(site)]);

  if (!bytes) {
    throw new Error(`The files of the site "${site}" are missing in this browser`);
  }

  return { bytes, snapshot };
}

/**
 * Saves the running playground as a site in OPFS. From then on, a snapshot of its changes is written there shortly
 * after requests that change files.
 */
async function save({ site, title }) {
  if (!state) {
    throw new Error('The playground is not running');
  }

  if (state.site) {
    throw new Error(`This playground is already saved as "${state.site}"`);
  }

  await lockSite(site);
  await serialized(() => persist(site, title));

  return { value: { site } };
}

/**
 * Writes the base (once per zip), a first snapshot and then meta.json: a site is listed only when it is complete.
 */
async function persist(site, title) {
  progress('Saving the site in this browser');

  const id = await sha256(state.base.bytes);

  if (!(await hasBase(id))) {
    await writeBase(id, state.base.bytes);
  }

  await snapshot(site);
  await writeMeta(site, {
    title,
    password: state.password,
    silverstripe: state.manifest.silverstripe,
    base: id,
    created: new Date().toISOString(),
  });
  state.base = { id, bytes: null };
  state.site = site;
}

/**
 * Notes a filesystem operation of PHP (see journalFSEvents()) as a changed path, relative to the project root.
 */
function trackChange(changes, { operation, path, toPath, nodeType }) {
  const relative = (absolute) => (absolute?.startsWith(`${PROJECT_ROOT}/`) ? absolute.slice(PROJECT_ROOT.length + 1) : null);
  const from = relative(path);
  const to = operation === 'RENAME' ? relative(toPath) : null;

  if (from) {
    changes.paths.add(from);
  }

  if (to) {
    changes.paths.add(to);

    if (nodeType === 'directory') {
      changes.trees.add(to);
    }
  }

  if (state && (from || to)) {
    state.dirty = true;
  }
}

let snapshotTimer = null;
let firstChange = 0;

/**
 * Writes a snapshot of a saved site: next in the request queue, or after a quiet moment but not later than
 * SNAPSHOT_MAX_DELAY after the first change, so a busy site is saved too.
 */
function scheduleSnapshot({ now: immediately = false } = {}) {
  if (!state?.site || !state.dirty) {
    return;
  }

  const now = performance.now();

  if (snapshotTimer) {
    clearTimeout(snapshotTimer);
  } else {
    firstChange = now;
  }

  if (immediately) {
    snapshotTimer = null;
    serialized(() => state.dirty && snapshot(state.site)).catch((error) => console.error('Cannot save the site:', error));

    return;
  }

  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    serialized(() => state.dirty && snapshot(state.site)).catch((error) => console.error('Cannot save the site:', error));
  }, Math.max(0, Math.min(SNAPSHOT_DELAY, firstChange + SNAPSHOT_MAX_DELAY - now)));
}

/**
 * The page is hidden or closing: write the pending snapshot now.
 */
async function flush() {
  if (state?.site) {
    clearTimeout(snapshotTimer);
    snapshotTimer = null;
    await serialized(() => state.dirty && snapshot(state.site));
  }

  return { value: null };
}

/**
 * Zips the changed files (files/<path>) and the deleted paths (deleted.json), and writes the zip to OPFS.
 * Runs in the request queue: no request changes files meanwhile.
 */
async function snapshot(site) {
  const started = performance.now();

  state.dirty = false;

  try {
    state.php.writeFile('/tmp/changes.json', JSON.stringify({ paths: [...state.changes.paths], trees: [...state.changes.trees] }));
    await runPhp(state.php, `
      $root    = '${PROJECT_ROOT}';
      $changes = json_decode(file_get_contents('/tmp/changes.json'), true);
      unlink('/tmp/changes.json');
      $zip = new ZipArchive();
      $zip->open('/tmp/snapshot.zip', ZipArchive::CREATE | ZipArchive::OVERWRITE);
      $deleted = [];
      $add = function (string $relative) use ($root, $zip, &$deleted) {
          if (preg_match(${JSON.stringify(SKIP)}, $relative)) {
              return;
          }
          $path = $root . '/' . $relative;
          if (is_file($path)) {
              $zip->addFile($path, 'files/' . $relative);
          } elseif (is_dir($path)) {
              $zip->addEmptyDir('files/' . $relative);
          } else {
              $deleted[] = $relative;
          }
      };
      foreach ($changes['paths'] as $relative) {
          $add($relative);
      }
      foreach ($changes['trees'] as $tree) {
          if (is_dir($root . '/' . $tree)) {
              $files = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root . '/' . $tree, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::SELF_FIRST);
              foreach ($files as $file) {
                  $add(substr($file->getPathname(), strlen($root) + 1));
              }
          }
      }
      $zip->addFromString('deleted.json', json_encode($deleted));
      $zip->close();
    `);

    const bytes = state.php.readFileAsBuffer('/tmp/snapshot.zip');

    state.php.unlink('/tmp/snapshot.zip');
    await writeSnapshot(site, bytes);
    console.debug(`Snapshot of "${site}": ${bytes.length} bytes in ${Math.round(performance.now() - started)} ms`);
  } catch (error) {
    state.dirty = true;

    throw error;
  }
}

/**
 * Puts a snapshot on top of the unpacked base: removes the deleted paths, writes the changed files.
 *
 * @returns {Promise<string[]>} The paths in the snapshot: the changes of the site so far.
 */
async function restoreSnapshot(php, bytes) {
  php.writeFile('/tmp/snapshot.zip', bytes);

  const response = await runPhp(php, `
    $root = '${PROJECT_ROOT}';
    $zip  = new ZipArchive();
    if ($zip->open('/tmp/snapshot.zip') !== true) {
        throw new RuntimeException('Cannot open the snapshot of the site');
    }
    $remove = function (string $path) use (&$remove) {
        if (is_dir($path) && !is_link($path)) {
            foreach (array_diff(scandir($path), ['.', '..']) as $name) {
                $remove($path . '/' . $name);
            }
            rmdir($path);
        } elseif (file_exists($path) || is_link($path)) {
            unlink($path);
        }
    };
    $paths = json_decode((string) $zip->getFromName('deleted.json'), true) ?: [];
    foreach ($paths as $relative) {
        $remove($root . '/' . $relative);
    }
    for ($index = 0; $index < $zip->numFiles; $index++) {
        $name = $zip->getNameIndex($index);
        if (!str_starts_with($name, 'files/')) {
            continue;
        }
        $relative = rtrim(substr($name, 6), '/');
        $path     = $root . '/' . $relative;
        $paths[]  = $relative;
        if (str_ends_with($name, '/')) {
            is_dir($path) || mkdir($path, 0777, true);
            continue;
        }
        if (is_dir($path)) {
            $remove($path);
        }
        is_dir(dirname($path)) || mkdir(dirname($path), 0777, true);
        file_put_contents($path, $zip->getFromIndex($index));
    }
    $zip->close();
    unlink('/tmp/snapshot.zip');
    echo json_encode($paths);
  `);

  return JSON.parse(response.text);
}

/**
 * Exports the site as an ordinary Silverstripe project with ddev, its content and a git repository (see
 * export-project.php), as a zip to download.
 *
 * @param {string} folder The name of the project folder in the zip
 */
async function downloadProject({ folder }) {
  const php = running();

  php.writeFile('/tmp/export-project.php', exportProjectScript);
  php.writeFile('/tmp/export-project.json', JSON.stringify({
    root: PROJECT_ROOT,
    database: `${PROJECT_ROOT}/database/silverstripe.sqlite`,
    zip: '/tmp/project.zip',
    folder,
    message: 'Exported from the Silverstripe Playground',
    time: Math.floor(Date.now() / 1000),
  }));

  await serialized(async () => {
    const response = await php.run({ scriptPath: '/tmp/export-project.php' });

    if (response.exitCode !== 0 || response.errors) {
      throw new Error(`The export failed: ${response.errors || response.text}`);
    }
  });

  const bytes = php.readFileAsBuffer('/tmp/project.zip');

  for (const file of ['/tmp/project.zip', '/tmp/export-project.php', '/tmp/export-project.json']) {
    php.unlink(file);
  }

  return { value: bytes.buffer, transfer: [bytes.buffer] };
}

/** The folders the code editor may change (see code-editor.js). */
const EDITABLE = ['app'];

/**
 * A path below the project root that the code editor may change: inside an editable folder, without "." or ".."
 * segments.
 */
function editablePath(path) {
  const segments = String(path).split('/').filter(Boolean);

  if (!EDITABLE.includes(segments[0]) || segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`Only files in ${EDITABLE.map((folder) => `${folder}/`).join(', ')} can be edited`);
  }

  return `${PROJECT_ROOT}/${segments.join('/')}`;
}

function running() {
  if (!state) {
    throw new Error('The playground is not running');
  }

  return state.php;
}

/**
 * The files and folders in the editable folders: [{ path, type: 'file' | 'dir' }], sorted.
 */
async function listFiles() {
  const php = running();
  const entries = [];
  const walk = (relative) => {
    for (const name of php.listFiles(`${PROJECT_ROOT}/${relative}`).sort()) {
      const path = `${relative}/${name}`;
      const isDir = php.isDir(`${PROJECT_ROOT}/${path}`);

      entries.push({ path, type: isDir ? 'dir' : 'file' });

      if (isDir) {
        walk(path);
      }
    }
  };

  await serialized(() => EDITABLE.forEach((folder) => php.isDir(`${PROJECT_ROOT}/${folder}`) && walk(folder)));

  return { value: entries };
}

async function readFile({ path }) {
  const php = running();

  return { value: await serialized(() => php.readFileAsText(editablePath(path))) };
}

/**
 * Writes a file, creating its folders. For a saved site, the change goes into the next snapshot.
 */
async function writeFile({ path, content }) {
  const php = running();
  const absolute = editablePath(path);

  await serialized(() => {
    php.mkdir(absolute.slice(0, absolute.lastIndexOf('/')));
    php.writeFile(absolute, content);
  });
  scheduleSnapshot({ now: true });

  return { value: null };
}

async function deleteFile({ path }) {
  const php = running();
  const absolute = editablePath(path);

  await serialized(() => (php.isDir(absolute) ? php.rmdir(absolute, { recursive: true }) : php.unlink(absolute)));
  scheduleSnapshot({ now: true });

  return { value: null };
}

/**
 * Rebuilds Silverstripe's manifests and caches (?flush=1), so new classes, templates and config take effect.
 */
async function flushCaches() {
  running();

  const response = await serialized(() => state.handler.request({ url: `${state.siteUrl}/?flush=1` }));

  scheduleSnapshot();

  return { value: { status: response.httpStatusCode } };
}

/**
 * Runs dev/build with flush, logged in as the admin: updates the database to the code and rebuilds the manifests and
 * caches. Returns the output as text.
 */
async function devBuild() {
  running();

  const response = await serialized(() => state.handler.request({ url: `${state.siteUrl}/dev/build?flush=1` }));
  const text = response.text
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(li|p|div|h\d|tr)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();

  scheduleSnapshot({ now: true });

  return { value: { status: response.httpStatusCode, text } };
}

/**
 * One tab per saved site: two PHP workers writing the same files would overwrite each other's changes.
 * The lock is held until this worker ends. After a reload, the previous page's worker may still hold it for a
 * moment, so wait a few seconds before giving up.
 */
async function lockSite(site) {
  const acquired = await new Promise((resolve) => {
    navigator.locks
      .request(siteLockName(site), { signal: AbortSignal.timeout(5000) }, () => {
        resolve(true);

        return new Promise(() => {});
      })
      .catch(() => resolve(false));
  });

  if (!acquired) {
    throw new Error(`The site "${site}" is open in another tab. Close that tab first.`);
  }
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
  } finally {
    scheduleSnapshot({ now: !['GET', 'HEAD'].includes(String(request.method ?? 'GET').toUpperCase()) });
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
    // Where to go after logging in: the CMS. Without it, Silverstripe shows the login page again ("Welcome back"),
    // unless the project sets Security.default_login_dest.
    BackURL: `${new URL(siteUrl).pathname}/admin/`,
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

async function sha256(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

  return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
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
