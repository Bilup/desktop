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

// Patch 2: Create rotur/git-api.js stub for sync-remotes.js
const roturDir = pathUtil.join(ROOT, 'node_modules/scratch-gui/src/lib/rotur');
const roturStub = pathUtil.join(roturDir, 'git-api.js');
if (!fs.existsSync(roturStub)) {
  if (!fs.existsSync(roturDir)) {
    fs.mkdirSync(roturDir, {recursive: true});
  }
  fs.writeFileSync(roturStub, `// Stub created by patch-scratch-gui-settings.mjs
// Referenced by ../git/sync-remotes.js but missing from the develop-builds package.
export const getAuth = () => null;
export const isRoturGitUrl = () => false;
`, 'utf-8');
  console.log('[patch] rotur/git-api.js: created stub');
} else {
  console.log('[patch] rotur/git-api.js: already exists');
}

// Patch 3: WarpThemePanel.jsx - fix `try` without `catch`/`finally` in confirmDeleteTheme
patchFile(
  'node_modules/scratch-gui/src/community/components/WarpThemePanel.jsx',
  'WarpThemePanel.jsx',
  [{
    test: (c) => /try\s*\{[\s\S]*?await request\(`\/theme\?uuid=[\s\S]*?setSelected\(null\);\s*await refresh\(\);\s*\}\);/m.test(c),
    apply: (c) => c.replace(
      /(try\s*\{[\s\S]*?await request\(`\/theme\?uuid=[\s\S]*?setSelected\(null\);\s*await refresh\(\);\s*)\}\);/m,
      '$1} catch (err) {\n            setDeleteError(err.message || \'Failed to delete theme\');\n        } finally {\n            releaseDelete();\n            setBusy(false);\n        }'
    )
  }]
);