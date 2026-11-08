# Plan: tutorial variants

*Status: proposal from 2026-10-23, partly overtaken (2026-11-07):* tutorials are now step-by-step guides in
[explore-silverstripe](https://github.com/s2hub/explore-silverstripe) (`tutorials/<slug>/tutorial.yml`), which
uses this repository as its engine; each tutorial starts from the same site and changes it step by step. Tutorial
modules switched on and off (below) remain an option for tutorials that need a different starting site.

## Goal

The playground should offer several configurations of the site for tutorials: one with a ModelAdmin, one with a
custom controller and views, and more later. A tutorial starts from a link (`?tutorial=…`), shows its code in the
editor, and can be reset to its start. The variants should stay ordinary Silverstripe code that runs with ddev too.

Not the goal: running arbitrary other Silverstripe projects (see "Other ideas" below).

## Constraints

- The playground ships one prebuilt `vendor/` (in `site.zip`, about 16 MB). Composer cannot run in the browser:
  Packagist and the package downloads send no CORS headers. So all variants must share one `composer.lock`.
- Silverstripe loads everything it finds in a project: classes, templates, YAML config. Variants side by side are
  all active at once unless they are excluded.
- Silverstripe finds modules only at the project root (depth 1) or in `vendor/<vendor>/<name>/`, not in deeper
  folders such as `tutorials/<name>/` (`ManifestFileFinder::isDirectoryModule()`).

## Options considered

| | Branches in the site repo | Folders copied into `app/` | Modules switched on and off |
|---|---|---|---|
| A variant is | a branch, a complete project | `tutorials/<name>/app/…`, copied by a script | a module folder `tutorial-<name>/` |
| Run one locally | `git checkout`, `ddev start` | script copies it into `app/`, `ddev start` | script switches it on, `dev/build` |
| Difference between variants | `git diff a..b` | `diff -r` | the module folder itself |
| Shared changes (theme, Composer) | merge into every branch | once | once |
| Combine variants | no | no | yes |
| Playground | one bundle part per variant | one bundle part per variant | one bundle, switched at start |

**Preferred: modules switched on and off.** It stays one ordinary project, shared changes are made once, the code of
a tutorial is exactly its module folder, and tutorials can be combined.

## Design

### Site repository (`s2hub/silverstripe-playground-site`)

```
app/                         the base: Page with content blocks, theme config, base pages
tutorial-modeladmin/         Contact, ContactCategory, ContactAdmin, ContactsBlock, ContactController, sample data
  _config/  src/  templates/  client/  tutorial.yml
tutorial-controller/         a custom controller with views and templates
  _config/  src/  templates/  tutorial.yml
```

- **Switch:** an empty file `_manifest_exclude` in a module folder switches it off: Silverstripe then ignores its
  classes, templates and config. A script switches modules centrally and runs `sake db:build --flush`, e.g.
  `composer tutorial modeladmin` (or `composer tutorial modeladmin controller`, `composer tutorial none`).
  The committed state: all tutorial modules off (only the base active), or a documented default.
- **Namespaces:** one per tutorial (`Tutorial\ModelAdmin\…`, `Tutorial\Controller\…`), so modules never clash.
- **Content:** each module creates its own sample pages and records when it is on (`requireDefaultRecords()` or its
  own seed task); the base seed (`tasks:seed-content`) creates only the base pages.
- **`tutorial.yml`:** title, description, landing page (e.g. `/admin/contacts`), files to open in the editor,
  optionally other tutorials it needs (`requires`).
- **Composer packages** a tutorial needs go into the shared `composer.json`; they are installed for all but only
  become active through the module's config.

### Playground (`s2hub/silverstripe-cms-playground`)

- **Build:** unchanged in principle: one `site.zip` with all tutorial modules, all switched off; `db:build` and the
  base seed run at build time. The build reads the `tutorial.yml` files into the bundle's `manifest.json` (the list
  of tutorials).
- **Start:** `?tutorial=controller` (or `modeladmin,controller`): the PHP worker removes the modules'
  `_manifest_exclude`, runs `dev/build?flush=1` (about 1 s), opens the landing page and the code editor with the
  tutorial's files. A menu in the toolbar lists the tutorials (from `manifest.json`).
- **Code editor:** shows `app/` and the active tutorial modules (`EDITABLE` in `php-worker.js` becomes dynamic).
- **Reset** starts the tutorial again from the bundle. Switching tutorials means a fresh start, not switching a
  module off in a running site (see risks).
- **Saved sites** remember their tutorials (meta.json); **Download project** keeps the switches (the
  `_manifest_exclude` files), so the ddev project starts with the same tutorials on.

## Steps

1. Site repo: move the contacts code into `tutorial-modeladmin/` with its namespace, its own sample data and
   `tutorial.yml`; slim the base seed down to the base pages.
2. Site repo: the switch script (`composer tutorial …`) and a README section; check with ddev.
3. Site repo: second module `tutorial-controller/` (custom controller, actions, views, templates).
4. Playground: tutorials in `manifest.json`, `?tutorial=`, switching in the worker, toolbar menu, editor folders.
5. Playground: saved sites and the project download keep the tutorials; README.

## Risks and open questions

- **Switching off a module in a running site** leaves its records and tables; pages of a page type that no longer
  exists break. Hence: tutorials are chosen at the start only.
- **Start and solution states:** one module per tutorial (the solution), or two (`tutorial-x-start`,
  `tutorial-x-solution`) so a learner can compare or reveal the solution?
- **What is the base?** Only pages with content blocks, or more?
- **Instructions:** a panel with the tutorial's steps, from a Markdown file in the module (`TUTORIAL.md`)?
- **Which tutorials first?** ModelAdmin (today's contacts) and "Custom controller and views"; more ideas: a content
  block of your own, forms, a JSON API/controller, extensions.

## Other ideas from the same discussion (not planned yet)

- **Save automatically:** the plain URL reopens the last state, saved in the browser; only an explicit reset starts
  fresh. Open points: links with a fixed start state, a broken state after a PHP error, saved states after a
  playground update (static resources from the new bundle, `vendor/` from the old one), several tabs.
- **`?repo=owner/name@ref`:** load a GitHub repository's files (the GitHub API and raw.githubusercontent.com send
  CORS headers, zip archives do not) over the bundle's `vendor/`, if its `composer.lock` matches; load
  `content/dump.sql` if present. Useful as a preview for tutorial authors.
- **Projects with other dependencies:** a reusable GitHub Action that builds a bundle for any project and publishes
  it, opened with `?bundle=<url>`.
