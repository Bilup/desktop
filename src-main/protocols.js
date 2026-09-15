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
  'tw-privacy': {
    root: path.resolve(__dirname, '../src-renderer/privacy'),
    embeddable: true,
    csp: "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
  },
  'tw-about': {
    root: path.resolve(__dirname, '../src-renderer/about'),
    embeddable: true,
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
    bypassCSP: true,
    // V8 code cache：这是桌面端"冷启动比网页端慢"最直接的开关。
    //
    // 网页端的 JS 由 HTTP 提供，Chromium 会把 V8 编译结果落到磁盘
    // （generated code cache，键为 resource_url + origin_lock），下次启动直接
    // 反序列化，省掉解析+编译；官方数据是解析编译时间降 20%~40%。编辑器产物
    // 是几 MB 的 index.js，这一项就是几百毫秒级别。
    //
    // 自定义协议默认拿不到这一层，必须在这里显式打开。注意：
    //   - 官方文档明确"只有 standard 的 scheme 才生效"，所以非 standard 的
    //     扩展库协议上这个标志是空操作，统一打开只为将来少一处坑。
    //   - 这条路径**不经过 Chromium 的 HTTP 缓存**（generated code cache 与
    //     HttpCache 是两套东西），所以给响应加 cache-control / ETag / 304 在这
    //     里是死代码，别为此改协议实现。
    //   - 陈旧风险由 V8 自己兜：code cache 头部带 sourceHash，源码变了会被
    //     直接拒绝并重新编译，不需要按内容给文件改名。
    // https://www.electronjs.org/docs/latest/api/structures/custom-scheme
    codeCache: true
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
 *
 * 每个扩展库协议（tw/mw/ae/bl/sp）都必须有各自独立的运行时缓存目录，
 * 否则不同扩展库的同名扩展（相对路径相同）会互相覆盖/污染：例如先访问
 * TurboWarp 的 custom.js 会把内容写入共享目录，之后加载 MistWarp 的同名
 * custom.js 时会优先命中这份被污染的缓存，导致把 A 库的扩展加载成 B 库的。
 * @param {string} scheme 使用该缓存目录的协议 scheme 名（如 'tw-extensions'）
 */
const getRuntimeCacheRoot = (scheme) => path.join(app.getPath('userData'), scheme);

/**
 * 进程内缓存：key = `${scheme}:${relativePath}`，value = 文件内容 Buffer
 * （brotli 方案存已解压内容，普通方案存原始字节）。
 *
 * 为什么必须有这一层：一个 Scratch 项目里同一个素材（costume/sound 的
 * md5ext）会被多个角色、多次加载引用，扩展库的同一个 js/json 也会被反复
 * 拉取。改造前每一次请求都要走一遍 readFile（+ brotliDecompress），而且全部
 * 发生在 Electron 主进程上 —— 主进程被这些同步化的解压任务占住时，窗口
 * 消息、IPC、协议响应都会一起变慢，表现就是 "桌面端比网页端卡"。
 * 网页端有浏览器 HTTP 缓存兜住同一件事，桌面端必须自己兜。
 *
 * 编辑器本体的 tw-editor 协议同样走这里：index.js 是几 MB 的文件，每次开窗
 * （Ctrl+N）和刷新都会重新从 asar 读一遍，缓存后这些读取直接消失。
 *
 * 用 Map 的插入顺序实现 LRU：命中后删掉再 set 回去，最老的键在遍历时最先
 * 出现。总容量有上限，避免大项目把主进程内存吃满。
 */
const MEMORY_CACHE_MAX_BYTES = 128 * 1024 * 1024;
/**
 * 单个文件超过这个大小就不进内存缓存（避免一个超大素材把缓存挤空）。
 * 取 32MB 是为了确保生产构建的 index.js（含 scratch-vm/render/blocks 的
 * 编辑器整包）一定能被缓存住；正常产物在 10MB 上下。
 */
const MEMORY_CACHE_MAX_ENTRY_BYTES = 32 * 1024 * 1024;
/** @type {Map<string, Buffer>} */
const memoryCache = new Map();
let memoryCacheBytes = 0;

const memoryCacheKey = (scheme, relativePath) => `${scheme}:${relativePath}`;

/**
 * @param {string} key
 * @returns {Buffer|null}
 */
const memoryCacheGet = (key) => {
  const data = memoryCache.get(key);
  if (!data) {
    return null;
  }
  // 重新插入以刷新 LRU 顺序
  memoryCache.delete(key);
  memoryCache.set(key, data);
  return data;
};

/**
 * @param {string} key
 * @param {Buffer} data
 */
const memoryCacheSet = (key, data) => {
  if (!Buffer.isBuffer(data) || data.length > MEMORY_CACHE_MAX_ENTRY_BYTES) {
    return;
  }

  const existing = memoryCache.get(key);
  if (existing) {
    memoryCacheBytes -= existing.length;
    memoryCache.delete(key);
  }

  memoryCache.set(key, data);
  memoryCacheBytes += data.length;

  while (memoryCacheBytes > MEMORY_CACHE_MAX_BYTES && memoryCache.size > 1) {
    const oldestKey = memoryCache.keys().next().value;
    const oldest = memoryCache.get(oldestKey);
    memoryCache.delete(oldestKey);
    memoryCacheBytes -= oldest.length;
  }
};

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
 * 云端回退请求的超时时间（毫秒）。
 *
 * 这个值必须明显小于渲染进程侧各自的 fetch 超时（扩展画廊 fetchLibrary
 * 使用 10s AbortController）。否则云端挂起时（连接被黑洞、代理超时、DNS
 * 卡住等），协议层要等满 10s 才放弃云端并回退本地缓存，而渲染进程在
 * 10s 时已先一步 abort 请求——本地缓存响应到达时已被丢弃，表现为
 * "云端加载失败但本地缓存没有加载"。
 */
const REMOTE_FETCH_TIMEOUT_MS = 5000;

/**
 * Fetch a single file from the remote fallback with a timeout.
 *
 * This promise is guaranteed to settle (with Buffer or null) no matter what
 * happens: network error, non-200 status, timeout, or the server accepting
 * the connection but never finishing the response body. Without this, a
 * hanging remote (eg. SharkPools) would leave the protocol handler stuck
 * forever instead of falling back to the local cache.
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<Buffer|null>}
 */
const fetchRemoteWithTimeout = (url, timeoutMs = REMOTE_FETCH_TIMEOUT_MS) => new Promise((resolve) => {
  let parsedURL;
  try {
    parsedURL = new URL(url);
  } catch (e) {
    resolve(null);
    return;
  }

  let settled = false;
  let timer = null;
  const finish = (result) => {
    if (settled) {
      return;
    }
    settled = true;
    if (timer) {
      clearTimeout(timer);
    }
    resolve(result);
  };

  const mod = parsedURL.protocol === 'http:' ? require('http') : require('https');
  const request = mod.get(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; Bilup/1.0)',
      'accept-encoding': 'identity'
    }
  });
  timer = setTimeout(() => {
    // 超时：销毁连接并立即结束等待，由调用方回退到本地缓存
    request.destroy();
    finish(null);
  }, timeoutMs);
  request.on('response', (response) => {
    if (response.statusCode !== 200) {
      response.resume();
      finish(null);
      return;
    }
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => finish(Buffer.concat(chunks)));
    // 服务器在响应体传完之前断开连接：同样结束等待，回退本地缓存
    response.on('error', () => finish(null));
    response.on('aborted', () => finish(null));
    response.on('close', () => finish(null));
  });
  request.on('error', () => finish(null));
});

