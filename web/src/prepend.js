// The PHP file that runs before every script of the playground (auto_prepend_file), in the browser and in Node.

export const PREPEND_FILE = '/internal/shared/playground-prepend.php';

/**
 * Builds the prepend file.
 *
 * - @php-wasm leaves out SERVER_PROTOCOL, which Silverstripe reads when it sends headers
 *   (HTTPResponse::outputHeaders()).
 * - The environment variables of this playground, e.g. SS_BASE_URL (the scope URL in the browser) and the admin
 *   password. Silverstripe's .env loader does not override variables that are already set.
 *
 * @param {Record<string, string>} env
 */
export function prependCode(env = {}) {
  const lines = Object.entries(env).map(
    ([name, value]) => `putenv(${JSON.stringify(`${name}=${value}`)}); $_ENV[${JSON.stringify(name)}] = ${JSON.stringify(value)};`
  );

  return `<?php
$_SERVER['SERVER_PROTOCOL'] ??= 'HTTP/1.1';
${lines.join('\n')}
`;
}
