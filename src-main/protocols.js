const path = require('path');
const zlib = require('zlib');
const nodeURL = require('url');
const {app, protocol, net} = require('electron');
const {getDist, getPlatform} = require('./platform');
const settings = require('./settings');
const packageJSON = require('../package.json');

/**
 * @typedef Metadata
 * @property {string} root
 * @property {boolean} [standard] Defaults to false
 * @property {boolean} [supportFetch] Defaults to false
 * @property {boolean} [secure] Defaults to false
 * @property {boolean} [brotli] Defaults to false
 * @property {boolean} [embeddable] Defaults to false
 * @property {boolean} [stream] Defaults to false
 * @property {string} [directoryIndex] Defaults to none
 * @property {string} [defaultExtension] Defaults to n one
 * @property {string} [csp] Defaults to none
 */

/** @type {Record<string, Metadata>} */
const FILE_SCHEMES = {
  'tw-editor': {
    root: path.resolve(__dirname, '../dist-renderer-webpack/editor'),
    standard: true,
    supportFetch: true,
    secure: true,
    embeddable: true, // migration helper
  },
  'tw-desktop-settings': {
    root: path.resolve(__dirname, '../src-renderer/desktop-settings'),
    csp: "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
  },
  'tw-privacy': {
    root: path.resolve(__dirname, '../src-renderer/privacy'),
    csp: "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
  },
  'tw-about': {
    root: path.resolve(__dirname, '../src-renderer/about'),
    csp: "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
  },
  'tw-packager': {
    root: path.resolve(__dirname, '../src-renderer/packager'),
    standard: true,
    secure: true,
    embeddable: true, // migration helper
  },
  'tw-library': {
    root: path.resolve(__dirname, '../dist-library-files'),
    supportFetch: true,
    brotli: true,
    csp: "default-src 'none';"
  },
  'tw-extensions': {
    root: path.resolve(__dirname, '../dist-extensions'),
    supportFetch: true,
    brotli: true,
    embeddable: true,
    stream: true,
    directoryIndex: 'index.html',
    defaultExtension: '.html',
    csp: "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
    // 云端优先、失败回退本地的逻辑（remoteFallback）
    remoteFallback: 'https://extensions.turbowarp.org'
  },
  'bl-extensions': {
    root: path.resolve(__dirname, '../dist-bilup-extensions'),
    supportFetch: true,
    brotli: true,
    embeddable: true,
    stream: true,
    directoryIndex: 'index.html',
    defaultExtension: '.html',
    csp: "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
    remoteFallback: 'https://extensions.bilup.org'
  },
  'ae-extensions': {
    root: path.resolve(__dirname, '../dist-astra-extensions'),
    supportFetch: true,
    brotli: true,
    embeddable: true,
    stream: true,
    directoryIndex: 'index.html',
    defaultExtension: '.html',
    csp: "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
    // 注意：Astra 云端 URL 带 /extensions 前缀，本地缓存路径不含此前缀
    remoteFallback: 'https://editors.astras.top/extensions'
  },
  'mw-extensions': {
    root: path.resolve(__dirname, '../dist-mw-extensions'),
    supportFetch: true,
    brotli: true,
    embeddable: true,
    stream: true,
    directoryIndex: 'index.html',
    defaultExtension: '.html',
    csp: "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
    remoteFallback: 'https://extensions.mistium.com'
  },
  'sp-extensions': {
    root: path.resolve(__dirname, '../dist-sp-extensions'),
    supportFetch: true,
    brotli: true,
    embeddable: true,
    stream: true,
    directoryIndex: 'index.html',
    defaultExtension: '.html',
    csp: "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
    // When the file isn't available in the local cache, fall back to the
    // original remote source. If the remote source also fails, the bundled
    // cache (and any previously downloaded files) is used instead.
    remoteFallback: 'https://sharkpools-extensions.vercel.app'
  },
  'tw-update': {
    root: path.resolve(__dirname, '../src-renderer/update'),
    csp: "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src https://desktop.bilup.org"
  },
  'tw-security-prompt': {
    root: path.resolve(__dirname, '../src-renderer/security-prompt'),
    csp: "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';"
  },
  'tw-file-access': {
    root: path.resolve(__dirname, '../src-renderer/file-access'),
    csp: "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
  }
};

