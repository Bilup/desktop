import fs from 'node:fs';
import pathUtil from 'node:path';

const SETTINGS_PATH = pathUtil.join(
  import.meta.dirname, '..',
  'node_modules', 'scratch-gui', 'src', 'community', 'pages', 'Settings.jsx'
);

try {
  const content = fs.readFileSync(SETTINGS_PATH, 'utf-8');

  // Match the export line that includes the undefined `settingsSection`
  const original = /export\s*\{[^}]*settingsSection[^}]*\};?\s*$/m;
  if (!original.test(content)) {
    console.log('[patch] Settings.jsx does not need patching');
    process.exit(0);
  }

  const patched = content.replace(original, (match) => {
    // Remove `settingsSection` (and the trailing comma if present) from the export
    return match.replace(/\s*settingsSection\s*,?\s*/g, '');
  });

  // Verify the patch didn't produce an empty export `{}` or `{, ...}`
  if (/export\s*\{\s*,?\s*\};?\s*$/.test(patched) || /export\s*\{\s*,\s*/.test(patched)) {
    console.error('[patch] Patching would result in broken export syntax, aborting');
    process.exit(1);
  }

  fs.writeFileSync(SETTINGS_PATH, patched, 'utf-8');
  console.log('[patch] Removed undefined `settingsSection` from Settings.jsx exports');
} catch (err) {
  if (err.code === 'ENOENT') {
    console.log('[patch] Settings.jsx not found, skipping');
    process.exit(0);
  }
  console.error('[patch] Failed to patch Settings.jsx:', err.message);
  process.exit(1);
}