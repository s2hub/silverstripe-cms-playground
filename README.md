# Silverstripe Playground

A complete Silverstripe CMS site in your browser tab: no server, no installation, no account. PHP is compiled to
WebAssembly, and the site and its SQLite database live in the tab's memory. Comparable to
[WordPress Playground](https://wordpress.org/playground/), whose PHP-in-WebAssembly runtime (`@php-wasm/*`) it
uses, and modelled on the [Joomla Playground](https://github.com/HermanPeeren/joomla-playground).

The site is [silverstripe-playground-site](https://github.com/s2hub/silverstripe-playground-site), a small
Silverstripe CMS 6 project to learn from (content blocks, a ModelAdmin, sample content), running on
[`silverstripe/sqlite3`](https://github.com/silverstripe/silverstripe-sqlite3). It is an ordinary project and can be
used without the playground too.

## Using it

After a few seconds the CMS opens, logged in as `admin`. The password is new for every playground; the toolbar
shows it.

| Button | What it does |
|---|---|
| **Site** / **CMS** | Show the front end or the CMS. |
| **Code** | Edit the project's code in `app/` next to the site (see below). |
| **Reset** | Start a new playground from the same link. A saved site stays saved (under **My sites**). |
| **Save…** | Keep this playground in your browser under a name. From then on, changes are saved as you work. |
| **Download project** | Download the site as an ordinary project to run with ddev (see below). |
| **My sites** | Open, rename or delete the sites you saved. |

**Temporary or saved?**

- A new playground is temporary: reloading the page or closing the tab throws it away.
- After **Save…**, the address bar shows `?site=<name>`. That address reopens the site, also after a reload or a
  browser restart. A saved site keeps its admin password.
- A saved site stays in this browser only (in its private storage for this website, OPFS). It can be open in one tab
  at a time.

**Taking it home.** **Download project** gives a zip with the site as an ordinary Silverstripe project: the code
(without `vendor/`), `content/dump.sql` and `content/assets/` with the content, ddev settings and a git repository
with one commit. Unzip it and run `ddev start` in its folder: the first start runs `composer install` and
`dev/build`, then loads the content (`.ddev/playground-setup.sh`). Log in with `admin` / `password`.

**Building something.** **Code** opens an editor (Monaco, the editor of VS Code) with the files in `app/`:

1. **New file** → `app/src/EventPage.php` starts as a page type with a `Subtitle` field.
2. **dev/build** creates its database tables (and flushes the caches); the output shows below the editor.
3. In the CMS, **Add new Page** now offers *Event Page*.
4. **New file** → `app/templates/Layout/EventPage.ss` starts as a layout that shows the subtitle.

**Save** (Ctrl+S) writes the file, flushes Silverstripe's caches and reloads the site, so changed classes,
templates and config show at once; new database fields need **dev/build**. In a saved site, the code is saved too.

**Things to extend.** The site explains itself: its pages *How it is built* and *Try it* show where things are
(content blocks, the **Contacts** ModelAdmin with a preview of each contact, a block of its own) and give small
tasks, e.g. a new field for contacts or a block of your own.

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

- **`bin/build-site.mjs`** builds `build/site`: it fetches the site repository (`bin/site-source.mjs`), copies
  `overlay/` on top (SQLite `.env`, the playground module), requires `silverstripe/sqlite3`, installs with Composer,
  runs `sake db:build` and `sake tasks:seed-content` in WebAssembly (`@php-wasm/node`) and visits every page once to
  fill the caches. `--source=../silverstripe-playground-site` builds from a local checkout instead.
- **`bin/build-browser-bundle.mjs`** packs `build/site` as `web/public/silverstripe/site.zip` (16 MB) and copies
  the module and theme resources next to it as static files.
- **`web/`** is the static playground (Vite). Each playground gets a random admin password and its scope URL
  (`SS_BASE_URL`) through a PHP file that runs before every request (`web/src/prepend.js`).
- **The project download** (`web/src/export-project.php`, run by the PHP worker) writes the database as MySQL
  INSERTs and leaves the tables to `dev/build`, so no schema has to be translated from SQLite; it builds the git
  objects and index itself. The build keeps the project's own `composer.json`/`composer.lock` in `.playground/`
  for it.
- **Saved sites** (`web/src/storage.js`) are stored as the zip they started from plus a snapshot of the files that
  changed since (the SQLite database, assets), which the PHP worker rewrites shortly after requests that change
  files. Caches are left out of snapshots; the base brings them.

Things that differ from a server:

- `ext-intl` is required by Silverstripe 6 and loaded on request (`withIntl`), which adds the ICU data (31 MB) to the
  download.
- The browser's PHP has GD but no Imagick; the image driver is set to GD in the playground's own module
  (`overlay/playground/`, kept out of `app/` so the code editor shows the site's code only).
- oEmbed lookups (embedded videos) are cached at build time and kept, because most oEmbed hosts do not allow
  cross-origin requests.
- The playground logs in with a `BackURL` to the CMS, so the site needs no `Security.default_login_dest`.
- Mail is not sent (`MAILER_DSN="null://null"`).
- The CMS loads the scripts of a PJAX response (e.g. the combined TinyMCE file) with synchronous XHRs, which Chrome
  may send past the service worker to the web server. `PlaygroundLeftAndMainExtension` makes them asynchronous.
- `dev/build` does not VACUUM the SQLite database: in the browser it runs while the session's queries are open.

## Development

Needs Node 24 (22 works), Composer and git. PHP on the host is only used by Composer.

```bash
npm install
npm run build          # site + bundle + web app in web/dist
npm run site -- --source=../silverstripe-playground-site   # the site from a local checkout
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
