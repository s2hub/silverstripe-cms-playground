// A handle between two panes that sets the width of the first one by dragging (or the arrow keys).

/**
 * @param {HTMLElement} handle  The handle, between the panes
 * @param {HTMLElement} pane    The pane before it, whose width it sets
 * @param {object} [options]
 * @param {string} [options.storageKey] Remembers the width in localStorage under this key
 * @param {number} [options.min]        Smallest width of each pane in pixels (default 240)
 */
export function createSplitter(handle, pane, { storageKey = null, min = 240 } = {}) {
  handle.classList.add('ssp-splitter');
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.tabIndex = 0;

  function setWidth(width) {
    const parent = pane.parentElement.getBoundingClientRect();
    const start = pane.getBoundingClientRect().left - parent.left;
    const clamped = Math.max(min, Math.min(width, parent.width - start - min));

    pane.style.width = `${clamped}px`;
    pane.style.flex = '0 0 auto';

    return clamped;
  }

  function remember(width) {
    try {
      storageKey && localStorage.setItem(storageKey, String(Math.round(width)));
    } catch {
      // Without storage the width is not remembered.
    }
  }

  try {
    const saved = storageKey && Number(localStorage.getItem(storageKey));

    if (saved) {
      requestAnimationFrame(() => setWidth(saved));
    }
  } catch {
    // Without storage the width is not remembered.
  }

  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('ssp-resizing');

    const offset = event.clientX - pane.getBoundingClientRect().right;
    let width = pane.getBoundingClientRect().width;

    const move = (moveEvent) => {
      width = setWidth(moveEvent.clientX - offset - pane.getBoundingClientRect().left);
    };
    const stop = () => {
      document.body.classList.remove('ssp-resizing');
      handle.removeEventListener('pointermove', move);
      remember(width);
    };

    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop, { once: true });
    handle.addEventListener('pointercancel', stop, { once: true });
  });

  handle.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 100 : 20;
    const delta = { ArrowLeft: -step, ArrowRight: step }[event.key];

    if (delta) {
      event.preventDefault();
      remember(setWidth(pane.getBoundingClientRect().width + delta));
    }
  });
}
