// 全仓库唯一的 Brotli 编解码入口。
//
// 背景：Brotli 解码器在 1.0.3 ~ 1.2.0 存在越界写（CVE-2026-111497，可导致
// 代码执行）。解码器本身在 Electron 内置运行时里，只能随 Electron 升级替换；
// 在源码这一层能做两件事：
//   1. 把解码口收敛到一处，将来要换实现或打补丁只改这个文件；
//   2. 给输入/输出加硬上限，避免「压缩炸弹」把主进程内存吃光。
//
// 主进程是权限最高的地方，所有来自磁盘/网络的 .br 文件都必须经过这里。

const zlib = require('zlib');

/** 压缩包本身的大小上限。正常的扩展/库文件远小于此，超过即视为文件损坏或被替换。 */
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
/** 解压后的大小上限。防止一个几百 KB 的压缩包解出几 GB 内容。 */
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

const toMB = (bytes) => `${Math.round(bytes / (1024 * 1024))}MB`;

/**
 * @param {unknown} input
 * @param {number} limit
 * @param {string} label
 */
const assertBufferSize = (input, limit, label) => {
  if (!Buffer.isBuffer(input)) {
    throw new TypeError(`${label}必须是 Buffer`);
  }
  if (input.length > limit) {
    throw new Error(`${label}体积 ${toMB(input.length)} 超过上限 ${toMB(limit)}，已拒绝处理`);
  }
};

/**
 * @param {Buffer} input
 * @returns {Promise<Buffer>}
 */
const decompress = (input) => new Promise((resolve, reject) => {
  try {
    assertBufferSize(input, MAX_INPUT_BYTES, 'Brotli 输入');
  } catch (error) {
    reject(error);
    return;
  }
  // maxOutputLength 让 zlib 在解压过程中就拒绝超额输出；下面的二次检查是兜底，
  // 以防某些运行时版本忽略该选项。
  zlib.brotliDecompress(input, {maxOutputLength: MAX_OUTPUT_BYTES}, (error, result) => {
    if (error) {
      reject(error);
      return;
    }
    if (result.length > MAX_OUTPUT_BYTES) {
      reject(new Error(`Brotli 解压结果 ${toMB(result.length)} 超过上限 ${toMB(MAX_OUTPUT_BYTES)}，已丢弃`));
      return;
    }
    resolve(result);
  });
});

/**
 * @param {Buffer} input
 * @returns {Promise<Buffer>}
 */
const compress = (input) => new Promise((resolve, reject) => {
  try {
    assertBufferSize(input, MAX_OUTPUT_BYTES, '待压缩数据');
  } catch (error) {
    reject(error);
    return;
  }
  zlib.brotliCompress(input, (error, result) => {
    if (error) {
      reject(error);
    } else {
      resolve(result);
    }
  });
});

module.exports = {
  decompress,
  compress,
  MAX_INPUT_BYTES,
  MAX_OUTPUT_BYTES
};
