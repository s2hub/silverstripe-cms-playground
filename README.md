# Silverstripe Playground

A complete Silverstripe CMS site in your browser tab: no server, no installation, no account. PHP is compiled to
WebAssembly, and the site and its SQLite database live in the tab's memory. Comparable to
[WordPress Playground](https://wordpress.org/playground/), whose PHP-in-WebAssembly runtime (`@php-wasm/*`) it
uses, and modelled on the [Joomla Playground](https://github.com/HermanPeeren/joomla-playground).

The site is [demo.silverstripe.org](https://github.com/silverstripe/demo.silverstripe.org) (Silverstripe CMS 6)
with its demo content, running on [`silverstripe/sqlite3`](https://github.com/silverstripe/silverstripe-sqlite3).

## Using it

After a few seconds the CMS opens, logged in as `admin`. The password is new for every playground; the toolbar
shows it.

| Button | What it does |
|---|---|
| **Site** / **CMS** | Show the front end or the CMS. |
| **New** | Start a new playground. |
| **Start over** | Throw this playground away and start again from the same link. |
| **Save…** | Keep this playground in your browser under a name. From then on, changes are saved as you work. |
| **Export** | Download the whole site as a zip. |
| **Import…** | Start a playground from such a zip. |
| **My sites** | Open, rename or delete the sites you saved. |

**Temporary or saved?**

- A new playground is temporary: reloading the page or closing the tab throws it away.
- After **Save…**, the address bar shows `?site=<name>`. That address reopens the site, also after a reload or a
  browser restart. A saved site keeps its admin password.
- A saved site stays in this browser only (in its private storage for this website, OPFS); use **Export** to move it
  elsewhere. It can be open in one tab at a time.

| Parameter | Example | What it does |
|---|---|---|
| `site` | `?site=my-site` | Open a site saved in this browser |
| `url` | `?url=/about` | The page to open first; default `/admin/pages` |
| `login` | `?login=no` | Start logged out |

## How it works

```
 Browser tab  (index.html + main.js: toolbar, iframe)
   iframe -> <playground>/scope-<id>/admin/pages
       | fetch
       v
 Service worker (web/public/sw.js)
   |- /scope-<id>/_resources/...  -> static files (silverstripe/_resources/)
   '- everything else             -> BroadcastChannel -> PHP worker of the tab (web/src/php-worker.js)
                                                         PHP 8.4 (WebAssembly) + PHPRequestHandler
                                                         project in memory (/var/www/silverstripe)
                                                         SQLite database, cookie store with the admin session
```

- **`bin/build-site.mjs`** builds `build/site`: it fetches the demo at a pinned commit (`bin/demo.mjs`), replaces
  DynamoDB/MySQL with SQLite, copies `overlay/` on top, installs with Composer, runs `sake db:build` in
  WebAssembly (`@php-wasm/node`), imports the demo content from the demo's reset dump (pages, files and settings,
  no members; `bin/import-demo-content.php`) and visits every page once to fill the caches.
- **`bin/build-browser-bundle.mjs`** packs `build/site` as `web/public/silverstripe/site.zip` (17 MB) and copies
  the module and theme resources next to it as static files.
- **`web/`** is the static playground (Vite). Each playground gets a random admin password and its scope URL
  (`SS_BASE_URL`) through a PHP file that runs before every request (`web/src/prepend.js`).
- **Saved sites** (`web/src/storage.js`) are stored as the zip they started from plus a snapshot of the files that
  changed since (the SQLite database, assets), which the PHP worker rewrites shortly after requests that change
  files. Caches are left out of snapshots; the base brings them.

Things that differ from a server:

- `ext-intl` is required by Silverstripe 6 and loaded on request (`withIntl`), which adds the ICU data (31 MB) to the
  download.
- The browser's PHP has GD but no Imagick; the image driver is set to GD in `overlay/app/_config/playground.yml`.
- oEmbed lookups (e.g. the Vimeo video on "Theme styles") are cached at build time and kept, because most oEmbed
  hosts do not allow cross-origin requests.
- Mail is not sent (`MAILER_DSN="null://null"`).
- The CMS loads the scripts of a PJAX response (e.g. the combined TinyMCE file) with synchronous XHRs, which Chrome
  may send past the service worker to the web server. `overlay/app/src/PlaygroundLeftAndMainExtension.php` makes
  them asynchronous.

## Development

Needs Node 24 (22 works), Composer and git. PHP on the host is only used by Composer.

```bash
npm install
npm run build          # site + bundle + web app in web/dist
npm run web:preview    # http://localhost:5411/
```

Single steps: `npm run site`, `npm run bundle`, `npm run web:build` or `npm run web:dev`.

The site also runs in Node, without a browser:

```bash
npm run wasm:serve                     # http://127.0.0.1:8791/ (admin / password)
npm run wasm:sake -- db:build --flush  # sake in WebAssembly
```

Service workers need HTTPS or localhost. Tested in Chrome.

## License

GNU General Public License version 2 or later, like WordPress Playground and the Joomla Playground, from which the
service worker and PHP worker are adapted.