const MIME_TYPES = new Map();
MIME_TYPES.set('.html', 'text/html');
MIME_TYPES.set('.js', 'text/javascript');
MIME_TYPES.set('.map', 'application/json');
MIME_TYPES.set('.txt', 'text/plain');
MIME_TYPES.set('.json', 'application/json');
MIME_TYPES.set('.wav', 'audio/wav');
MIME_TYPES.set('.svg', 'image/svg+xml');
MIME_TYPES.set('.png', 'image/png');
MIME_TYPES.set('.jpg', 'image/jpeg');
MIME_TYPES.set('.gif', 'image/gif');
MIME_TYPES.set('.cur', 'image/x-icon');
MIME_TYPES.set('.ico', 'image/x-icon');
MIME_TYPES.set('.mp3', 'audio/mpeg');
MIME_TYPES.set('.mp4', 'video/mp4');
MIME_TYPES.set('.wav', 'audio/wav');
MIME_TYPES.set('.ogg', 'audio/ogg');
MIME_TYPES.set('.ttf', 'font/ttf');
MIME_TYPES.set('.otf', 'font/otf');
MIME_TYPES.set('.woff', 'font/woff');
MIME_TYPES.set('.woff2', 'font/woff2');
MIME_TYPES.set('.hex', 'application/octet-stream');
MIME_TYPES.set('.zip', 'application/zip');
MIME_TYPES.set('.xml', 'text/xml');
MIME_TYPES.set('.md', 'text/markdown');

protocol.registerSchemesAsPrivileged(Object.entries(FILE_SCHEMES).map(([scheme, metadata]) => ({
  scheme,
  privileges: {
    standard: !!metadata.standard,
    supportFetchAPI: true,
    secure: !!metadata.secure,
    stream: !!metadata.stream,
    corsEnabled: true,
    bypassCSP: true
  }
})));

/**
 * Promisified zlib.brotliDecompress
 */
const brotliDecompress = (input) => new Promise((resolve, reject) => {
  zlib.brotliDecompress(input, (error, result) => {
    if (error) {
      reject(error);
    } else {
      resolve(result);
    }
  });
});

/**
 * Promisified zlib.brotliCompress
 */
const brotliCompress = (input) => new Promise((resolve, reject) => {
  zlib.brotliCompress(input, (error, result) => {
    if (error) {
      reject(error);
    } else {
      resolve(result);
    }
  });
});

/**
 * Directory where files downloaded from the remote fallback are cached so
 * they keep working when the app is offline or the remote is unreachable.
 */
const getRuntimeCacheRoot = () => path.join(app.getPath('userData'), 'sp-extensions');

/**
 * Whether the remote fallback should be attempted right now. After a failed
 * attempt we enter a short cooldown so we don't hammer an unreachable server
 * (and force users to wait for timeouts) on every single request.
 */
let remoteFallbackCooldownUntil = 0;
const shouldUseRemoteFallback = (metadata) => (
  metadata.remoteFallback &&
  settings.cloudExtensions &&
  net.isOnline() &&
  Date.now() >= remoteFallbackCooldownUntil
);

/**
 * Builds the remote URL that matches how prepare-sp-extensions.mjs stores files:
 * every path segment is URL-encoded and joined with "/".
 * @param {string} baseURL
 * @param {string} relativePath
 * @returns {string|null}
 */
const toRemoteFallbackURL = (baseURL, relativePath) => {
  const normalized = String(relativePath).replace(/^\/+/, '').replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some(i => i === '..')) {
    return null;
  }
  const encodedPath = parts.map(i => encodeURIComponent(i)).join('/');
  return `${baseURL}/${encodedPath}`;
};

/**
 * Fetch a single file from the remote fallback with a timeout.
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<Buffer|null>}
 */
