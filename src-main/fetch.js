// Can't use fetch() because we still need to support Electron 22

const {name, version} = require('../package.json');

/**
 * 空闲超时：超过这么久没有任何数据进展就放弃。
 *
 * 用"空闲"而不是"总时长"，是为了不误伤慢速但仍在传数据的合法大项目；
 * 服务器接受连接后永不响应、或响应体中途停住这两种真正的挂起都能被抓住。
 */
const FETCH_IDLE_TIMEOUT_MS = 60 * 1000;

/**
 * 响应体上限。
 *
 * 打开 URL 项目时请求地址来自命令行/文件关联/拖入链接，服务器不可信：它可以无限
 * 流式返回，主进程会把收到的内容全部堆在内存里。这个上限给这类请求一个硬边界。
 * 正常 sb3 项目远小于此；如确有更大的合法项目，调大这个常量即可。
 */
const FETCH_MAX_BYTES = 512 * 1024 * 1024;

/**
 * @param {string} url
 * @returns {Promise<Buffer>}
 */
const privilegedFetch = (url) => new Promise((resolve, reject) => {
  const parsedURL = new URL(url);
  // Import http and https lazily as they take about 17ms to import the first time
  const mod = parsedURL.protocol === 'http:' ? require('http') : require('https');

  let settled = false;
  let timer = null;
  const finish = (error, buffer) => {
    if (settled) {
      return;
    }
    settled = true;
    if (timer) {
      clearTimeout(timer);
    }
    if (error) {
      reject(error);
    } else {
      resolve(buffer);
    }
  };

  const request = mod.get(url, {
    headers: {
      'user-agent': `${name}/${version}`
    }
  });

  const resetTimer = () => {
    if (settled) {
      return;
    }
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      request.destroy();
      finish(new Error(
        `Timed out after ${FETCH_IDLE_TIMEOUT_MS}ms without data while fetching ${url}`
      ));
    }, FETCH_IDLE_TIMEOUT_MS);
  };

  resetTimer();

  request.on('response', (response) => {
    resetTimer();
    const statusCode = response.statusCode;
    if (statusCode !== 200) {
      // 必须排空响应体，否则连接不会被释放。
      response.resume();
      request.destroy();
      finish(new Error(`HTTP error ${statusCode} while fetching ${url}`));
      return;
    }

    const chunks = [];
    let receivedBytes = 0;
    response.on('data', (chunk) => {
      if (settled) {
        return;
      }
      resetTimer();
      receivedBytes += chunk.length;
      if (receivedBytes > FETCH_MAX_BYTES) {
        // 丢掉已收到的内容并终止连接，避免把主进程内存交给不可信的服务器支配。
        chunks.length = 0;
        request.destroy();
        finish(new Error(
          `Response too large (> ${FETCH_MAX_BYTES} bytes) while fetching ${url}`
        ));
        return;
      }
      chunks.push(chunk);
    });

    response.on('end', () => {
      finish(null, Buffer.concat(chunks));
    });
    response.on('error', (error) => {
      finish(error);
    });
    response.on('aborted', () => {
      finish(new Error(`Response aborted while fetching ${url}`));
    });
  });

  request.on('error', (error) => {
    finish(error);
  });
});

/**
 * @param {string} url
 * @returns {unknown} parsed JSON object
 */
privilegedFetch.json = async (url) => {
  const buffer = await privilegedFetch(url);
  return JSON.parse(buffer.toString('utf-8'));
};

module.exports = privilegedFetch;
