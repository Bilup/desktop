import pathUtil from 'node:path';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import {promisify} from 'node:util';
import zlib from 'node:zlib';

const outputDirectory = pathUtil.join(import.meta.dirname, '../dist-sp-extensions/');
const spExtensionsBaseURL = (
  process.env.SP_EXTENSIONS_BASE_URL || 'https://sharkpools-extensions.vercel.app'
).replace(/\/+$/, '');

const brotliCompress = promisify(zlib.brotliCompress);

const normalizeRelativePath = (relativePath) => {
  const normalized = String(relativePath).replace(/^\/+/, '').replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some(i => i === '..')) {
    throw new Error(`Invalid relative path: ${relativePath}`);
  }
  return parts.join('/');
};

const toRemoteURL = (baseURL, relativePath) => {
  const normalized = normalizeRelativePath(relativePath);
  const encodedPath = normalized
    .split('/')
    .map(i => encodeURIComponent(i))
    .join('/');
  return `${baseURL}/${encodedPath}`;
};

const fetchRemoteFile = async (baseURL, relativePath, required = true) => {
  const url = toRemoteURL(baseURL, relativePath);
  const response = await fetch(url);
  if (!response.ok) {
    if (required) {
      throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
    }
    return null;
  }
  return Buffer.from(await response.arrayBuffer());
};

const fetchSPFile = async (relativePath, required = true) =>
  fetchRemoteFile(spExtensionsBaseURL, relativePath, required);

const createFetchLogPrefix = (libraryName, type, index = null, total = null) => {
  if (index === null) {
    return `[${libraryName} ${type}]`;
  }
  if (total === null) {
    return `[${libraryName} ${type} ${index}]`;
  }
  return `[${libraryName} ${type} ${index}/${total}]`;
};

const writeCompressed = async (root, relativePath, data) => {
  const normalizedRelativePath = normalizeRelativePath(relativePath);
  const outputPath = pathUtil.join(root, `${normalizedRelativePath}.br`);
  await fsPromises.mkdir(pathUtil.dirname(outputPath), {recursive: true});
  const compressed = await brotliCompress(data);
  await fsPromises.writeFile(outputPath, compressed);
};

const buildSPOfflineFiles = async () => {
  console.log(`[SharkPools] Preparing extension cache from ${spExtensionsBaseURL}`);

  const tempDirectory = pathUtil.join(import.meta.dirname, '../dist-sp-extensions-temp/');
  fs.rmSync(tempDirectory, {
    recursive: true,
    force: true
  });
  console.log('[SharkPools] Created temporary output directory');

  const metadataPath = 'Gallery Files/Extension-Keys.json';
  console.log(`${createFetchLogPrefix('SharkPools', 'required', 1, 1)} Fetching ${metadataPath}`);
  const metadataBuffer = await fetchSPFile(metadataPath, true);
  await writeCompressed(tempDirectory, metadataPath, metadataBuffer);
  console.log('[SharkPools] Saved original metadata');

  const rawMetadata = JSON.parse(metadataBuffer.toString('utf-8'));
  let extensions = [];

  if (Array.isArray(rawMetadata.extensions)) {
    extensions = rawMetadata.extensions;
  } else if (rawMetadata.extensions && typeof rawMetadata.extensions === 'object') {
    extensions = Object.values(rawMetadata.extensions);
  }

  const requiredFiles = new Set();
  const optionalFiles = new Set();

  for (const extension of extensions) {
    if (extension.url) {
      requiredFiles.add(`extension-code/${extension.url}`);
    }
    if (extension.banner) {
      optionalFiles.add(`extension-thumbs/${extension.banner}`);
    }
  }

  let requiredCount = 0;
  const requiredTotal = requiredFiles.size;
  let requiredIndex = 0;
  for (const file of requiredFiles) {
    requiredIndex++;
    console.log(
      `${createFetchLogPrefix('SharkPools', 'required', requiredIndex, requiredTotal)} Fetching ${file}`
    );
    try {
      const data = await fetchSPFile(file, true);
      await writeCompressed(tempDirectory, file, data);
      requiredCount++;
    } catch (error) {
      console.warn(`${createFetchLogPrefix('SharkPools', 'required', requiredIndex, requiredTotal)} Failed to fetch ${file}:`, error.message);
    }
  }

  let optionalCount = 0;
  let optionalIndex = 0;
  for (const file of optionalFiles) {
    optionalIndex++;
    console.log(`${createFetchLogPrefix('SharkPools', 'optional', optionalIndex)} Fetching ${file}`);
    const data = await fetchSPFile(file, false);
    if (!data) {
      console.log(`${createFetchLogPrefix('SharkPools', 'optional', optionalIndex)} Missing ${file}`);
      continue;
    }
    await writeCompressed(tempDirectory, file, data);
    optionalCount++;
  }

  fs.rmSync(outputDirectory, {
    recursive: true,
    force: true
  });
  fs.renameSync(tempDirectory, outputDirectory);

  console.log(
    `Fetched SharkPools extensions to ${outputDirectory} (required: ${requiredCount}, optional: ${optionalCount})`
  );
};

try {
  await buildSPOfflineFiles();
} catch (error) {
  console.error(error);
  process.exit(1);
}
