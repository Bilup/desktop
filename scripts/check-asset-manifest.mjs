// 校验下载产物是否与 assets-manifest.json 一致。
//
// 接在 npm run fetch 的最后一步：
//   - 清单不存在 -> 只提示（第一次接入时不能把既有流程卡死）；
//   - 目录不存在 -> 跳过该目录（某些源可能没下载成功）；
//   - 内容被替换 / 文件被增删 -> 退出码 1，让 CI 失败。
//
// 上游正常更新时的处理：确认真实变更后跑
//   node scripts/generate-asset-manifest.mjs
// 再提交 assets-manifest.json。

import fs from 'node:fs';
import {MANIFEST_PATH, MANIFEST_VERSION, collectDirectory} from './asset-manifest.mjs';

const readManifest = () => {
  if (!fs.existsSync(MANIFEST_PATH)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
  } catch (error) {
    console.error(`[assets] assets-manifest.json 解析失败：${error.message}`);
    process.exit(1);
  }
};

const formatBytes = (bytes) => `${bytes} B`;

const main = () => {
  const manifest = readManifest();
  if (manifest === null) {
    console.warn('[assets] 未找到 assets-manifest.json，跳过校验。');
    console.warn('[assets] 建立基线请执行：node scripts/generate-asset-manifest.mjs，并提交生成的文件。');
    return;
  }

  if (manifest.version !== MANIFEST_VERSION) {
    console.error(`[assets] 清单版本 ${manifest.version} 与脚本期望的 ${MANIFEST_VERSION} 不一致，请重新生成`);
    process.exit(1);
  }

  const problems = [];

  for (const [directoryName, expected] of Object.entries(manifest.directories || {})) {
    const actual = collectDirectory(directoryName);
    if (actual === null) {
      console.warn(`[assets] 跳过 ${directoryName}：目录不存在`);
      continue;
    }

    const expectedFiles = expected.files || {};

    for (const [relativePath, expectedEntry] of Object.entries(expectedFiles)) {
      const actualEntry = actual[relativePath];
      if (!actualEntry) {
        problems.push(`- ${directoryName}/${relativePath}：清单里有，磁盘上没有（文件缺失或被删除）`);
        continue;
      }
      if (actualEntry.sha256 !== expectedEntry.sha256) {
        problems.push(
          `~ ${directoryName}/${relativePath}：内容已变化（${formatBytes(expectedEntry.size)} -> ${formatBytes(actualEntry.size)}，sha256 不一致）`
        );
      }
    }

    for (const relativePath of Object.keys(actual)) {
      if (!expectedFiles[relativePath]) {
        problems.push(`+ ${directoryName}/${relativePath}：磁盘上有，清单里没有（新增文件）`);
      }
    }
  }

  if (problems.length > 0) {
    console.error(`[assets] 校验失败，发现 ${problems.length} 处不一致：`);
    for (const line of problems.slice(0, 50)) {
      console.error(`  ${line}`);
    }
    if (problems.length > 50) {
      console.error(`  …… 还有 ${problems.length - 50} 处未列出`);
    }
    console.error('');
    console.error('[assets] 如果这是上游正常更新：加审阅并重新锁定');
    console.error('         node scripts/generate-asset-manifest.mjs');
    console.error('[assets] 如果不是预期变更：检查下载源是否被篡改，不要重新生成清单。');
    process.exit(1);
  }

  console.log('[assets] 校验通过：下载产物与 assets-manifest.json 一致');
};

main();
