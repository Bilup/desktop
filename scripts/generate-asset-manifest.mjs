// 生成（或重新锁定）assets-manifest.json。
//
// 什么时候跑：
//   1. 第一次建立基线；
//   2. 确认上游扩展确实更新了、并且你接受这次变更时。
//
// 跑完后必须把 assets-manifest.json 的 diff 一起提交 —— 这份 diff 就是
// "我确认过这些下载内容"的签字。

import fs from 'node:fs';
import {
  COVERED_DIRECTORIES,
  MANIFEST_PATH,
  MANIFEST_VERSION,
  collectDirectory
} from './asset-manifest.mjs';

const main = () => {
  const directories = {};
  let fileCount = 0;

  for (const [directoryName, source] of Object.entries(COVERED_DIRECTORIES)) {
    const files = collectDirectory(directoryName);
    if (files === null) {
      console.warn(`[assets] 跳过 ${directoryName}：目录不存在（还没跑过 fetch？）`);
      continue;
    }
    directories[directoryName] = {
      source,
      files
    };
    fileCount += Object.keys(files).length;
  }

  if (fileCount === 0) {
    console.error('[assets] 没有收集到任何文件，拒绝写入空清单');
    console.error('[assets] 请先执行 yarn run fetch');
    process.exit(1);
  }

  const manifest = {
    version: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    note: '由 scripts/generate-asset-manifest.mjs 生成。内容变更必须随提交一起 review。',
    directories
  };

  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  console.log(`[assets] 已写入 ${MANIFEST_PATH}（${Object.keys(directories).length} 个目录，${fileCount} 个文件）`);
};

main();
