import * as fs from 'node:fs';
import * as pathUtil from 'node:path';
import { persistentFetch } from './lib.mjs';

const SOURCE = 'https://raw.githubusercontent.com/PenguinMod/PenguinMod-ExtensionsGallery/main/src/lib/extensions.js';

const outputPath = pathUtil.join(import.meta.dirname, '../dist-renderer-webpack/editor/penguinmod/extensions.js');

const isAlreadyDownloaded = () => {
  try {
    const data = fs.readFileSync(outputPath, 'utf8');
    return data.includes('export default');
  } catch (e) {
    return false;
  }
};

if (isAlreadyDownloaded()) {
  console.log('PenguinMod extensions already downloaded');
  process.exit(0);
}

console.log(`Downloading ${SOURCE}`);
console.time('Download PenguinMod extensions');

persistentFetch(SOURCE)
  .then((res) => res.text())
  .then((code) => {
    if (!code.includes('export default')) {
      throw new Error('Invalid PenguinMod module: missing export default');
    }

    const wrapped = `
// AUTO-GENERATED — DO NOT EDIT
// Source: ${SOURCE}
// Synced at: ${new Date().toISOString()}

${code}
`;

    fs.mkdirSync(pathUtil.dirname(outputPath), {
      recursive: true
    });
    fs.writeFileSync(outputPath, wrapped, 'utf8');
    console.log(`Wrote ${outputPath}`);
    console.timeEnd('Download PenguinMod extensions');
    process.exitCode = 0;
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