const fetchRemoteWithTimeout = (url, timeoutMs = 5000) => new Promise((resolve) => {
  let parsedURL;
  try {
    parsedURL = new URL(url);
  } catch (e) {
    resolve(null);
    return;
  }
  const mod = parsedURL.protocol === 'http:' ? require('http') : require('https');
  const request = mod.get(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; Bilup/1.0)',
      'accept-encoding': 'identity'
    }
  });
  const timer = setTimeout(() => {
    request.destroy(new Error('timeout'));
  }, timeoutMs);
  request.on('response', (response) => {
    if (response.statusCode !== 200) {
      response.resume();
      clearTimeout(timer);
      resolve(null);
      return;
    }
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
  });
  request.on('error', () => {
    clearTimeout(timer);
    resolve(null);
  });
});

/**
 * Saves a remote fallback response into the writable runtime cache.
 * @param {string} relativePath
 * @param {Buffer} data
 */
const writeRuntimeCache = async (relativePath, data) => {
  const runtimePath = path.join(getRuntimeCacheRoot(), `${relativePath}.br`);
  const fsPromises = require('fs/promises');
  await fsPromises.mkdir(path.dirname(runtimePath), {recursive: true});
  const compressed = await brotliCompress(data);
  await fsPromises.writeFile(runtimePath, compressed);
};

/**
 * Tries the remote fallback first (when enabled); on failure records a
 * cooldown so subsequent requests skip straight to the local cache.
 * @param {Metadata} metadata
 * @param {string} relativePath
 * @returns {Promise<Buffer|null>}
 */
const tryFetchRemote = async (metadata, relativePath) => {
  if (!shouldUseRemoteFallback(metadata)) {
    return null;
  }
  const url = toRemoteFallbackURL(metadata.remoteFallback, relativePath);
  if (!url) {
    return null;
  }
  const data = await fetchRemoteWithTimeout(url);
  if (!data) {
    // Remote unreachable: fall back to the local cache for a while.
    remoteFallbackCooldownUntil = Date.now() + 60 * 1000;
    console.warn(`[sp-extensions] Failed to fetch ${url}, using local cache`);
    return null;
  }
  remoteFallbackCooldownUntil = 0;
  writeRuntimeCache(relativePath, data).catch(error => {
    console.warn(`[sp-extensions] Failed to cache ${relativePath}:`, error.message);
  });
  return data;
};

/**
 * Reads a file from the local caches: the writable runtime cache first, then
 * the bundled (read-only) cache.
 * @param {Metadata} metadata
 * @param {string} relativePath
 * @returns {Promise<Buffer|null>}
 */
const tryReadLocal = async (metadata, relativePath) => {
  const fsPromises = require('fs/promises');

  const candidates = [];
  // The writable runtime cache only exists for schemes that use a remote fallback.
  if (metadata.remoteFallback) {
    candidates.push(path.join(getRuntimeCacheRoot(), `${relativePath}.br`));
  }
  candidates.push(path.join(metadata.root, `${relativePath}.br`));

  for (const candidate of candidates) {
    try {
      const brotliData = await fsPromises.readFile(candidate);
      return await brotliDecompress(brotliData);
    } catch (e) {
      // Try the next cache location.
    }
  }

  return null;
};

/**
 * Resolves a file for a brotli-cached scheme, trying the remote fallback first
 * (when configured and enabled) and the local caches afterwards.
 * @param {Metadata} metadata
 * @param {string} relativePath
 * @returns {Promise<Buffer>}
 */
const resolveBrotliData = async (metadata, relativePath) => {
  let data = null;

  if (shouldUseRemoteFallback(metadata)) {
    data = await tryFetchRemote(metadata, relativePath);
  }

  if (!data) {
    data = await tryReadLocal(metadata, relativePath);
  }

  if (!data) {
    throw new Error(`Failed to read file: ${relativePath}`);
  }

  return data;
};

/**
 * @param {unknown} xml
 * @returns {string}
 */
const escapeXML = (xml) => String(xml).replace(/[<>&'"]/g, c => {
  switch (c) {
    case '<': return '&lt;';
    case '>': return '&gt;';
    case '&': return '&amp;';
    case '\'': return '&apos;';
    case '"': return '&quot;';
  }
});

/**
 * Note that custom extensions will be able to access this page and all of the information in it.
 * @param {Request | Electron.ProtocolRequest} request
 * @param {unknown} errorMessage
 * @returns {string}
 */
