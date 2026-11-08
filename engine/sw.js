// Service worker of the Silverstripe Playground (adapted from the Joomla Playground's).
//
// Requests from the site's iframe go to a URL like <playground>/scope-<id>/admin/pages: the tab's scope. This worker
// answers them: _resources/ files (module and theme CSS, JS, fonts, images) come from the static bundle
// (silverstripe/_resources/), everything else is sent over a BroadcastChannel to the PHP worker of the tab that owns
// the scope, which runs Silverstripe.

const channel = new BroadcastChannel('silverstripe-playground');
const pending = new Map();
const TIMEOUT_MS = 120000;

channel.onmessage = ({ data }) => {
  if (data?.type === 'response' && pending.has(data.id)) {
    pending.get(data.id)(data);
    pending.delete(data.id);
  }
};

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const base = new URL('./', self.registration.scope);

  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
    return;
  }

  const match = url.pathname.substring(base.pathname.length).match(/^(scope-[a-z0-9]+)(\/.*)?$/);

  if (!match) {
    return;
  }

  const [, scope, path = '/'] = match;

  if (path.startsWith('/_resources/')) {
    event.respondWith(fetch(new URL(`silverstripe${path}${url.search}`, base)));

    return;
  }

  event.respondWith(runInPhp(event.request, scope));
});

async function runInPhp(request, scope) {
  const id = crypto.randomUUID();
  const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
  const headers = Object.fromEntries(request.headers.entries());

  const response = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(null);
    }, TIMEOUT_MS);

    pending.set(id, (data) => {
      clearTimeout(timer);
      resolve(data);
    });

    channel.postMessage({ type: 'request', id, scope, request: { url: request.url, method: request.method, headers, body } });
  });

  if (!response) {
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>Playground stopped</title>'
        + '<p style="font-family:sans-serif">This Silverstripe Playground is not running any more. Reload the playground page to start a new one.</p>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }

  // Navigations do not accept a constructed 3xx response; Response.redirect() makes a real redirect.
  const location = response.headers.location?.[0];

  if ([301, 302, 303, 307, 308].includes(response.status) && location) {
    return Response.redirect(new URL(location, request.url).href, response.status);
  }

  const responseHeaders = new Headers();

  for (const [name, values] of Object.entries(response.headers)) {
    // The PHP worker keeps the cookies; a service worker response cannot set them anyway.
    if (name.toLowerCase() !== 'set-cookie') {
      for (const value of values) {
        responseHeaders.append(name, value);
      }
    }
  }

  const nullBody = [101, 204, 205, 304].includes(response.status);

  return new Response(nullBody ? null : response.body, { status: response.status, headers: responseHeaders });
}
