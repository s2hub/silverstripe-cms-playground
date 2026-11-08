// The full playground: a toolbar (Reset, Save, Download project, My sites, Tutorials), the code editor with the
// file tree and the preview (with Site and CMS in its address bar), side by side with a splitter, and a floating
// switch to show or hide the code. Used by this repository's page and by
// sites that offer the playground themselves (e.g. Explore Silverstripe).
//
// URL parameters: ?site=<slug> opens a site saved in this browser (without it, a new temporary playground starts),
// ?url=<path> sets the page to open first (default: the CMS), ?login=no starts logged out, ?code=no hides the code.

import { createPlayground } from './index.js';
import { createPreview } from './preview.js';
import { createSplitter } from './splitter.js';
import { createSitesMenu } from './sites-menu.js';
import logoMark from './icons/logo-mark.svg';
import logoText from './icons/logo-text.svg';
import resetIcon from './icons/reset.svg';
import saveIcon from './icons/save.svg';
import downloadIcon from './icons/download.svg';
import tutorialsIcon from './icons/tutorials.svg';
import tutorialsDarkIcon from './icons/tutorials-dark.svg';
import './ui.css';
import './app.css';

const TEMPLATE = ({ home, tutorials }) => `
  <header class="ssp-toolbar">
    <a class="ssp-logo" href="${home}" title="Explore Silverstripe">
      <img src="${logoMark}" width="36" height="27" alt="">
      <img src="${logoText}" width="147" height="16" alt="Explore Silverstripe">
    </a>
    <span class="ssp-status" role="status">Loading</span>
    <div class="ssp-toolbar__group ssp-toolbar__actions">
      <button class="ssp-action" type="button" data-action="reset" disabled title="Start a new playground from the same link (a saved site stays saved)">
        <img src="${resetIcon}" width="15" height="15" alt="">Reset
      </button>
      <button class="ssp-action" type="button" data-action="save" disabled title="Keep this playground in your browser">
        <img src="${saveIcon}" width="15" height="15" alt="">Save
      </button>
      <button class="ssp-action" type="button" data-action="download" disabled title="Download the site as a project to run with ddev: code, content and a git repository">
        <img src="${downloadIcon}" width="16" height="15" alt="">Download project
      </button>
      <span data-slot="sites"></span>
      ${tutorials ? `<a class="ssp-action" href="${tutorials}"><img src="${tutorialsIcon}" width="20" height="15" alt="">Tutorials</a>` : ''}
    </div>
  </header>
  <main class="ssp-workspace">
    <section class="ssp-workspace__code" aria-label="Code"></section>
    <div class="ssp-workspace__splitter" aria-label="Resize the code and the preview"></div>
    <section class="ssp-workspace__preview" aria-label="Preview"></section>
    <button class="ssp-code-toggle" type="button" data-action="code" disabled aria-pressed="true" title="Show or hide the code in app/">
      <span class="ssp-code-toggle__switch" aria-hidden="true"></span>Code
    </button>
  </main>`;

/**
 * @param {HTMLElement} root  Gets the whole playground (it fills the root; make the root fill the window)
 * @param {object} [options]
 * @param {string} [options.home]      Where the logo links to (default: this page without parameters)
 * @param {string} [options.tutorials] Where "Tutorials" links to; no link without
 * @param {string} [options.base]      See createPlayground()
 */
