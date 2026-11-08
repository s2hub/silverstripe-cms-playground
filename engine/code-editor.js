// The code editor of the playground: Monaco (the editor of VS Code) with the files of app/ as a tree and as tabs, a
// button to run dev/build and an output pane. A tutorial can open its files in it and follow what the learner does
// (onEvent).
//
// Files are read and written through the PHP worker, in PHP's in-memory filesystem; for a saved site the changes go
// into its snapshot like any other change.

import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/languages/definitions/php/register.js';
import 'monaco-editor/languages/definitions/yaml/register.js';
import 'monaco-editor/languages/definitions/html/register.js';
import 'monaco-editor/languages/definitions/css/register.js';
import 'monaco-editor/languages/definitions/javascript/register.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

monaco.editor.defineTheme('playground', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#2d3842',
    'editorGutter.background': '#2d3842',
    'editorLineNumber.foreground': '#ffffff99',
    'editorLineNumber.activeForeground': '#ffffff',
  },
});

/** Silverstripe templates (.ss) are HTML with template tags. */
const LANGUAGES = { php: 'php', yml: 'yaml', yaml: 'yaml', ss: 'html', html: 'html', css: 'css', scss: 'css', js: 'javascript', json: 'javascript' };

/**
 * What a new file starts with: a page type for a class in app/src/, a layout for a template in templates/Layout/.
 */
function starterContent(path) {
  const name = path.split('/').pop().replace(/\.[^.]+$/, '');

  if (/^app\/src\/.+\.php$/.test(path) && /^[A-Z]\w*$/.test(name)) {
    return `<?php

use SilverStripe\\Forms\\TextField;

class ${name} extends Page
{
    private static $db = [
        'Subtitle' => 'Varchar',
    ];

    public function getCMSFields()
    {
        $fields = parent::getCMSFields();
        $fields->addFieldToTab('Root.Main', TextField::create('Subtitle'), 'Content');

        return $fields;
    }
}
`;
  }

  if (/\/templates\/Layout\/.+\.ss$/.test(path)) {
    return `<div class="page__content">
    <h1 class="page__title">$Title</h1>
    <% if $Subtitle %>
        <p><strong>$Subtitle</strong></p>
    <% end_if %>
    $Content
    $Form
</div>
`;
  }

  return '';
}

/** The editor's markup; its parts are found by their classes. */
const TEMPLATE = `
  <nav class="ssp-code__files" aria-label="Files">
    <div class="ssp-code__files-head"><strong>app/</strong></div>
    <ul class="ssp-code__tree"></ul>
  </nav>
  <div class="ssp-code__main">
    <div class="ssp-code__tabs">
      <div class="ssp-code__tab-list" role="tablist" aria-label="Open files"></div>
      <div class="ssp-code__actions">
        <button class="ssp-small ssp-small--go ssp-code__save" type="button" disabled title="Save (Ctrl+S)">Save</button>
        <button class="ssp-small ssp-small--go ssp-code__new" type="button" title="Create a file in app/">New file</button>
        <button class="ssp-small ssp-code__build" type="button" title="Save all files and run dev/build?flush=1">dev/build</button>
      </div>
    </div>
    <div class="ssp-code__editor"><p class="ssp-code__empty">Open a file from the tree.</p></div>
    <pre class="ssp-code__output">dev/build output appears here</pre>
  </div>`;

/**
 * Builds the editor in a container (styles: ui.css).
 *
 * @param {HTMLElement} container
 * @param {object} options
 * @param {(type: string, payload?: object) => Promise<any>} options.call  Sends an action to the PHP worker
 *   (playground.call)
 * @param {() => void} options.reloadSite Reloads the site's iframe
 * @param {(message: string, isError?: boolean) => void} options.setStatus
 * @param {(event: {type: 'opened'|'saved'|'built', path?: string, ok?: boolean}) => void} [options.onEvent]
 * @param {boolean} [options.tree]        Show the file tree and "New file" (default true)
 * @param {'light'|'dark'} [options.output] Colours of the dev/build output (default light)
 */
