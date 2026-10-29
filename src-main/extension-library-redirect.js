/**
 * 扩展库的 https 地址 → 应用内置自定义协议的映射。
 *
 * 背景：扩展库的元数据、扩展脚本、图标、示例项目在应用里都有一份打包好的离线副本
 * （`dist-extensions` / `dist-bilup-extensions` / ...）。渲染进程和扩展沙盒始终按
 * 原始 https 地址发请求，主进程在 `session.webRequest.onBeforeRequest` 里把命中这些
 * 来源的请求改写成对应协议（`tw-extensions://` 等），再由协议层决定"读本地缓存还
 * 是回源"（见 protocols.js 的 remoteFallback / stale-while-revalidate）。
 *
 * 之所以集中在这一个文件里：改写目标分散在三个窗口（编辑器、运行/预览窗口、打包器）
 * 时，只要有一个窗口漏掉某个来源，那个窗口里就会静默回落到真实网络 —— 离线时表现为
 * "同一个扩展在编辑器里能用、打包时却报 fetch 失败"。桌面端所有需要这份映射的窗口
 * 都必须调用 getExtensionLibraryRedirect()，不要在窗口里另写 `parsed.origin === ...`。
 *
 * ⚠️ 新增扩展库时必须同时改三处，否则会静默失效：
 *   1. 这里（窗口级改写）
 *   2. src-main/index.js 的 INTERCEPTED_URL_PATTERNS（webRequest 过滤，不匹配就收不到事件）
 *   3. src-main/protocols.js 的 FILE_SCHEMES（协议注册与本地根目录 / remoteFallback）
 */

/**
 * @typedef ExtensionLibraryRule
 * @property {string} scheme 对应的自定义协议
 * @property {string} [stripPrefix] 云端路径里需要去掉的前缀（本地缓存路径不含它）
 */

/**
 * key 是 URL 的 origin（不带结尾斜杠）。
 * @type {Record<string, ExtensionLibraryRule>}
 */
const EXTENSION_LIBRARY_ORIGINS = {
  'https://extensions.turbowarp.org': {scheme: 'tw-extensions'},
  'https://extensions.bilup.org': {scheme: 'bl-extensions'},
  // Astra 的云端地址带 /extensions 前缀，打包目录里没有这一层
  'https://editors.astras.top': {scheme: 'ae-extensions', stripPrefix: '/extensions'},
  'https://extensions.mistium.com': {scheme: 'mw-extensions'},
  'https://sharkpools-extensions.vercel.app': {scheme: 'sp-extensions'}
};

/**
 * 把一个扩展库的 https URL 改写成内置协议 URL。
 * @param {string} url 请求的原始 URL
 * @returns {string|null} 改写后的 URL；不属于任何扩展库来源时返回 null
 */
const getExtensionLibraryRedirect = (url) => {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    // 不是合法 URL（自定义协议、about:blank 等）→ 不处理
    return null;
  }

  const rule = EXTENSION_LIBRARY_ORIGINS[parsed.origin];
  if (!rule) {
    return null;
  }

  let pathname = parsed.pathname;
  if (rule.stripPrefix && pathname.startsWith(rule.stripPrefix)) {
    pathname = pathname.slice(rule.stripPrefix.length);
  }
  if (!pathname.startsWith('/')) {
    pathname = `/${pathname}`;
  }

  // host 固定写成 "."，与 GUI 里 localURL 的形态保持一致；协议层只看 pathname
  return `${rule.scheme}://.${pathname}`;
};

module.exports = {
  EXTENSION_LIBRARY_ORIGINS,
  getExtensionLibraryRedirect
};
