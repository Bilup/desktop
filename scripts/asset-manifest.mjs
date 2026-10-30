// 下载产物的「防伪清单」公共逻辑。
//
// 背景：npm run fetch 会从四个外部站点下载扩展、库文件并压缩缓存进安装包。
// 这些内容随后会由主进程解码（brotli，见 src-main/brotli.js），属于供应链入口。
// 光升级 Electron 只能修「解码器有漏洞」，修不了「下回来的东西被换掉」。
//
// 做法：把每个文件的 sha256 记进仓库里的 assets-manifest.json（像 lockfile 一样
// 提交并在 code review 里看 diff）。之后每次 fetch 都对照校验：
//   - 内容被替换 / 文件被增删 -> 构建期直接报错，而不是等运行时解码；
//   - 上游正常更新 -> 跑 scripts/generate-asset-manifest.mjs 重新锁定并提交。

import fs from 'node:fs';
import pathUtil from 'node:path';
import crypto from 'node:crypto';

export const ROOT = pathUtil.join(import.meta.dirname, '..');
export const MANIFEST_PATH = pathUtil.join(ROOT, 'assets-manifest.json');
export const MANIFEST_VERSION = 1;

/**
 * 需要锁定的目录及其默认来源。
 * 只覆盖"下载后未经内容校验"的部分：库文件（download-library-files.mjs）和
 * packager（download-packager.mjs）已经有各自的哈希校验，不在这里重复。
 */
export const COVERED_DIRECTORIES = {
  'dist-extensions': 'https://extensions.turbowarp.org',
  'dist-bilup-extensions': 'https://extensions.bilup.org',
  'dist-astra-extensions': 'https://editors.astras.top/extensions',
  'dist-mw-extensions': 'https://extensions.mistium.com',
  'dist-sp-extensions': 'https://sharkpools-extensions.vercel.app'
};

/**
 * @param {string} absolutePath
 * @returns {string}
 */
export const sha256File = (absolutePath) =>
  crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex');

/**
 * 递归列出目录下的所有文件（绝对路径）。不用 glob，避免引入额外依赖。
 * @param {string} absoluteRoot
 * @returns {string[]}
 */
export const walkFiles = (absoluteRoot) => {
  const result = [];
  const stack = [absoluteRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
      const fullPath = pathUtil.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        result.push(fullPath);
      }
    }
  }
  return result;
};

/**
 * 收集某个受保护目录的内容清单。
 * @param {string} directoryName 相对仓库根的目录名
 * @returns {Record<string, {sha256: string, size: number}> | null} 目录不存在时返回 null
 */
export const collectDirectory = (directoryName) => {
  const absoluteRoot = pathUtil.join(ROOT, directoryName);
  if (!fs.existsSync(absoluteRoot)) {
    return null;
  }

  const entries = {};
  for (const absolutePath of walkFiles(absoluteRoot)) {
    const relativePath = pathUtil.relative(absoluteRoot, absolutePath).split(pathUtil.sep).join('/');
    entries[relativePath] = {
      sha256: sha256File(absolutePath),
      size: fs.statSync(absolutePath).size
    };
  }

  // 按路径排序，保证重新生成时 diff 稳定可读
  const sorted = {};
  for (const key of Object.keys(entries).sort()) {
    sorted[key] = entries[key];
  }
  return sorted;
};