const createErrorPageHTML = (request, errorMessage) => `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Protocol handler error</title>
  </head>
  <body bgcolor="white" text="black">
    <h1>Protocol handler error</h1>
    <p>If you can see this page, <a href="https://github.com/Bilup/desktop/issues" target="_blank" rel="noreferrer">please open a GitHub issue</a> or <a href="mailto:contact@bilup.org" target="_blank" rel="noreferrer">email us</a> with all the information below.</p>
    <pre>${escapeXML(errorMessage)}</pre>
    <pre>URL: ${escapeXML(request.url)}</pre>
    <pre>Version ${escapeXML(packageJSON.version)}, Electron ${escapeXML(process.versions.electron)}, Platform ${escapeXML(getPlatform())} ${escapeXML(process.arch)}, Distribution ${escapeXML(getDist())}</pre>
  </body>
</html>`;

const errorPageHeaders = {
  'content-type': 'text/html',
  'content-security-policy': 'default-src \'none\''
};

/**
 * @param {Metadata} metadata
 * @returns {Record<string, string>}
 */
const getBaseProtocolHeaders = metadata => {
  const result = {
    // Make sure Chromium always trusts our content-type and doesn't try anything clever
    'x-content-type-options': 'nosniff',
    // CORS support
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Authorization, X-Requested-With',
    'access-control-max-age': '86400'
  };

  // Optional Content-Security-Policy
  if (metadata.csp) {
    result['content-security-policy'] = metadata.csp;
  }

  // Don't allow things like extensiosn to embed custom protocols
  if (!metadata.embeddable) {
    result['x-frame-options'] = 'DENY';
  }

  return result;
};