/**
 * Saves a remote fallback response into the writable runtime cache.
 * @param {string} scheme The scheme this file belongs to (for cache isolation).
 * @param {string} relativePath
 * @param {Buffer} data
 */
const writeRuntimeCache = async (scheme, relativePath, data) => {
  const runtimePath = path.join(getRuntimeCacheRoot(scheme), `${relativePath}.br`);
  const fsPromises = require('fs/promises');
  await fsPromises.mkdir(path.dirname(runtimePath), {recursive: true});
  const compressed = await brotliCompress(data);
  await fsPromises.writeFile(runtimePath, compressed);
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
    candidates.push(path.join(getRuntimeCacheRoot(metadata.scheme), `${relativePath}.br`));
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
 * Tries the remote fallback. On failure records a cooldown so subsequent
 * requests skip straight to the local cache.
 *
 * When the remote responds with content that differs from the local caches,
 * it is written into the writable runtime cache, effectively "overwriting"
 * the bundled cache with the latest remote version (the bundled cache ships
 * inside a read-only asar, so the runtime cache is the override layer that
 * tryReadLocal() checks first).
 * @param {Metadata} metadata
 * @param {string} relativePath
 * @param {Buffer|null} [localData] 已经读到的本地内容。传入后可以省掉一次
 *  readFile + brotliDecompress 的比对读（调用方通常刚拿过这份数据）。
 * @returns {Promise<Buffer|null>}
 */
const tryFetchRemote = async (metadata, relativePath, localData = null) => {
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
    console.warn(`[extensions] Failed to fetch ${url}, using local cache`);
    return null;
  }
  remoteFallbackCooldownUntil = 0;

  // 云端读取成功：若内容与本地缓存不一致，则用云端版本覆盖本地
  // （写入运行时缓存，读取时优先于打包缓存），保证离线时也是最新版本。
  // 内容一致时跳过写入，避免无谓的磁盘 IO。写入失败不阻断响应。
  try {
    const baseline = localData || await tryReadLocal(metadata, relativePath);
    if (!baseline || !baseline.equals(data)) {
      await writeRuntimeCache(metadata.scheme, relativePath, data);
      console.log(`[extensions] Updated local cache for ${relativePath}`);
    }
  } catch (error) {
    console.warn(`[extensions] Failed to update local cache for ${relativePath}:`, error.message);
  }
  return data;
};