export function mountPlayground(root, { home = '?', tutorials = '', base } = {}) {
  root.classList.add('ssp-app');
  root.innerHTML = TEMPLATE({ home, tutorials });

  const $ = (selector) => root.querySelector(selector);
  const buttons = Object.fromEntries([...root.querySelectorAll('[data-action]')].map((button) => [button.dataset.action, button]));
  const status = $('.ssp-status');
  const codePane = $('.ssp-workspace__code');

  function setStatus(message, isError = false) {
    status.textContent = message;
    status.title = message;
    status.classList.toggle('ssp-status--error', isError);
  }

  const playground = createPlayground({ base, onProgress: (message) => setStatus(message) });
  const preview = createPreview($('.ssp-workspace__preview'));
  const sitesMenu = createSitesMenu($('[data-slot="sites"]'), { link: (slug) => `?site=${encodeURIComponent(slug)}` });

  if (tutorials) {
    const fab = Object.assign(document.createElement('a'), { className: 'ssp-fab', href: tutorials });

    fab.innerHTML = `<img src="${tutorialsDarkIcon}" width="20" height="15" alt="">Tutorials`;
    preview.frame.parentElement.append(fab);
  }

  createSplitter($('.ssp-workspace__splitter'), codePane, { storageKey: 'silverstripe-playground:code-width' });

  /** The code editor: Monaco is large, so it is loaded once the playground runs. */
  let codeEditor = null;

  async function loadCodeEditor() {
    if (!codeEditor) {
      const { createCodeEditor } = await import('./code-editor.js');

      codeEditor = createCodeEditor(codePane, {
        call: playground.call,
        setStatus,
        reloadSite: () => preview.reload(),
      });
    }

    await codeEditor.reset();
  }

  function setBusy(busy) {
    for (const name of ['code', 'reset', 'download']) {
      buttons[name].disabled = busy;
    }

    // A saved site is saved already.
    buttons.save.disabled = busy || Boolean(playground.info?.site);
  }

  function showReady() {
    const { info } = playground;
    const seconds = (info.timings.ready / 1000).toFixed(1);

    setStatus(`Ready in ${seconds} s (${info.site ? `saved as "${info.site}"` : 'temporary'})`);
    preview.setMeta(
      `${info.username} / ${info.password}`,
      `Silverstripe ${info.manifest.silverstripe} · PHP ${info.phpVersion}\n`
        + Object.entries(info.timings).map(([step, ms]) => `${step}: ${ms} ms`).join('\n')
    );
    setBusy(false);

    // For tests and debugging.
    window.silverstripePlayground = info;
  }

  function toggleCode() {
    const open = codePane.hidden;

    codePane.hidden = !open;
    buttons.code.setAttribute('aria-pressed', String(open));
  }

  /**
   * Starts a new playground from the bundle, with the same link: landing page and login stay, a saved site is left
   * (it stays in the browser).
   */
  function reset() {
    const message = playground.info?.site
      ? `Start a new playground? "${playground.info.site}" stays saved under My sites.`
      : 'Throw this playground away and start a new one?';

    if (confirm(message)) {
      const url = new URL(location.href);

      url.searchParams.delete('site');
      location.href = url.href;
    }
  }

  async function save() {
    const title = prompt('Save this playground in your browser as:', 'My Silverstripe site')?.trim();

    if (!title) {
      return;
    }

    setBusy(true);

    try {
      const { freeSlug } = await import('./storage.js');
      const site = await freeSlug(title);

      await playground.save(site, title);

      const url = new URL(location.href);

      url.searchParams.set('site', site);
      url.searchParams.delete('url');
      history.replaceState(null, '', url.href);
      showReady();
    } catch (error) {
      setStatus(error.message, true);
      setBusy(false);
    }
  }

  /**
   * Downloads the site as an ordinary Silverstripe project to run with ddev, with its content and a git repository.
   */
  async function download() {
    setBusy(true);
    setStatus('Exporting the project');

    try {
      // Also the name of the ddev project: letters, digits and hyphens (a saved site's slug is one).
      const folder = playground.info.site ?? 'silverstripe-playground-export';
      const bytes = await playground.downloadProject(folder);
      const link = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(new Blob([bytes], { type: 'application/zip' })),
        download: `${folder}-${new Date().toISOString().slice(0, 10)}.zip`,
      });

      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10000);
      showReady();
      setStatus('Downloaded: unzip it and run "ddev start" in the folder');
    } catch (error) {
      setStatus(error.message, true);
      setBusy(false);
    }
  }

  buttons.code.onclick = toggleCode;
  buttons.reset.onclick = reset;
  buttons.save.onclick = save;
  buttons.download.onclick = download;
  sitesMenu.onOpen = () => playground.flush();

  // A saved site writes its changes shortly after requests; when the tab is hidden or closed, write them now.
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && playground.flush());
  addEventListener('pagehide', () => playground.flush());

  async function start() {
    const url = new URL(location.href);
    const site = url.searchParams.get('site');
    const login = url.searchParams.get('login') !== 'no';
    const landingPage = url.searchParams.get('url') ?? (login ? '/admin/pages' : '/');

    if (url.searchParams.get('code') === 'no') {
      toggleCode();
    }

    setBusy(true);
    await playground.boot({ ...(site ? { site } : {}), login });
    preview.setSiteUrl(playground.info.siteUrl);
    preview.go(landingPage);
    showReady();
    await loadCodeEditor();
  }

  start().catch((error) => {
    console.error(error);
    setStatus(error.message, true);

    // No playground runs: only starting a new one makes sense.
    buttons.reset.disabled = false;
  });

  return playground;
}
