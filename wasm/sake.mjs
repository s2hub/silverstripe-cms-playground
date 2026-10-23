// Runs Silverstripe's sake CLI with PHP in WebAssembly.
// Usage: node wasm/sake.mjs [--site=build/site] [--php=8.4] -- <sake arguments>

import { parseArgs } from 'node:util';
import { runSake } from './silverstripe-wasm.mjs';

const { values, positionals } = parseArgs({
  options: {
    site: { type: 'string', default: 'build/site' },
    php: { type: 'string', default: '8.4' },
  },
  allowPositionals: true,
});

const { exitCode, output } = await runSake({ site: values.site, args: positionals, phpVersion: values.php });

process.stdout.write(output);
process.exit(exitCode);
