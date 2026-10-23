// Builds the playground's Silverstripe site in build/site from the site repository (see site-source.mjs).
//
// 1. Fetches the site at its ref (nothing of it is kept in this repository), or copies a local checkout (--source).
// 2. Keeps the project's composer files in .playground/ (for the project download) and copies overlay/ on top:
//    .env for SQLite, and the playground module (settings for PHP in WebAssembly).
// 3. Requires silverstripe/sqlite3 and installs with Composer; module resources are copied into public/_resources
//    (no symlinks).
// 4. Builds the database with PHP in WebAssembly, at the same path the browser uses, so the manifest cache in
//    silverstripe-cache/ is valid there too, and creates the sample content (sake tasks:seed-content).
// 5. Visits every page, to fill the caches.
//
// Usage: node bin/build-site.mjs [--out=build/site] [--source=<git URL or local folder>] [--ref=<branch, tag, commit>]

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { SITE_REF, SITE_REPOSITORY } from './site-source.mjs';
import { runSake, serve } from '../wasm/silverstripe-wasm.mjs';

const root = resolve(import.meta.dirname, '..');
const { values } = parseArgs({
  options: {
    out: { type: 'string', default: 'build/site' },
    source: { type: 'string', default: SITE_REPOSITORY },
    ref: { type: 'string', default: SITE_REF },
  },
});
const out = resolve(root, values.out);

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd: out, stdio: 'inherit', ...options });
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const localSource = existsSync(values.source) && statSync(values.source).isDirectory() ? resolve(values.source) : null;

if (localSource) {
  // The files of a local checkout that git would commit: tracked and new ones, without the ignored (vendor/, .env).
  console.log(`$ copying ${localSource}`);
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: localSource })
    .toString()
    .split('\0')
    .filter((file) => file && existsSync(resolve(localSource, file)));

  for (const file of files) {
    mkdirSync(dirname(resolve(out, file)), { recursive: true });
    cpSync(resolve(localSource, file), resolve(out, file));
  }
} else {
  // The site at its ref, without its git history.
  run('git', ['init', '--quiet']);
  run('git', ['fetch', '--quiet', '--depth=1', values.source, values.ref]);
  run('git', ['checkout', '--quiet', 'FETCH_HEAD']);
  rmSync(resolve(out, '.git'), { recursive: true, force: true });
}

// The project's own composer files, for the project download (web/src/export-project.php): the build adds sqlite3.
mkdirSync(resolve(out, '.playground'), { recursive: true });

for (const file of ['composer.json', 'composer.lock']) {
  cpSync(resolve(out, file), resolve(out, '.playground', file));
}

cpSync(resolve(root, 'overlay'), out, { recursive: true });

// ext-intl is needed at runtime only (the WebAssembly PHP has it); the host PHP may lack it.
const composerEnv = { ...process.env, SS_VENDOR_METHOD: 'copy', COMPOSER_NO_INTERACTION: '1', COMPOSER_IGNORE_PLATFORM_REQ: 'ext-intl' };

run('composer', ['require', '--no-install', 'silverstripe/sqlite3:^4'], { env: composerEnv });
run('composer', ['install', '--no-dev', '--optimize-autoloader'], { env: composerEnv });

// Silverstripe keeps its caches in silverstripe-cache/ when that folder exists in the project.
mkdirSync(resolve(out, 'silverstripe-cache'), { recursive: true });
mkdirSync(resolve(out, 'database'), { recursive: true });

async function inWasm(description, runner, args) {
  console.log(`$ ${description} (WebAssembly)`);
  const { exitCode, output } = await runner({ site: out, args });

  process.stdout.write(output);

  if (exitCode !== 0) {
    throw new Error(`${description} failed with exit code ${exitCode}`);
  }
}

await inWasm('sake db:build --flush', runSake, ['db:build', '--flush']);
await inWasm('sake tasks:seed-content', runSake, ['tasks:seed-content']);

// Visits every page once: fills the caches in silverstripe-cache/, e.g. oEmbed results (see
// overlay/playground/_config/playground.yml), which the browser could not fetch.
console.log('$ Visiting the pages (WebAssembly)');
const server = await serve({ site: out, port: 8799 });
const seen = new Set(['/']);
const queue = ['/'];

while (queue.length) {
  const path = queue.shift();
  const response = await fetch(new URL(path, server.url));
  const html = await response.text();

  console.log(`  ${response.status} ${path}`);

  if (!response.ok) {
    throw new Error(`${path} answered HTTP ${response.status}`);
  }

  for (const [, link] of html.matchAll(/href="(\/[^"#?]*)"/g)) {
    if (!seen.has(link) && !/^\/(_resources|assets|admin|Security)\b/.test(link) && !/\.\w+$/.test(link)) {
      seen.add(link);
      queue.push(link);
    }
  }
}

console.log(`Site built in ${out}`);

// The PHP instances keep Node's event loop alive.
process.exit(0);
