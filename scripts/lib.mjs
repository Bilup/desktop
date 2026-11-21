import * as nodeCrypto from 'node:crypto';
import * as nodeTls from 'node:tls';

// Node 默认只信任内置的 Mozilla CA。部分下载节点（例如 GitHub Releases）
// 的证书链需要系统证书库才能校验，否则会报 UNABLE_TO_VERIFY_LEAF_SIGNATURE。
// 这里等价于启动时加上 node --use-system-ca。
try {
  if (
    typeof nodeTls.getCACertificates === 'function' &&
    typeof nodeTls.setDefaultCACertificates === 'function'
  ) {
    nodeTls.setDefaultCACertificates([
      ...nodeTls.getCACertificates('default'),
      ...nodeTls.getCACertificates('system')
    ]);
  }
} catch (error) {
  console.warn(`[fetch] 无法合并系统 CA，继续使用内置证书：${error.message}`);
}

/**
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
export const computeMD5 = (buffer) => nodeCrypto
  .createHash('md5')
  .update(new Uint8Array(buffer))
  .digest('hex');

/**
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
export const computeSHA256 = (buffer) => nodeCrypto
  .createHash('sha256')
  .update(new Uint8Array(buffer))
  .digest('hex');

const defaultMaxAttempts = 4;

/**
 * @param {string} url
 * @param {RequestInit} [opts]
 * @returns {Promise<Response>}
 */
export const persistentFetch = async (url, opts = {}) => {
  const configuredAttempts = Number.parseInt(process.env.BILUP_FETCH_RETRIES || '', 10);
  const maxAttempts = Number.isFinite(configuredAttempts) && configuredAttempts > 0
    ? configuredAttempts
    : defaultMaxAttempts;

  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response = null;
    try {
      response = await fetch(url, {
        ...opts,
        headers: {
          // 部分 CDN 对缺少浏览器 UA 的请求返回 403/503。
          'User-Agent': 'Mozilla/5.0 (compatible; Bilup/1.0)',
          ...opts.headers
        }
      });
    } catch (error) {
      lastError = error;
    }

    if (response && response.ok) {
      return response;
    }

    if (response) {
      lastError = new Error(`persistentFetch: Unexpected status code: ${response.status} for ${url}`);
      // 4xx（如 404/403）重试也不会成功，直接失败，避免几十秒的空转。
      const isRetryable = response.status === 429 || response.status >= 500;
      // 释放未消费的响应体，避免连接占用。
      try {
        await response.arrayBuffer();
      } catch (error) {
        // ignore
      }
      if (!isRetryable) {
        throw lastError;
      }
    }

    if (attempt < maxAttempts) {
      const waitMs = 1000 * 2 ** (attempt - 1);
      console.warn(
        `Attempt ${attempt}/${maxAttempts} to fetch ${url} failed` +
        `${response ? ` (HTTP ${response.status})` : ''}, retrying in ${waitMs}ms...`
      );
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }

  throw lastError;
};