/**
 * 正在进行中的后台云端刷新，按 `scheme:relativePath` 去重，避免同一个文件
 * 在一批并发请求里被重复拉取。
 * @type {Set<string>}
 */
const inflightRemoteRefreshes = new Set();

/**
 * Stale-while-revalidate：本地缓存已经命中时，立刻把内容交给渲染进程，同时
 * 在后台悄悄问一次云端有没有新版本。
 *
 * 这是桌面端相对网页端能做到 "更快" 的关键点：改造前是 "云端优先"，也就是
 * 每个扩展文件的响应都要先等一次网络往返；在 extensions.turbowarp.org /
 * mistium.com / vercel.app 被墙或缓慢的网络下，单次请求最长要挂 5 秒
 * （REMOTE_FETCH_TIMEOUT_MS）才回退本地，扩展加载、扩展画廊打开都会被拖死。
 * 改成后台刷新后，云端仍然会更新本地缓存（保留了原来的产品意图），但网络
 * 彻底离开关键路径。
 * @param {Metadata} metadata
 * @param {string} relativePath
 * @param {string} key 进程内缓存 key
 * @param {Buffer} localData 当前本地内容
 */
const refreshFromRemoteInBackground = (metadata, relativePath, key, localData) => {
  if (!shouldUseRemoteFallback(metadata) || inflightRemoteRefreshes.has(key)) {
    return;
  }

  inflightRemoteRefreshes.add(key);
  tryFetchRemote(metadata, relativePath, localData)
    .then((data) => {
      // 云端有更新：同步刷新进程内缓存，下一次请求立刻用上新版本。
      if (data) {
        memoryCacheSet(key, data);
      }
    })
    .catch((error) => {
      console.warn(`[extensions] Background refresh failed for ${relativePath}:`, error.message);
    })
    .finally(() => {
      inflightRemoteRefreshes.delete(key);
    });
};

/**
 * Resolves a file for a brotli-cached scheme.
 *
 * 读取顺序：进程内缓存 -> 本地缓存（运行时缓存优先，其次打包缓存）->
 * 只有本地完全没有时才同步等云端（例如云端新增、本地包里还没有的扩展文件）。
 * @param {Metadata} metadata
 * @param {string} relativePath
 * @returns {Promise<Buffer>}
 */
const resolveBrotliData = async (metadata, relativePath) => {
  const key = memoryCacheKey(metadata.scheme, relativePath);

  const cached = memoryCacheGet(key);
  if (cached) {
    return cached;
  }

  const localData = await tryReadLocal(metadata, relativePath);
  if (localData) {
    memoryCacheSet(key, localData);
    refreshFromRemoteInBackground(metadata, relativePath, key, localData);
    return localData;
  }

  // 本地缓存缺失，只能等云端（有 5s 超时兜底，不会永久挂住）。
  const remoteData = await tryFetchRemote(metadata, relativePath);
  if (remoteData) {
    memoryCacheSet(key, remoteData);
    return remoteData;
  }

  throw new Error(`Failed to read file: ${relativePath}`);
};

/**
 * 读取普通（非 brotli）方案的静态文件，走同一套进程内 LRU。
 *
 * 典型对象是 tw-editor 的编辑器产物：index.js 有几 MB，还有 blocks-media 的
 * 图标、字体等。这些文件之前每次请求都在主进程重新 readFile —— 从 asar 里
 * 读几 MB 要走一次解包，窗口刚开、正在解析 JS 的时候尤其明显。缓存之后只有
 * 首次读盘。
 * @param {Metadata} metadata
 * @param {string} relativePath 相对 metadata.root 的路径（缓存键的一部分）
 * @param {string} absolutePath 已经解析并做过越权校验的绝对路径
 * @returns {Promise<Buffer>}
 */
const resolvePlainFileData = async (metadata, relativePath, absolutePath) => {
  const key = memoryCacheKey(metadata.scheme, relativePath);

  const cached = memoryCacheGet(key);
  if (cached) {
    return cached;
  }

  const data = await require('fs/promises').readFile(absolutePath);
  memoryCacheSet(key, data);
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

      const relativePath = resolved.slice(root.length);

      if (metadata.brotli) {
        const data = await resolveBrotliData(metadata, relativePath);
        return new Response(data, {
          headers
        });
      }

      const fileData = await resolvePlainFileData(metadata, relativePath, resolved);
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
    // 记录 scheme，供运行时缓存目录按扩展库隔离（避免不同库同名扩展互相污染）
    metadata.scheme = scheme;
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
