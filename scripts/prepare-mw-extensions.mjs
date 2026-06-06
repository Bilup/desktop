import pathUtil from 'node:path';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import {promisify} from 'node:util';
import zlib from 'node:zlib';

const outputDirectory = pathUtil.join(import.meta.dirname, '../dist-mw-extensions/');
const mwExtensionsBaseURL = (
  process.env.MW_EXTENSIONS_BASE_URL || 'https://extensions.mistium.com'
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

const fetchMWFile = async (relativePath, required = true) =>
  fetchRemoteFile(mwExtensionsBaseURL, relativePath, required);

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

const writeRaw = async (root, relativePath, data) => {
  const normalized = normalizeRelativePath(relativePath);
  const outputPath = pathUtil.join(root, normalized);
  await fsPromises.mkdir(pathUtil.dirname(outputPath), {recursive: true});
  await fsPromises.writeFile(outputPath, data);
};

const extractLocalAssetPathsFromHTML = (html) => {
  const result = new Set();
  const matchAttribute = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = matchAttribute.exec(html)) !== null) {
    const value = match[1].trim();
    if (!value || value.startsWith('data:') || value.startsWith('#') || value.startsWith('mailto:')) {
      continue;
    }

    let relativePath = null;
    if (value.startsWith('/')) {
      relativePath = value.slice(1);
    } else if (value.startsWith(`${mwExtensionsBaseURL}/`)) {
      relativePath = value.slice(mwExtensionsBaseURL.length + 1);
    } else {
      continue;
    }

    relativePath = relativePath.split('#')[0].split('?')[0];
    if (!relativePath || relativePath.endsWith('/')) {
      continue;
    }
    result.add(normalizeRelativePath(relativePath));
  }
  return result;
};

const buildMWOfflineFiles = async () => {
  console.log(`[Mistium] Preparing extension cache from ${mwExtensionsBaseURL}`);

  fs.rmSync(outputDirectory, {
    recursive: true,
    force: true
  });
  console.log('[Mistium] Cleared output directory');

  const metadataPath = 'generated-metadata/extensions-v0.json';
  console.log(`${createFetchLogPrefix('Mistium', 'required', 1, 1)} Fetching ${metadataPath}`);
  const metadataBuffer = await fetchMWFile(metadataPath, true);
  const metadata = JSON.parse(metadataBuffer.toString('utf-8'));
  console.log('[Mistium] Parsed metadata');

  const requiredFiles = new Set([metadataPath]);
  const optionalFiles = new Set([
    'index.html',
    'sitemap.xml',
    'docs-internal/scratchblocks.js'
  ]);

  for (const extension of metadata.extensions || []) {
    if (!extension || typeof extension !== 'object') {
      continue;
    }
    if (typeof extension.slug === 'string' && extension.slug) {
      requiredFiles.add(`${extension.slug}.js`);
      if (extension.docs) {
        optionalFiles.add(`${extension.slug}.html`);
      }
    }
    if (typeof extension.image === 'string' && extension.image) {
      requiredFiles.add(extension.image);
    }
    if (Array.isArray(extension.samples)) {
      for (const sample of extension.samples) {
        if (typeof sample === 'string' && sample) {
          optionalFiles.add(`samples/${sample}.sb3`);
        }
      }
    }
  }

  await writeRaw(outputDirectory, metadataPath, metadataBuffer);

  let requiredCount = 1;
  let optionalCount = 0;
  const requiredTotal = requiredFiles.size;
  let requiredIndex = 1;
  for (const file of requiredFiles) {
    if (file === metadataPath) {
      continue;
    }
    requiredIndex++;
    console.log(
      `${createFetchLogPrefix('Mistium', 'required', requiredIndex, requiredTotal)} Fetching ${file}`
    );
    const data = await fetchMWFile(file, true);
    await writeRaw(outputDirectory, file, data);
    requiredCount++;
  }

  let optionalIndex = 0;
  for (const file of optionalFiles) {
    optionalIndex++;
    console.log(`${createFetchLogPrefix('Mistium', 'optional', optionalIndex)} Fetching ${file}`);
    const data = await fetchMWFile(file, false);
    if (!data) {
      console.log(`${createFetchLogPrefix('Mistium', 'optional', optionalIndex)} Missing ${file}`);
      continue;
    }
    await writeRaw(outputDirectory, file, data);
    optionalCount++;
  }

  console.log(
    `Fetched Mistium extensions to ${outputDirectory} (required: ${requiredCount}, optional: ${optionalCount})`
  );
};

try {
  await buildMWOfflineFiles();
} catch (error) {
  console.error(error);
  process.exit(1);
}
