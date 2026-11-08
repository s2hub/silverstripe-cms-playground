// The preview of the site: an address bar (a path of the site, optionally Site and CMS buttons) above the iframe.

import globeIcon from './icons/globe.svg';

/**
 * Builds the preview in a container (styles: ui.css).
 *
 * @param {HTMLElement} container
 * @param {object} [options]
 * @param {boolean} [options.toggles]  Site and CMS buttons in the address bar (default true)
 * @param {string} [options.meta]      Text at the end of the address bar, e.g. the admin's login
 * @param {(path: string) => void} [options.onNavigate] Called with the path of each page the iframe shows
 */
export function createPreview(container, { toggles = true, meta = '', onNavigate = () => {} } = {}) {
  container.classList.add('ssp-preview');
  container.innerHTML = `
    <form class="ssp-preview__bar">
      <img src="${globeIcon}" width="14" height="14" alt="">
      <input class="ssp-preview__url" type="text" aria-label="Path of the page" spellcheck="false" autocomplete="off" disabled>
      <span class="ssp-preview__toggles">
        <button class="ssp-small" type="button" data-view="site" disabled>Site</button>
        <button class="ssp-small" type="button" data-view="admin" disabled>CMS</button>
      </span>
      <span class="ssp-preview__meta"></span>
    </form>
    <div class="ssp-preview__frame"><iframe title="Silverstripe site"></iframe></div>`;

  const form = container.querySelector('form');
  const input = container.querySelector('.ssp-preview__url');
  const frame = container.querySelector('iframe');
  const site = container.querySelector('[data-view="site"]');
  const admin = container.querySelector('[data-view="admin"]');
  let siteUrl = null;
  let path = '/';

  container.querySelector('.ssp-preview__meta').textContent = meta;

  if (!toggles) {
    container.querySelector('.ssp-preview__toggles').remove();
  }

  /** The path of the page in the iframe, below the site's URL; null for a page elsewhere. */
  function currentPath() {
    try {
      const href = frame.contentWindow.location.href;

      return siteUrl && href.startsWith(siteUrl) ? href.slice(siteUrl.length) || '/' : null;
    } catch {
      return null;
    }
  }

  function update() {
    const isAdmin = /^\/admin(\/|$|\?)/.test(path);

    input.value = path;
    site.setAttribute('aria-pressed', String(!isAdmin));
    admin.setAttribute('aria-pressed', String(isAdmin));
  }

  const preview = {
    /** The iframe, e.g. to put something over it (its parent is positioned). */
    frame,
    get path() {
      return path;
    },
    /** The URL of the running site (playground.info.siteUrl); null while none runs. */
    setSiteUrl(url) {
      siteUrl = url;

      for (const element of [input, site, admin]) {
        element.disabled = !url;
      }

      if (!url) {
        frame.src = 'about:blank';
      }
    },
    /** Opens a path of the site, e.g. "/admin/pages". */
    go(target) {
      path = target.startsWith('/') ? target : `/${target}`;
      update();
      frame.src = `${siteUrl}${path}`;
    },
    reload() {
      frame.contentWindow?.location.reload();
    },
    setMeta(text, title = '') {
      const element = container.querySelector('.ssp-preview__meta');

      element.textContent = text;
      element.title = title;
    },
  };

  function check() {
    const loaded = currentPath();

    if (loaded !== null && loaded !== path) {
      path = loaded;
      update();
      onNavigate(path);
    }
  }

  // The CMS changes pages without loading them (pushState): watch the address too, not only the load event.
  frame.addEventListener('load', () => {
    path = null;
    check();
  });
  setInterval(check, 500);

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    if (siteUrl && input.value.trim()) {
      preview.go(input.value.trim());
    }
  });

  site.onclick = () => preview.go('/');
  admin.onclick = () => preview.go('/admin/');
  preview.setSiteUrl(null);
  update();

  return preview;
}
