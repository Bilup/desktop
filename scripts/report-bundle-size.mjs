// 产物体积审计。
//
// 目的：回答"包为什么这么大"，而不是靠猜。
//
// 用法（需要在本地或 CI 跑过 electron-builder 之后执行）：
//   node scripts/report-bundle-size.mjs                  # 扫 dist/
//   node scripts/report-bundle-size.mjs --dir dist-linux # 指定输出目录
//   node scripts/report-bundle-size.mjs --top 40         # 调整大文件榜长度
//
// 输出三部分：
//   1. 安装包本身的大小（按体积降序）；
//   2. app.asar 的成分（按顶层目录聚合 + 最大单文件）；
//   3. Electron 运行时（app.asar 之外）的成分。
//
// 为什么要区分"已压缩"：素材库和扩展在构建期就已经 brotli 预压缩（存成 .br），
// 安装包用的 7z/LZMA 对这部分**几乎压不动**。所以 asar 里 .br 的占比越高，
// 继续压缩安装包的空间就越小——真想再小，只能减少内容，不能指望压缩算法。

import fs from 'node:fs';
import pathUtil from 'node:path';

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};

const rootDirectory = pathUtil.resolve(
  import.meta.dirname,
  '..',
  getArg('--dir', 'dist')
);
const topCount = Number(getArg('--top', 25));

const INSTALLER_EXTENSIONS = [
  '.exe',
  '.msi',
  '.appx',
  '.dmg',
  '.AppImage',
  '.deb',
  '.rpm',
  '.zst',
  '.tar.gz',
  '.snap',
  '.flatpak'
];

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
const pct = (part, total) => (total === 0 ? '0.0%' : `${(part / total * 100).toFixed(1)}%`);

const isInstaller = (name) => {
  const lower = name.toLowerCase();
  return INSTALLER_EXTENSIONS.some((extension) => lower.endsWith(extension.toLowerCase()));
};

/** 递归收集文件，跳过符号链接，避免 universal mac 的重复目录把统计翻倍。 */
const walk = (directory, visit) => {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = pathUtil.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      walk(fullPath, visit);
    } else if (entry.isFile()) {
      try {
        visit(fullPath, fs.statSync(fullPath).size);
      } catch {
        // 打包过程中被删掉的临时文件，忽略
      }
    }
  }
};

const collectFiles = (directory) => {
  const files = [];
  walk(directory, (fullPath, size) => files.push({ fullPath, size }));
  return files;
};

const printRow = (label, size, total, width = 34) => {
  const padded = label.length > width ? `${label.slice(0, width - 1)}…` : label.padEnd(width);
  console.log(`  ${padded} ${mb(size).padStart(10)}  ${pct(size, total).padStart(6)}`);
};

const reportInstallers = (files) => {
  const installers = files
    .filter((file) => isInstaller(pathUtil.basename(file.fullPath)))
    .sort((a, b) => b.size - a.size);

  if (installers.length === 0) {
    console.log('没有找到安装包（可能只跑了 --dir 目标）。');
    return;
  }

  const total = installers.reduce((sum, file) => sum + file.size, 0);
  console.log(`\n== 安装包（${installers.length} 个，合计 ${mb(total)}）==`);
  for (const file of installers) {
    printRow(pathUtil.relative(rootDirectory, file.fullPath), file.size, total, 52);
  }
};

/**
 * asar 内容分两类：
 *   - 已压缩：.br（构建期 brotli）以及 png/jpg/mp3/wav 之类本身压缩过的资源；
 *   - 可压缩：js/html/css/json 等文本。
 * 安装包的 LZMA 只能吃第二类。
 */
const BROTLI_EXTENSION = '.br';
const ALREADY_COMPRESSED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif',
  '.mp3', '.ogg', '.m4a', '.aac', '.zip', '.sb3', '.woff2'
]);

/**
 * 直接读 asar header，不依赖 @electron/asar 的 listPackage。
 *
 * 原因：listPackage 在 Windows 上返回反斜杠路径、且目录条目不带结尾斜杠，
 * 用路径判断"是目录还是文件"会全线错判（统计结果全 0）。header 是纯 JSON，
 * 目录节点带 files 字段、文件节点带 size，判断条件明确。
 *
 * 格式（小端）：
 *   [0..3]   uint32 = 4（下面这个长度字段自身的宽度）
 *   [4..7]   uint32 = headerPickleSize
 *   [8..11]  uint32 = payloadSize
 *   [12..]   header pickle：[uint32 jsonLength][json][padding]
 */
const readAsarHeader = (asarPath) => {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const prefix = Buffer.alloc(12);
    fs.readSync(fd, prefix, 0, 12, 0);
    const headerPickleSize = prefix.readUInt32LE(4);
    const pickle = Buffer.alloc(headerPickleSize);
    fs.readSync(fd, pickle, 0, headerPickleSize, 12);
    const jsonLength = pickle.readUInt32LE(0);
    return JSON.parse(pickle.toString('utf8', 4, 4 + jsonLength));
  } finally {
    fs.closeSync(fd);
  }
};

