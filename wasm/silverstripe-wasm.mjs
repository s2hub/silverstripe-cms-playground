// Runs a Silverstripe site with PHP compiled to WebAssembly (@php-wasm/node), as a step towards the browser.
//
// The project folder is mounted into PHP's virtual filesystem at /var/www/silverstripe (NODEFS, so changes land
// on disk); public/ is the document root. Requests are served by @php-wasm's PHPRequestHandler behind a plain
// Node HTTP server.

import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PHP, PHPRequestHandler, ProcessIdAllocator, setPhpIniEntries } from '@php-wasm/universal';
import { createNodeFsMountHandler, loadNodeRuntime } from '@php-wasm/node';
import { PREPEND_FILE, prependCode } from '../web/src/prepend.js';

export const PROJECT_ROOT = '/var/www/silverstripe';
export const DOCUMENT_ROOT = `${PROJECT_ROOT}/public`;

/** CA certificates of the host, for PHP's outgoing HTTPS requests (e.g. oEmbed lookups). */
const HOST_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';
const CA_BUNDLE = '/internal/shared/ca-bundle.crt';

/** The admin password of sites run in Node; the browser playground makes a random one per playground. */
export const ADMIN_PASSWORD = 'password';

const processIds = new ProcessIdAllocator();

/**
 * Runs PHP requests one after the other: a single PHP instance rejects a request that arrives while another runs.
 */
function createQueue() {
  let queue = Promise.resolve();

  return (task) => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});

    return run;
  };
}

/**
 * Boots PHP with the project mounted.
 *
 * @returns {Promise<PHP>}
 */
export async function bootPhp({ site, phpVersion = '8.4', env = {} }) {
  const runtime = await loadNodeRuntime(phpVersion, {
    // Silverstripe 6 requires ext-intl (IntlLocales), which @php-wasm only loads on request.
    withIntl: true,
    emscriptenOptions: { processId: processIds.claim() },
  });
  const php = new PHP(runtime);

  php.writeFile(PREPEND_FILE, prependCode({ SS_DEFAULT_ADMIN_PASSWORD: ADMIN_PASSWORD, ...env }));
  await setPhpIniEntries(php, { auto_prepend_file: PREPEND_FILE });

  if (existsSync(HOST_CA_BUNDLE)) {
    php.writeFile(CA_BUNDLE, readFileSync(HOST_CA_BUNDLE));
    await setPhpIniEntries(php, { 'openssl.cafile': CA_BUNDLE, 'curl.cainfo': CA_BUNDLE });
  }

  await php.mount(PROJECT_ROOT, createNodeFsMountHandler(resolve(site)));
  php.chdir(PROJECT_ROOT);

  return php;
}

/**
 * Runs a PHP script in WebAssembly, with the project mounted.
 *
 * @param {string[]} args The script (a path in the virtual filesystem) and its arguments
 * @returns {Promise<{exitCode: number, output: string}>}
 */
export async function runCli({ site, args, phpVersion = '8.4' }) {
  const php = await bootPhp({ site, phpVersion });
  const response = await php.cli(['php', ...args]);
  const output = (await response.stdoutText) + (await response.stderrText);

  return { exitCode: await response.exitCode, output };
}

/**
 * Runs Silverstripe's CLI (sake) in WebAssembly.
 */
export function runSake({ site, args, phpVersion = '8.4' }) {
  return runCli({ site, args: [`${PROJECT_ROOT}/vendor/silverstripe/framework/bin/sake`, ...args], phpVersion });
}

/**
 * Serves the site over HTTP.
 *
 * @returns {Promise<{url: string, php: PHP, close: () => Promise<void>}>}
 */
export async function serve({ site, port = 8791, phpVersion = '8.4', log = () => {} }) {
  const url = `http://127.0.0.1:${port}`;
  const php = await bootPhp({ site, phpVersion, env: { SS_BASE_URL: url } });
  const handler = new PHPRequestHandler({
    php,
    documentRoot: DOCUMENT_ROOT,
    absoluteUrl: url,
    // The browser keeps the cookies; PHP gets them from the request headers.
    cookieStore: false,
    // Silverstripe's .htaccess sends every path that is not a file to index.php.
    getFileNotFoundAction: () => ({ type: 'internal-redirect', uri: '/index.php' }),
  });

  const serialized = createQueue();

  const server = http.createServer(async (request, response) => {
    const started = performance.now();

    try {
      const chunks = [];

      for await (const chunk of request) {
        chunks.push(chunk);
      }

      const headers = Object.fromEntries(
        Object.entries(request.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value])
      );
      const body = Buffer.concat(chunks);
      const phpResponse = await serialized(() =>
        handler.request({
          url: request.url,
          method: request.method,
          headers,
          body: body.length ? new Uint8Array(body) : undefined,
        })
      );

      response.statusCode = phpResponse.httpStatusCode;

      for (const [name, value] of Object.entries(phpResponse.headers)) {
        response.setHeader(name, value);
      }

      response.end(Buffer.from(phpResponse.bytes));
      log(`${request.method} ${request.url} ${phpResponse.httpStatusCode} ${Math.round(performance.now() - started)} ms`);
    } catch (error) {
      response.statusCode = 500;
      response.end(String(error?.stack ?? error));
      log(`${request.method} ${request.url} 500 ${error?.message ?? error}`);
    }
  });

  await new Promise((done) => server.listen(port, '127.0.0.1', done));

  return {
    url,
    php,
    close: () => new Promise((done) => server.close(() => done())),
  };
}
