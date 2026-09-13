import fs from 'node:fs';
import pathUtil from 'node:path';

const ROOT = pathUtil.join(import.meta.dirname, '..');

const patchFile = (relativePath, label, patches) => {
  const fullPath = pathUtil.join(ROOT, relativePath);
  let content;
  try {
    content = fs.readFileSync(fullPath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log(`[patch] ${label} not found, skipping`);
      return;
    }
    throw err;
  }

  let patched = content;
  for (const {test, apply} of patches) {
    if (!test(patched)) {
      console.log(`[patch] ${label}: no matching pattern found, skipping`);
      continue;
    }
    patched = apply(patched);
  }

  if (patched === content) {
    console.log(`[patch] ${label}: no changes needed`);
    return;
  }

  fs.writeFileSync(fullPath, patched, 'utf-8');
  console.log(`[patch] ${label}: patched successfully`);
};

// Patch 1: Settings.jsx - remove undefined `settingsSection` from named export
patchFile(
  'node_modules/scratch-gui/src/community/pages/Settings.jsx',
  'Settings.jsx',
  [{
    test: (c) => /export\s*\{[^}]*settingsSection[^}]*\};?\s*$/m.test(c),
    apply: (c) => c.replace(
      /export\s*\{[^}]*settingsSection[^}]*\};?\s*$/m,
      (match) => match.replace(/\s*settingsSection\s*,?\s*/g, '')
    )
  }]
);

// Patch 2: WarpThemePanel.jsx - fix `try` without `catch`/`finally` in confirmDeleteTheme
//
// The test must stay anchored to `try {` directly followed by the DELETE
// request. A looser pattern (e.g. `try { ... await request(...)`) also matches
// the *correct* code in scratch-gui's develop branch, which uses a `run(...)`
// helper instead, and would then corrupt it by injecting references to
// `setDeleteError`/`releaseDelete`/`setBusy`.
patchFile(
  'node_modules/scratch-gui/src/community/components/WarpThemePanel.jsx',
  'WarpThemePanel.jsx',
  [{
    test: (c) => /try\s*\{\s*await request\(`\/theme\?uuid=[\s\S]*?await refresh\(\);\s*\}\);/m.test(c),
    apply: (c) => c.replace(
      /(try\s*\{\s*await request\(`\/theme\?uuid=[\s\S]*?await refresh\(\);\s*)\}\);/m,
      '$1} catch (err) {\n            setDeleteError(err.message || \'Failed to delete theme\');\n        } finally {\n            releaseDelete();\n            setBusy(false);\n        }'
    )
  }]
);

// Patch 3: toast-notification.jsx - add `sequence` to props destructuring.
//
// Only applies when the file actually references `sequence`: on scratch-gui's
// develop branch the prop does not exist at all, so the patch must be a no-op
// there instead of adding a dead destructured binding.
patchFile(
  'node_modules/scratch-gui/src/components/toast-notification/toast-notification.jsx',
  'toast-notification.jsx',
  [{
    test: (c) => /\bsequence\b/.test(c) &&
      !/const\s*\{[^}]*\bsequence\b[^}]*\}\s*=\s*props/.test(c),
    apply: (c) => c.replace(
      /const\s*\{\s*message\s*,\s*type\s*=\s*'info'\s*,\s*position\s*=\s*'top-right'\s*,\s*visible\s*,\s*onClose\s*\}\s*=\s*props/,
      "const {message, type = 'info', position = 'top-right', visible, onClose, sequence} = props"
    )
  }]
);

// Patch 4: menu-bar.jsx - restore the imports that were dropped from the file.
//
// A bad `-X theirs` sync on develop-builds deleted the whole import block from
// this file while keeping its call sites, so the shipped editor threw
// `ReferenceError: getProjectHistoryState is not defined` from MenuBar's
// constructor and rendered the "Desktop React Error" boundary instead of the
// editor. `subscribeProjectHistory` (componentDidMount) and `preloadProjectHistory`
// (save) crash the same way, hence all three must come back together; the
// MistWarp save flow additionally needs createMwp/downloadBlob/projectFilename.
//
// Each entry is only restored when the target module really exists in the
// installed scratch-gui, so this patch stays a no-op on the regenerated
// develop-builds (which matches develop and no longer has the stray call sites)
// and can never introduce an import that fails to resolve.
const MENU_BAR_MODULES = [
  ['lib/git/project-history.js', ['getProjectHistoryState', 'preloadProjectHistory', 'subscribeProjectHistory']],
  ['lib/git/mwp.js', ['createMwp']],
  ['lib/utils/download-blob.js', ['downloadBlob']],
  ['lib/utils/safe-filename.js', ['projectFilename']]
].filter(([modulePath]) => fs.existsSync(pathUtil.join(ROOT, 'node_modules/scratch-gui/src', modulePath)));

const isMissing = (content, name) => (
  new RegExp(`\\b${name}\\b`).test(content) &&
  !new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`).test(content)
);

patchFile(
  'node_modules/scratch-gui/src/components/menu-bar/menu-bar.jsx',
  'menu-bar.jsx',
  [{
    test: (c) => MENU_BAR_MODULES.some(([, names]) => names.some((name) => isMissing(c, name))),
    apply: (c) => {
      const statements = MENU_BAR_MODULES
        .map(([modulePath, names]) => [modulePath, names.filter((name) => isMissing(c, name))])
        .filter(([, names]) => names.length)
        .map(([modulePath, names]) => `import {${names.join(', ')}} from '../../${modulePath}';`)
        .join('\n');
      return c.replace(/^(import\s+)/m, `${statements}\n$1`);
    }
  }]
);