/** @param {Metadata} metadata */
const createModernProtocolHandler = (metadata) => {
  const root = path.join(metadata.root, '/');
  const baseHeaders = getBaseProtocolHeaders(metadata);
  const fsPromises = require('fs/promises');

  /**
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  return async (request) => {
    const createErrorResponse = (error) => {
      console.error(error);
      return new Response(createErrorPageHTML(request, error), {
        status: 400,
        headers: {
          ...baseHeaders,
          ...errorPageHeaders
        }
      });
    };

    try {
      let parsedURL = new URL(request.url);
      if (parsedURL.pathname.endsWith('/') && metadata.directoryIndex) {
        parsedURL = new URL(metadata.directoryIndex, parsedURL);
      }

      // 解码 URL 编码的路径（如空格 %20）
      const decodedPathname = decodeURIComponent(parsedURL.pathname);
      let resolved = path.join(root, decodedPathname);
      if (!resolved.startsWith(root)) {
        return createErrorResponse(new Error('Path traversal blocked'));
      }

      let fileExtension = path.extname(resolved);
      if (!fileExtension && metadata.defaultExtension) {
        fileExtension = metadata.defaultExtension;
        resolved = `${resolved}${fileExtension}`;
      }

      const mimeType = MIME_TYPES.get(fileExtension);
      if (!mimeType) {
        return createErrorResponse(new Error(`Invalid file extension: ${fileExtension}`));
      }

      const headers = {
        ...baseHeaders,
        'content-type': mimeType
      };

      if (metadata.brotli) {
        const relativePath = resolved.slice(root.length);
        const data = await resolveBrotliData(metadata, relativePath);
        return new Response(data, {
          headers
        });
      }

      const fileData = await fsPromises.readFile(resolved);
      return new Response(fileData, {
        headers
      });
    } catch (error) {
      return createErrorResponse(error);
    }
  };
};

/** @param {Metadata} metadata */
const createLegacyBrotliProtocolHandler = (metadata) => {
  const root = path.join(metadata.root, '/');
  const baseHeaders = getBaseProtocolHeaders(metadata);

  /**
   * @param {Electron.ProtocolRequest} request
   * @param {(result: {data: Buffer; statusCode?: number; headers?: Record<string, string>;}) => void} callback
   */
  return async (request, callback) => {
    const fsPromises = require('fs/promises');

    const returnErrorPage = (error) => {
      console.error(error);
      callback({
        data: Buffer.from(createErrorPageHTML(request, error)),
        statusCode: 400,
        headers: {
          ...baseHeaders,
          ...errorPageHeaders
        }
      });
    };

    try {
      let parsedURL = new URL(request.url);
      if (parsedURL.pathname.endsWith('/') && metadata.directoryIndex) {
        parsedURL = new URL(metadata.directoryIndex, parsedURL);
      }

      // 解码 URL 编码的路径（如空格 %20）
      const decodedPathname = decodeURIComponent(parsedURL.pathname);
      let resolved = path.join(root, decodedPathname);
      if (!resolved.startsWith(root)) {
        returnErrorPage(new Error('Path traversal blocked'));
        return;
      }

      let fileExtension = path.extname(resolved);
      if (!fileExtension && metadata.defaultExtension) {
        fileExtension = metadata.defaultExtension;
        resolved = `${resolved}${fileExtension}`;
      }

      const mimeType = MIME_TYPES.get(fileExtension);
      if (!mimeType) {
        returnErrorPage(new Error(`Invalid file extension: ${fileExtension}`));
        return;
      }

      // Reading it all into memory is not ideal, but we've had so many problems with streaming
      // files from the asar that I can settle with this.
      const relativePath = resolved.slice(root.length);
      const data = await resolveBrotliData(metadata, relativePath);

      callback({
        data,
        headers: {
          ...baseHeaders,
          'content-type': mimeType
        }
      });
    } catch (error) {
      returnErrorPage(error);
    }
  };
};

/** @param {Metadata} metadata */
const createLegacyFileProtocolHandler = (metadata) => {
  const root = path.join(metadata.root, '/');
  const baseHeaders = getBaseProtocolHeaders(metadata);

  /**
   * @param {Electron.ProtocolRequest} request
   * @param {(result: {path: string; statusCode?: number; headers?: Record<string, string>;}) => void} callback
   */
  return (request, callback) => {
    const returnErrorResponse = (error, errorPage) => {
      console.error(error);
      callback({
        status: 400,
        // All we can return is a file path, so we just have a few different ones baked in
        // for each error that we expect.
        path: path.join(__dirname, `../src-protocol-error/legacy-file/${errorPage}.html`),
        headers: {
          ...baseHeaders,
          ...errorPageHeaders
        }
      });
    };

    try {
      let parsedURL = new URL(request.url);
      if (parsedURL.pathname.endsWith('/') && metadata.directoryIndex) {
        parsedURL = new URL(metadata.directoryIndex, parsedURL);
      }

      // 解码 URL 编码的路径（如空格 %20）
      const decodedPathname = decodeURIComponent(parsedURL.pathname);
      let resolved = path.join(root, decodedPathname);
      if (!resolved.startsWith(root)) {
        returnErrorResponse(new Error('Path traversal blocked'), 'path-traversal');
        return;
      }

      let fileExtension = path.extname(resolved);
      if (!fileExtension && metadata.defaultExtension) {
        fileExtension = metadata.defaultExtension;
        resolved = `${resolved}${fileExtension}`;
      }

      const mimeType = MIME_TYPES.get(fileExtension);
      if (!mimeType) {
        returnErrorResponse(new Error(`Invalid file extension: ${fileExtension}`), 'invalid-extension');
        return;
      }

      callback({
        path: resolved,
        headers: {
          ...baseHeaders,
          'content-type': mimeType
        }
      });
    } catch (error) {
      returnErrorResponse(error, 'unknown');
    }
  };
};

app.whenReady().then(() => {
  for (const [scheme, metadata] of Object.entries(FILE_SCHEMES)) {
    // Electron 22 (used by Windows 7/8/8.1 build) does not support protocol.handle() or new Response()
    if (protocol.handle) {
      protocol.handle(scheme, createModernProtocolHandler(metadata));
    } else {
      if (metadata.brotli) {
        protocol.registerBufferProtocol(scheme, createLegacyBrotliProtocolHandler(metadata));
      } else {
        protocol.registerFileProtocol(scheme, createLegacyFileProtocolHandler(metadata));
      }
    }
  }
});
