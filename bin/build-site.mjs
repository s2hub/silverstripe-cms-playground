// Builds the playground's Silverstripe site in build/site from demo.silverstripe.org.
//
// 1. Fetches the demo project at a pinned commit (nothing of it is kept in this repository).
// 2. Swaps its MySQL/DynamoDB setup for SQLite: removes silverstripe/dynamodb and the demo reset task (which needs
//    symfony/process, mysql and rsync), requires silverstripe/sqlite3.
// 3. Copies overlay/ on top (.env, no Google Analytics).
// 4. Installs with Composer; module resources are copied into public/_resources (no symlinks).
// 5. Builds the database with PHP in WebAssembly, at the same path the browser uses, so the manifest cache in
//    silverstripe-cache/ is valid there too.
// 6. Imports the demo's content from its reset dump (.reset/), without members.
// 7. Visits every page, to fill the caches.
//
// Usage: node bin/build-site.mjs [--out=build/site]

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEMO_COMMIT, DEMO_REPOSITORY } from './demo.mjs';
import { PROJECT_ROOT, runCli, runSake, serve } from '../wasm/silverstripe-wasm.mjs';

const root = resolve(import.meta.dirname, '..');
const { values } = parseArgs({ options: { out: { type: 'string', default: 'build/site' } } });
const out = resolve(root, values.out);

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd: out, stdio: 'inherit', ...options });
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// The demo at the pinned commit, without its git history.
run('git', ['init', '--quiet']);
run('git', ['fetch', '--quiet', '--depth=1', DEMO_REPOSITORY, DEMO_COMMIT]);
run('git', ['checkout', '--quiet', 'FETCH_HEAD']);
rmSync(resolve(out, '.git'), { recursive: true, force: true });

rmSync(resolve(out, 'app/src/DemoResetTask.php'));
cpSync(resolve(root, 'overlay'), out, { recursive: true });

// ext-intl is needed at runtime only (the WebAssembly PHP has it); the host PHP may lack it.
const composerEnv = { ...process.env, SS_VENDOR_METHOD: 'copy', COMPOSER_NO_INTERACTION: '1', COMPOSER_IGNORE_PLATFORM_REQ: 'ext-intl' };

run('composer', ['remove', '--no-install', 'silverstripe/dynamodb', 'symfony/process'], { env: composerEnv });
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

// The demo's content: its database dump (without members) and its assets.
cpSync(resolve(root, 'bin/import-demo-content.php'), resolve(out, 'silverstripe-cache/import-demo-content.php'));
await inWasm('import-demo-content.php', runCli, [
  `${PROJECT_ROOT}/silverstripe-cache/import-demo-content.php`,
  `${PROJECT_ROOT}/.reset/db_reset.sql`,
  `${PROJECT_ROOT}/database/silverstripe.sqlite`,
]);
rmSync(resolve(out, 'silverstripe-cache/import-demo-content.php'));
cpSync(resolve(out, '.reset/assets_reset'), resolve(out, 'public/assets'), { recursive: true });

// Brings the imported records up to date with this version's schema and writes the static error pages.
await inWasm('sake db:build', runSake, ['db:build']);

// Visits every page once: fills the caches in silverstripe-cache/, above all the oEmbed results (see
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