export function createCodeEditor(container, { call, reloadSite, setStatus, onEvent = () => {}, tree = true, output = 'light' }) {
  container.classList.add('ssp-code', `ssp-code--output-${output}`);
  container.classList.toggle('ssp-code--no-tree', !tree);
  container.innerHTML = TEMPLATE;

  const find = (name) => container.querySelector(`.ssp-code__${name}`);
  const elements = {
    tree: find('tree'),
    tabs: find('tab-list'),
    editor: find('editor'),
    empty: find('empty'),
    output: find('output'),
    save: find('save'),
    newFile: find('new'),
    build: find('build'),
  };

  if (!tree) {
    find('files').remove();
    elements.newFile.remove();
    elements.empty.textContent = '';
  }

  const editor = monaco.editor.create(elements.editor, {
    automaticLayout: true,
    minimap: { enabled: false },
    fontFamily: '"Fira Code", ui-monospace, monospace',
    fontSize: 13,
    lineHeight: 22,
    padding: { top: 20 },
    tabSize: 4,
    insertSpaces: true,
    scrollBeyondLastLine: false,
    theme: 'playground',
  });

  // The font loads from Google Fonts: measure the characters again once it is there.
  document.fonts?.ready.then(() => monaco.editor.remeasureFonts());

  /** path -> { model, saved } (saved: the content as it is in the site); the open tabs, in order */
  const files = new Map();
  let tabs = [];
  let current = null;
  const placeholder = elements.output.textContent;

  const fail = (error) => setStatus(error.message, true);

  function isDirty(path) {
    const file = files.get(path);

    return Boolean(file) && file.model.getValue() !== file.saved;
  }

  function updateState() {
    elements.save.disabled = !current || !isDirty(current);
    elements.empty.hidden = Boolean(current);
    elements.editor.querySelector('.monaco-editor')?.toggleAttribute('hidden', !current);

    for (const item of elements.tree?.querySelectorAll('[data-path]') ?? []) {
      item.classList.toggle('active', item.dataset.path === current);
      item.classList.toggle('dirty', isDirty(item.dataset.path));
    }

    for (const tab of elements.tabs.querySelectorAll('[data-path]')) {
      tab.setAttribute('aria-selected', String(tab.dataset.path === current));
      tab.classList.toggle('dirty', isDirty(tab.dataset.path));
    }
  }

  function renderTabs() {
    elements.tabs.replaceChildren(
      ...tabs.map((path) => {
        const tab = Object.assign(document.createElement('div'), { className: 'ssp-code__tab', title: path });
        const name = Object.assign(document.createElement('span'), { className: 'ssp-code__tab-name', textContent: path.split('/').pop() });
        const close = Object.assign(document.createElement('button'), {
          type: 'button',
          className: 'ssp-code__tab-close',
          textContent: '×',
          title: 'Close',
        });

        tab.dataset.path = path;
        tab.setAttribute('role', 'tab');
        tab.tabIndex = 0;
        tab.onclick = () => open(path).catch(fail);
        tab.onkeydown = (event) => event.key === 'Enter' && open(path).catch(fail);
        close.onclick = (event) => {
          event.stopPropagation();
          closeTab(path);
        };
        tab.append(name, close);

        return tab;
      })
    );
    updateState();
  }

  /**
   * @param {string} path
   * @param {boolean} [reopen] When it is the current tab, open the one next to it
   */
  function closeTab(path, reopen = true) {
    if (isDirty(path) && !confirm(`${path} has unsaved changes. Close it anyway?`)) {
      return;
    }

    const index = tabs.indexOf(path);

    tabs = tabs.filter((tab) => tab !== path);
    files.get(path)?.model.dispose();
    files.delete(path);

    if (current === path) {
      current = null;
      editor.setModel(null);

      if (reopen && tabs.length > 0) {
        open(tabs[Math.min(index, tabs.length - 1)]).catch(fail);
      }
    }

    renderTabs();
  }

  async function renderTree() {
    if (!tree) {
      return;
    }

    const entries = await call('listFiles');

    elements.tree.replaceChildren(
      ...entries.map(({ path, type }) => {
        const depth = path.split('/').length - 1;
        const item = Object.assign(document.createElement('li'), { className: type, title: path });

        item.append(Object.assign(document.createElement('span'), { textContent: path.split('/').pop() + (type === 'dir' ? '/' : '') }));
        item.style.paddingLeft = `${depth * 12 + 12}px`;

        if (type === 'file') {
          const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'ssp-code__delete', textContent: '×', title: `Delete ${path}` });

          remove.onclick = (event) => {
            event.stopPropagation();
            deleteFile(path).catch(fail);
          };
          item.append(remove);
          item.dataset.path = path;
          item.onclick = () => open(path).catch(fail);
        }

        return item;
      })
    );
    updateState();
  }

  /** The file's model, read from the site the first time. */
  async function load(path) {
    if (!files.has(path)) {
      const content = await call('readFile', { path });
      const extension = path.split('.').pop().toLowerCase();
      const model = monaco.editor.createModel(content, LANGUAGES[extension] ?? 'plaintext', monaco.Uri.file(path));

      model.onDidChangeContent(updateState);
      files.set(path, { model, saved: content });
    }

    return files.get(path);
  }

  async function open(path, { focus = true } = {}) {
    const file = await load(path);

    if (!tabs.includes(path)) {
      tabs.push(path);
      renderTabs();
    }

    current = path;
    editor.setModel(file.model);

    if (focus) {
      editor.focus();
    }

    updateState();
    onEvent({ type: 'opened', path });
  }

  /** Writes a file into the site and keeps its tab, if open, in step. */
  async function write(path, content) {
    await call('writeFile', { path, content });

    const file = files.get(path);

    if (file) {
      file.saved = content;

      if (file.model.getValue() !== content) {
        file.model.setValue(content);
      }
    }

    updateState();
    onEvent({ type: 'saved', path });
  }

  async function save() {
    if (!current || !isDirty(current)) {
      return;
    }

    const path = current;

    await write(path, files.get(path).model.getValue());
    await flushAndReload(`Saved ${path}`);
  }

  async function saveAll() {
    for (const [path, file] of files) {
      if (isDirty(path)) {
        await write(path, file.model.getValue());
      }
    }
  }

  /**
   * Flushes the caches, so new classes, templates and config take effect, and reloads the site. Database changes
   * (new fields and classes) still need dev/build.
   */
  async function flushAndReload(message, hint = '') {
    setStatus(`${message}, flushing the caches`);

    const started = performance.now();
    const { status } = await call('flushCaches');

    setStatus(
      status >= 500
        ? `${message}; the site answers with an error (HTTP ${status}): see the preview`
        : `${message} and flushed in ${((performance.now() - started) / 1000).toFixed(1)} s${hint}`,
      status >= 500
    );
    reloadSite();
  }

  async function createFile() {
    const path = prompt(
      'New file (in app/), e.g. app/src/MyPage.php or app/templates/Layout/MyPage.ss:',
      'app/src/MyPage.php'
    )?.trim();

    if (!path) {
      return;
    }

    if (files.has(path) || elements.tree?.querySelector(`[data-path="${CSS.escape(path)}"]`)) {
      await open(path);

      return;
    }

    await call('writeFile', { path, content: starterContent(path) });
    await renderTree();
    await open(path);
    await flushAndReload(`Created ${path}`, path.endsWith('.php') ? '. Run dev/build to create its database table.' : '');
  }

  async function deleteFile(path) {
    if (!confirm(`Delete ${path}?`)) {
      return;
    }

    await call('deleteFile', { path });

    if (tabs.includes(path)) {
      files.get(path).saved = files.get(path).model.getValue();
      closeTab(path);
    }

    await renderTree();
    await flushAndReload(`Deleted ${path}`);
  }

  /** Saves all files and runs dev/build; true if it succeeded. */
  async function build() {
    await saveAll();
    elements.build.disabled = true;
    elements.output.classList.add('ssp-code__output--used');
    elements.output.classList.remove('ssp-code__output--error');
    elements.output.textContent = 'Running dev/build?flush=1 …';
    setStatus('Running dev/build');

    const started = performance.now();
    let ok = false;

    try {
      const { status, text } = await call('devBuild');
      const seconds = ((performance.now() - started) / 1000).toFixed(1);

      ok = status < 400 && /Database build completed/i.test(text);
      elements.output.textContent = text;
      elements.output.classList.toggle('ssp-code__output--error', !ok);
      elements.output.scrollTop = elements.output.scrollHeight;
      setStatus(ok ? `dev/build done in ${seconds} s` : `dev/build failed (HTTP ${status})`, !ok);
      reloadSite();
    } catch (error) {
      elements.output.textContent = error.message;
      elements.output.classList.add('ssp-code__output--error');
      fail(error);
    } finally {
      elements.build.disabled = false;
    }

    onEvent({ type: 'built', ok });

    return ok;
  }

  elements.save.onclick = () => save().catch(fail);
  elements.newFile.onclick = () => createFile().catch(fail);

  elements.build.onclick = () => build();
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save().catch(fail));

  return {
    /** Forgets the open files and reads the file list again, e.g. after a new playground started. */
    async reset() {
      for (const { model } of files.values()) {
        model.dispose();
      }

      files.clear();
      tabs = [];
      current = null;
      editor.setModel(null);
      elements.output.classList.remove('ssp-code__output--used', 'ssp-code__output--error');
      elements.output.textContent = placeholder;
      renderTabs();
      await renderTree();
    },
    renderTree,
    open,
    /** Shows exactly these files as tabs (unsaved changes elsewhere are kept), the first one active. */
    async showOnly(paths) {
      for (const path of tabs.filter((tab) => !paths.includes(tab) && !isDirty(tab))) {
        closeTab(path, false);
      }

      for (const path of paths) {
        await load(path);
      }

      tabs = [...paths, ...tabs.filter((tab) => !paths.includes(tab))];
      renderTabs();

      if (paths.length > 0) {
        await open(paths[0], { focus: false });
      }
    },
    /** The content of a file in the site (not the unsaved changes). */
    async read(path) {
      return files.has(path) ? files.get(path).saved : call('readFile', { path });
    },
    write,
    flushAndReload,
    build,
    hasUnsavedChanges: () => [...files.keys()].some(isDirty),
  };
}
