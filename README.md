# Silverstripe Playground

A complete Silverstripe CMS site in your browser tab: no server, no installation, no account. PHP is compiled to
WebAssembly, and the site and its SQLite database live in the tab's memory. Comparable to
[WordPress Playground](https://wordpress.org/playground/), whose PHP-in-WebAssembly runtime (`@php-wasm/*`) it
uses, and modelled on the [Joomla Playground](https://github.com/HermanPeeren/joomla-playground).

The site is [silverstripe-playground-site](https://github.com/s2hub/silverstripe-playground-site), a small
Silverstripe CMS 6 project to learn from (content blocks, a ModelAdmin, sample content), running on
[`silverstripe/sqlite3`](https://github.com/silverstripe/silverstripe-sqlite3). It is an ordinary project and can be
used without the playground too.

The playground is also an **engine** for other sites: [Explore Silverstripe](https://github.com/s2hub/explore-silverstripe)
uses it for tutorials (see "Using the engine" below).

## Using it

After a few seconds the CMS opens, logged in as `admin`, with the code on the left and the site on the right
(drag the line between them to change the widths). The password is new for every playground; the address bar
above the site shows it. Type a path into the address bar to open it; **Site** and **CMS** next to it switch
between the front end and the CMS. The **Code** switch at the bottom left shows or hides the code.

| Button | What it does |
|---|---|
| **Reset** | Start a new playground from the same link. A saved site stays saved (under **My sites**). |
| **Save** | Keep this playground in your browser under a name. From then on, changes are saved as you work. |
| **Download project** | Download the site as an ordinary project to run with ddev (see below). |
| **My sites** | Open, rename or delete the sites you saved. |
| **Tutorials** | Explore Silverstripe, the tutorials. |

**Temporary or saved?**

- A new playground is temporary: reloading the page or closing the tab throws it away.
- After **Save**, the address bar shows `?site=<name>`. That address reopens the site, also after a reload or a
  browser restart. A saved site keeps its admin password.
- A saved site stays in this browser only (in its private storage for this website, OPFS). It can be open in one tab
  at a time.

**Taking it home.** **Download project** gives a zip with the site as an ordinary Silverstripe project: the code
(without `vendor/`), `content/dump.sql` and `content/assets/` with the content, ddev settings and a git repository
with one commit. Unzip it and run `ddev start` in its folder: the first start runs `composer install` and
`dev/build`, then loads the content (`.ddev/playground-setup.sh`). Log in with `admin` / `password`.

**Building something.** The code is an editor (Monaco, the editor of VS Code) with the files in `app/` as a tree
and the open ones as tabs:

1. **New file** → `app/src/EventPage.php` starts as a page type with a `Subtitle` field.
2. **dev/build** creates its database tables (and flushes the caches); the output shows below the editor.
3. In the CMS, **Add new Page** now offers *Event Page*.
4. **New file** → `app/templates/Layout/EventPage.ss` starts as a layout that shows the subtitle.

**Save** (Ctrl+S) above the code writes the file, flushes Silverstripe's caches and reloads the site, so changed classes,
templates and config show at once; new database fields need **dev/build**. In a saved site, the code is saved too.

**Things to extend.** The site explains itself: its pages *How it is built* and *Try it* show where things are
(content blocks, the **Contacts** ModelAdmin with a preview of each contact, a block of its own) and give small
tasks, e.g. a new field for contacts or a block of your own.

| Parameter | Example | What it does |
|---|---|---|
| `site` | `?site=my-site` | Open a site saved in this browser |
| `url` | `?url=/about` | The page to open first; default `/admin/pages` |
| `login` | `?login=no` | Start logged out |
| `code` | `?code=no` | Start with the code hidden |

## How it works

```
 Browser tab  (engine/app.js: toolbar, code editor, preview iframe)
   iframe -> <playground>/scope-<id>/admin/pages
       | fetch
       v
 Service worker (engine/sw.js)
   |- /scope-<id>/_resources/...  -> static files (silverstripe/_resources/)
   '- everything else             -> BroadcastChannel -> PHP worker of the tab (engine/php-worker.js)
                                                         PHP 8.4 (WebAssembly) + PHPRequestHandler
                                                         project in memory (/var/www/silverstripe)
                                                         SQLite database, cookie store with the admin session
```

- **`bin/build-site.mjs`** builds `build/site`: it fetches the site repository (`bin/site-source.mjs`), copies
  `overlay/` on top (SQLite `.env`, the playground module), requires `silverstripe/sqlite3`, installs with Composer,
  runs `sake db:build` and `sake tasks:seed-content` in WebAssembly (`@php-wasm/node`) and visits every page once to
  fill the caches. `--source=../silverstripe-playground-site` builds from a local checkout instead.
- **`bin/build-browser-bundle.mjs`** packs `build/site` as the site bundle in `build/bundle/`: `site.zip` (16 MB),
  `manifest.json`, and the module and theme resources as static files (`_resources/`).
- **`engine/`** runs it in the browser (see "Using the engine"). Each playground gets a random admin password and its
  scope URL (`SS_BASE_URL`) through a PHP file that runs before every request (`engine/prepend.js`).
- **`web/`** is this repository's page (Vite): the full playground of the engine.
- **The project download** (`engine/export-project.php`, run by the PHP worker) writes the database as MySQL
  INSERTs and leaves the tables to `dev/build`, so no schema has to be translated from SQLite; it builds the git
  objects and index itself. The build keeps the project's own `composer.json`/`composer.lock` in `.playground/`
  for it.
- **Saved sites** (`engine/storage.js`) are stored as the zip they started from plus a snapshot of the files that
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
- The PHP worker keeps the cookies (the admin session) and sends its own requests (login, flush, dev/build) with the
  browser's User-Agent: Silverstripe ends a session whose User-Agent changes.
- It logs in with "Remember me": a session ends after 24 minutes without requests, and the remember-me cookie logs
  the admin in again on the next one. Logging out in the CMS ends that too.

## Using the engine

The repository is also the npm package `silverstripe-playground` (install it from GitHub:
`npm install github:s2hub/silverstripe-cms-playground`), for sites that run the playground themselves, like Explore
Silverstripe. Its modules (`engine/`, plain ES modules for Vite):

| Import | What it is |
|---|---|
| `silverstripe-playground` | `createPlayground()`: starts Silverstripe in a PHP worker (`boot()`, `call()`, `save()`, `downloadProject()`); re-exports the preview, the splitter and the saved-site functions |
| `silverstripe-playground/app` | `mountPlayground(element, options)`: the whole playground of this repository |
| `silverstripe-playground/code-editor` | `createCodeEditor(element, options)`: Monaco with tabs, optionally the file tree; events for opened and saved files and dev/build |
| `silverstripe-playground/preview` | `createPreview(element, options)`: address bar and iframe |
| `silverstripe-playground/splitter` | `createSplitter(handle, pane)`: drag to resize |
| `silverstripe-playground/sites-menu` | `createSitesMenu(element, options)`: "My sites" |
| `silverstripe-playground/ui.css`, `/app.css` | Styles of the parts and of the playground |
| `silverstripe-playground/vite` | Vite plugin: `silverstripePlayground({ bundle })` configures @php-wasm, serves and emits the service worker and the site bundle |

The site bundle is not part of the package. Every build of main publishes it as `silverstripe-bundle.zip` in the
release [bundle](https://github.com/s2hub/silverstripe-cms-playground/releases/tag/bundle) (`npm run bundle:zip`).

## Development

Needs Node 24 (22 works), Composer and git. PHP on the host is only used by Composer.

```bash
npm install
npm run build          # site + bundle (build/bundle) + web app in web/dist
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
