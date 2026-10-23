// Packs the site from bin/build-site.mjs for the browser, into web/public/silverstripe/:
//
// - site.zip:      the project, unpacked into PHP's in-memory filesystem by the PHP worker. Without tests, docs and
//                  source maps; public/_resources/ holds empty placeholders only: Silverstripe links a resource only
//                  when the file exists (SimpleResourceURLGenerator).
// - _resources/:   the real module and theme resources (CSS, JS, fonts, images), which the service worker serves as
//                  static files, without PHP.
// - manifest.json: versions of the bundle.
//
// Usage: node bin/build-browser-bundle.mjs [--site=build/site] [--out=web/public/silverstripe]

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const root = resolve(import.meta.dirname, '..');
const { values } = parseArgs({
  options: {
    site: { type: 'string', default: 'build/site' },
    out: { type: 'string', default: 'web/public/silverstripe' },
  },
});
const site = resolve(root, values.site);
const out = resolve(root, values.out);
const stage = resolve(root, 'build/bundle');

/** Paths (relative to the project) left out of site.zip. */
const SKIP = [
  /^\.(git|github)(\/|$)/,
  /^vendor\/.*\/(tests|docs|\.github|client\/src|node_modules)(\/|$)/,
  /^vendor\/.*\.(md|map)$/,
  /^vendor\/bin\//,
];

rmSync(out, { recursive: true, force: true });
rmSync(stage, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

function walk(directory, visit) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const relativePath = relative(site, path);

    if (SKIP.some((pattern) => pattern.test(relativePath))) {
      continue;
    }

    if (entry.isDirectory()) {
      walk(path, visit);
    } else if (entry.isFile()) {
      visit(path, relativePath);
    }
  }
}

let files = 0;
let placeholders = 0;

walk(site, (path, relativePath) => {
  const target = join(stage, relativePath);

  mkdirSync(join(target, '..'), { recursive: true });

  if (relativePath.startsWith('public/_resources/')) {
    writeFileSync(target, '');
    placeholders++;
  } else {
    cpSync(path, target, { preserveTimestamps: true });
    files++;
  }
});

// .env and the hidden folders' .htaccess files are needed too: zip includes dot files with -r.
execFileSync('zip', ['-r', '-9', '-q', '-X', join(out, 'site.zip'), '.'], { cwd: stage });
cpSync(join(site, 'public/_resources'), join(out, '_resources'), { recursive: true });
rmSync(stage, { recursive: true, force: true });

const lock = JSON.parse(readFileSync(join(site, 'composer.lock'), 'utf8'));
const version = (name) => lock.packages.find((item) => item.name === name)?.version ?? null;
const manifest = {
  silverstripe: version('silverstripe/framework'),
  cms: version('silverstripe/cms'),
  sqlite3: version('silverstripe/sqlite3'),
  elemental: version('dnadesign/silverstripe-elemental'),
  built: new Date().toISOString(),
};

writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const size = (path) => `${(statSync(path).size / 1048576).toFixed(1)} MB`;

console.log(`site.zip: ${files} files and ${placeholders} placeholders, ${size(join(out, 'site.zip'))}`);
console.log(`Bundle in ${out}:`, manifest);
