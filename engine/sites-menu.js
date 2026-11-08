// "My sites": a menu with the sites saved in this browser, to open, rename or delete them.

import { deleteSite, isSiteOpen, listSites, renameSite } from './storage.js';
import sitesIcon from './icons/sites.svg';

/**
 * Builds the menu in a container (styles: app.css, classes ssp-menu and ssp-action).
 *
 * @param {HTMLElement} container
 * @param {object} options
 * @param {(slug: string) => string} options.link The URL that opens a saved site
 * @returns {{onOpen: (() => void) | null}} Set onOpen to be told when the menu opens
 */
export function createSitesMenu(container, { link }) {
  const menu = { onOpen: null };
  const details = Object.assign(document.createElement('details'), { className: 'ssp-menu' });

  details.innerHTML = `
    <summary class="ssp-action"><img src="${sitesIcon}" width="17" height="15" alt="">My sites</summary>
    <ul class="ssp-menu__list"></ul>`;
  container.replaceWith(details);

  const list = details.querySelector('ul');

  async function render() {
    const sites = await listSites();

    list.replaceChildren();

    if (sites.length === 0) {
      list.append(Object.assign(document.createElement('li'), { className: 'ssp-menu__empty', textContent: 'No saved sites yet' }));

      return;
    }

    for (const site of sites) {
      const item = document.createElement('li');
      const open = Object.assign(document.createElement('a'), { href: link(site.slug), textContent: site.title });
      const details = Object.assign(document.createElement('span'), {
        className: 'ssp-menu__details',
        textContent: `Silverstripe ${site.silverstripe} · ${new Date(site.updated).toLocaleString()}`,
      });
      const actions = Object.assign(document.createElement('span'), { className: 'ssp-menu__actions' });
      const rename = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Rename' });
      const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'ssp-menu__delete', textContent: 'Delete' });

      rename.onclick = async () => {
        const title = prompt('New name for this site:', site.title)?.trim();

        if (title && title !== site.title) {
          await renameSite(site.slug, title);
          await render();
        }
      };

      remove.onclick = async () => {
        if (await isSiteOpen(site.slug)) {
          alert(`"${site.title}" is open in a tab. Close it first (or start a new playground there).`);

          return;
        }

        if (confirm(`Delete "${site.title}" from this browser? This cannot be undone.`)) {
          await deleteSite(site.slug);
          await render();
        }
      };

      actions.append(rename, remove);
      item.append(open, details, actions);
      list.append(item);
    }
  }

  details.addEventListener('toggle', () => {
    if (details.open) {
      menu.onOpen?.();
      render();
    }
  });

  // Closes when something else is clicked.
  document.addEventListener('click', (event) => details.open && !details.contains(event.target) && (details.open = false));

  return menu;
}
