// 校验 src-renderer/packager/standalone.html 是否就是 scripts/packager.json 锁定的那份产物。
//
// 为什么需要这一步：
//   1. download-packager.mjs 在下载之前会先尝试本地源码目录（../packager 或
//      BILUP_PACKAGER_DIR），命中就直接构建/复制，完全绕过 packager.json；
//   2. standalone.html 被 .gitignore 忽略，CI 里只靠 artifact 在 job 之间传递，
//      任何"缓存命中/文件残留"都会让旧版本混进安装包而日志毫无异常。
// 远端构建必须在这里硬失败，避免发出去的安装包里打包器版本是错的。
import fs from 'node:fs';
import pathUtil from 'node:path';
import { computeSHA256 } from './lib.mjs';
import packagerInfo from './packager.json' with { type: 'json' };

const target = pathUtil.join(import.meta.dirname, '../src-renderer/packager/standalone.html');
const version = (packagerInfo.src.match(/\/download\/([^/]+)\//) || [])[1] || 'unknown';

if (!fs.existsSync(target)) {
  console.error(`[packager] 缺少 ${target}；请先运行 node scripts/download-packager.mjs`);
  process.exit(1);
}

const actual = computeSHA256(fs.readFileSync(target));
const expected = packagerInfo.sha256;
const size = fs.statSync(target).size;

console.log(`[packager] 目标版本 ${version}，文件大小 ${size} 字节`);
console.log(`[packager] expected sha256 = ${expected}`);
console.log(`[packager] actual   sha256 = ${actual}`);

if (actual !== expected) {
  const message = `[packager] 内嵌打包器与 packager.json 不一致（应为 ${version}）`;
  // CI 里必须失败：否则 package job 会把错误的打包器打进安装包。
  if (process.env.CI) {
    console.error(`${message}，构建中止。`);
    process.exit(1);
  }
  // 本地允许用 BILUP_PACKAGER_DIR 构建的产物做调试，不阻断。
  console.warn(`${message}；本地可能用了本地源码构建的版本，远端会以 packager.json 为准。`);
} else {
  console.log('[packager] 校验通过');
}