const collectAsarFiles = (node, prefix, output) => {
  for (const [name, child] of Object.entries(node.files || {})) {
    const relativePath = prefix ? `${prefix}/${name}` : name;
    if (child.files) {
      collectAsarFiles(child, relativePath, output);
    } else {
      output.push({ relativePath, size: child.size || 0, unpacked: !!child.unpacked });
    }
  }
};

const analyzeAsar = (asarPath) => {
  const header = readAsarHeader(asarPath);
  const allFiles = [];
  collectAsarFiles(header, '', allFiles);

  const archiveSize = fs.statSync(asarPath).size;
  const groups = new Map();
  let compressedBytes = 0;
  let totalBytes = 0;
  let unpackedBytes = 0;

  for (const file of allFiles) {
    const segments = file.relativePath.split('/');
    const groupName = segments.length > 1 ? segments[0] : '(根目录)';
    const extension = pathUtil.extname(file.relativePath).toLowerCase();
    const alreadyCompressed =
      extension === BROTLI_EXTENSION || ALREADY_COMPRESSED_EXTENSIONS.has(extension);

    const group = groups.get(groupName) || { size: 0, count: 0, compressed: 0 };
    group.size += file.size;
    group.count += 1;
    if (alreadyCompressed) {
      group.compressed += file.size;
      compressedBytes += file.size;
    }
    groups.set(groupName, group);

    totalBytes += file.size;
    if (file.unpacked) {
      unpackedBytes += file.size;
    }
  }

  console.log(`\n== app.asar 成分（内容 ${mb(totalBytes)}，归档文件 ${mb(archiveSize)}）==`);
  console.log('  说明：「其中已压缩」指 .br 或本身已压缩的图片/音频——安装包的 LZMA 对它们基本无效。\n');
  console.log(`  ${'目录'.padEnd(34)} ${'体积'.padStart(10)}  ${'占比'.padStart(6)}`);

  const sortedGroups = [...groups.entries()].sort((a, b) => b[1].size - a[1].size);
  for (const [name, group] of sortedGroups) {
    printRow(`${name} (${group.count})`, group.size, totalBytes, 34);
    if (group.compressed / group.size > 0.2) {
      console.log(
        `  ${''.padEnd(34)} ${mb(group.compressed).padStart(10)}  ${pct(group.compressed, group.size).padStart(6)}  ← 其中已压缩`
      );
    }
  }

  console.log(
    `\n  已压缩内容：${mb(compressedBytes)}（占内容 ${pct(compressedBytes, totalBytes)}）——安装包压不动`
  );
  console.log(
    `  可压缩内容：${mb(totalBytes - compressedBytes)}（占内容 ${pct(totalBytes - compressedBytes, totalBytes)}）`
  );
  if (unpackedBytes > 0) {
    console.log(`  其中 asarUnpack 外置：${mb(unpackedBytes)}`);
  }

  console.log(`\n  最大的 ${topCount} 个文件：`);
  allFiles.sort((a, b) => b.size - a.size);
  for (const file of allFiles.slice(0, topCount)) {
    console.log(`    ${mb(file.size).padStart(10)}  ${file.relativePath}`);
  }
};

const analyzeRuntime = (appDirectory) => {
  const files = collectFiles(appDirectory).filter((file) =>
    !file.fullPath.endsWith(`${pathUtil.sep}app.asar`)
  );
  if (files.length === 0) {
    return;
  }
  const total = files.reduce((sum, file) => sum + file.size, 0);
  console.log(`\n== Electron 运行时（app.asar 之外，合计 ${mb(total)}）==`);
  files.sort((a, b) => b.size - a.size);
  for (const file of files.slice(0, topCount)) {
    console.log(
      `    ${mb(file.size).padStart(10)}  ${pathUtil.relative(appDirectory, file.fullPath)}`
    );
  }
};

const main = () => {
  if (!fs.existsSync(rootDirectory)) {
    console.error(`目录不存在：${rootDirectory}`);
    console.error('请先跑 electron-builder（或 --dir 指定已有产物目录）。');
    process.exit(1);
  }

  console.log(`审计目录：${rootDirectory}`);
  const files = collectFiles(rootDirectory);
  reportInstallers(files);

  const asarPaths = files
    .filter((file) => file.fullPath.endsWith(`${pathUtil.sep}app.asar`))
    .map((file) => file.fullPath);

  if (asarPaths.length === 0) {
    console.log('\n没有找到 app.asar。');
  }

  for (const asarPath of asarPaths) {
    console.log(`\n--- ${pathUtil.relative(rootDirectory, asarPath)} ---`);
    analyzeAsar(asarPath);
    // 运行时（可执行文件、.pak、locales…）在 resources 的上一层
    analyzeRuntime(pathUtil.dirname(pathUtil.dirname(asarPath)));
  }
};

main();
