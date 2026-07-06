import pathUtil from 'node:path';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import Builder from '@bilup/extensions/builder';

const mode = 'desktop';
const builder = new Builder(mode);
const build = await builder.build();
console.log(`Built bilup extensions (mode: ${mode})`);

const outputDirectory = pathUtil.join(import.meta.dirname, '../dist-bilup-extensions/');
const tempDirectory = pathUtil.join(import.meta.dirname, '../dist-bilup-extensions-temp/');
fs.rmSync(tempDirectory, {
  recursive: true,
  force: true,
});

const brotliCompress = promisify(zlib.brotliCompress);

const exportFile = async (relativePath, file) => {
  const contents = await file.read();
  console.log(`Generated ${relativePath}`);

  const compressed = await brotliCompress(contents);

  const directoryName = pathUtil.dirname(relativePath);
  await fsPromises.mkdir(pathUtil.join(tempDirectory, directoryName), {
    recursive: true
  });

  await fsPromises.writeFile(pathUtil.join(tempDirectory, `${relativePath}.br`), compressed)

  console.log(`Compressed ${relativePath}`);
};

const promises = Object.entries(build.files).map(([relativePath, file]) => exportFile(relativePath, file));
Promise.all(promises)
  .then(() => {
    fs.rmSync(outputDirectory, {
      recursive: true,
      force: true,
    });
    fs.renameSync(tempDirectory, outputDirectory);
    console.log(`Exported to ${outputDirectory}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
