// Serves a Silverstripe site with PHP in WebAssembly.
// Usage: node wasm/serve.mjs [--site=build/site] [--port=8791] [--php=8.4]

import { parseArgs } from 'node:util';
import { serve } from './silverstripe-wasm.mjs';

const { values } = parseArgs({
  options: {
    site: { type: 'string', default: 'build/site' },
    port: { type: 'string', default: '8791' },
    php: { type: 'string', default: '8.4' },
  },
});

const { url } = await serve({ site: values.site, port: Number(values.port), phpVersion: values.php, log: console.log });

console.log(`Serving ${values.site} at ${url}`);
