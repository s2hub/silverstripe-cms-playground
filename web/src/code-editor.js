// The code editor of the playground: Monaco (the editor of VS Code) with the files of app/, a button to run dev/build
// and an output pane. It is loaded when the Code panel opens for the first time (see main.js).
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

/**
 * @param {object} options
 * @param {HTMLElement} options.root     The Code panel
 * @param {(type: string, payload?: object) => Promise<any>} options.call  Sends an action to the PHP worker
 * @param {() => void} options.reloadSite Reloads the site's iframe
 * @param {(message: string, isError?: boolean) => void} options.setStatus
 */
export function createCodeEditor({ root, call, reloadSite, setStatus }) {
  const elements = {
    tree: root.querySelector('#file-tree'),
    path: root.querySelector('#code-path'),
    editor: root.querySelector('#code-editor'),
    output: root.querySelector('#code-output'),
    save: root.querySelector('#code-save'),
    newFile: root.querySelector('#code-new'),
    remove: root.querySelector('#code-delete'),
    build: root.querySelector('#code-build'),
  };

  const editor = monaco.editor.create(elements.editor, {
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    tabSize: 4,
    insertSpaces: true,
    scrollBeyondLastLine: false,
    theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'vs-dark' : 'vs',
  });

  /** path -> { model, saved } (saved: the content as it is in the site) */
  const files = new Map();
  let current = null;

  function isDirty(path) {
    const file = files.get(path);

    return Boolean(file) && file.model.getValue() !== file.saved;
  }

  function updateState() {
    elements.path.textContent = current ? `${current}${isDirty(current) ? ' •' : ''}` : 'No file open';
    elements.save.disabled = !current || !isDirty(current);
    elements.remove.disabled = !current;

    for (const item of elements.tree.querySelectorAll('[data-path]')) {
      item.classList.toggle('active', item.dataset.path === current);
      item.classList.toggle('dirty', isDirty(item.dataset.path));
    }
  }

  async function renderTree() {
    const entries = await call('listFiles');

    elements.tree.replaceChildren(
      ...entries.map(({ path, type }) => {
        const depth = path.split('/').length - 1;
        const item = Object.assign(document.createElement('li'), {
          className: type,
          textContent: path.split('/').pop() + (type === 'dir' ? '/' : ''),
          title: path,
        });

        item.style.paddingLeft = `${depth * 12 + 8}px`;

        if (type === 'file') {
          item.dataset.path = path;
          item.onclick = () => open(path);
        }

        return item;
      })
    );
    updateState();
  }

  async function open(path) {
    if (!files.has(path)) {
      const content = await call('readFile', { path });
      const extension = path.split('.').pop().toLowerCase();
      const model = monaco.editor.createModel(content, LANGUAGES[extension] ?? 'plaintext', monaco.Uri.file(path));

      model.onDidChangeContent(updateState);
      files.set(path, { model, saved: content });
    }

    current = path;
    editor.setModel(files.get(path).model);
    editor.focus();
    updateState();
  }

  async function save() {
    if (!current || !isDirty(current)) {
      return;
    }

    const file = files.get(current);
    const content = file.model.getValue();

    await call('writeFile', { path: current, content });
    file.saved = content;
    updateState();
    await flushAndReload(`Saved ${current}`);
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

    if (files.has(path) || elements.tree.querySelector(`[data-path="${CSS.escape(path)}"]`)) {
      await open(path);

      return;
    }

    try {
      await call('writeFile', { path, content: starterContent(path) });
      await renderTree();
      await open(path);
      await flushAndReload(`Created ${path}`, path.endsWith('.php') ? '. Run dev/build to create its database table.' : '');
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  async function deleteFile() {
    if (!current || !confirm(`Delete ${current}?`)) {
      return;
    }

    await call('deleteFile', { path: current });
    files.get(current)?.model.dispose();
    files.delete(current);
    current = null;
    editor.setModel(null);
    await renderTree();
    await flushAndReload('Deleted');
  }

  async function build() {
    // Unsaved changes would not be built: save them first.
    for (const [path, file] of files) {
      if (isDirty(path)) {
        await call('writeFile', { path, content: file.model.getValue() });
        file.saved = file.model.getValue();
      }
    }

    updateState();
    elements.build.disabled = true;
    elements.output.hidden = false;
    elements.output.classList.remove('error');
    elements.output.textContent = 'Running dev/build?flush=1 …';
    setStatus('Running dev/build');

    const started = performance.now();

    try {
      const { status, text } = await call('devBuild');
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      const failed = status >= 400 || !/Database build completed/i.test(text);

      elements.output.textContent = text;
      elements.output.classList.toggle('error', failed);
      elements.output.scrollTop = elements.output.scrollHeight;
      setStatus(failed ? `dev/build failed (HTTP ${status})` : `dev/build done in ${seconds} s`, failed);
      reloadSite();
    } catch (error) {
      elements.output.textContent = error.message;
      elements.output.classList.add('error');
      setStatus(error.message, true);
    } finally {
      elements.build.disabled = false;
    }
  }

  elements.save.onclick = () => save().catch((error) => setStatus(error.message, true));
  elements.newFile.onclick = createFile;
  elements.remove.onclick = () => deleteFile().catch((error) => setStatus(error.message, true));
  elements.build.onclick = build;
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save().catch((error) => setStatus(error.message, true)));

  return {
    /** Reads the file list again, e.g. after a new playground started. */
    async reset() {
      for (const { model } of files.values()) {
        model.dispose();
      }

      files.clear();
      current = null;
      editor.setModel(null);
      elements.output.hidden = true;
      await renderTree();
    },
    hasUnsavedChanges: () => [...files.keys()].some(isDirty),
  };
}
