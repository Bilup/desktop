// 素材库体积优化：把 dist-library-files 里的图片/音频转成更省空间的编码。
//
// 为什么需要这一步：素材库在 asar 里占 37 MB，是整个应用包最大的单项，
// 而这 37 MB **已经过 brotli 预压缩**，安装包的 7z/LZMA 对它无能为力。
// 换句话说，想继续把包压小，只能减少素材本身的体积，不能靠换压缩算法。
//
// 实测（v2.0.12，linux-x64 包内数据）：
//   png  190 个   brotli 后 20.29 MB   解压后 20.69 MB   ← brotli 只省 2%
//   wav  355 个   brotli 后 12.79 MB   解压后 17.22 MB
//   svg  760 个   brotli 后  4.14 MB   解压后 15.19 MB   ← brotli 已经很有效，不动
//
// PNG 已经过 deflate 压缩，套一层 brotli 基本白干；WAV 是未压缩 PCM。
// 所以这两类换成 WebP / Opus 的收益最大：
//   png → WebP(q85)   约 -70%
//   wav → Opus(96k)   约 -85%
// 两者都有“无损/高质量”档位可调。
//
// 关键实现约束：
//   1. 文件名（含扩展名）必须保持不变。scratch-storage 用
//      `assets.scratch.mit.edu/<md5>.<ext>` 拼 URL，扩展名来自项目文件，
//      改了就是 404。所以是“内容是 WebP、名字还是 .png”。
//   2. 仍然用 .br 封装。主进程的 tryReadLocal()（src-main/protocols.js）
//      只会去找 `<path>.br`，没有裸文件回退；转码后继续写 .br，
//      读取链路就完全不用改。
//   3. 内容格式变了，MIME 必须跟着变。procotols 里的 MIME 表按扩展名查，
//      所以配套改了 src-main/protocols.js：按文件魔数修正 content-type
//      （浏览器虽然能 sniff，但显式给对更稳）。
//
// 用法：
//   node scripts/optimize-library-assets.mjs              # 只统计，不动文件
//   node scripts/optimize-library-assets.mjs --apply      # 真的转码并覆盖
//   node scripts/optimize-library-assets.mjs --apply --lossless   # PNG 无损、音频 FLAC
//   node scripts/optimize-library-assets.mjs --apply --png-quality 90 --audio-bitrate 128k
//
// 依赖外部命令 ffmpeg（GitHub 的 ubuntu runner 预装；Windows 本地需自行安装）。
// 转码在构建期做，产物目录会随 `npm run fetch` 重建，所以不写进版本库。

import { spawnSync } from 'node:child_process';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as pathUtil from 'node:path';

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const getArg = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};

const apply = hasFlag('--apply');
const lossless = hasFlag('--lossless');
const pngQuality = getArg('--png-quality', '85');
const audioBitrate = getArg('--audio-bitrate', '96k');

const libraryDirectory = pathUtil.resolve(
  import.meta.dirname,
  '..',
  getArg('--dir', 'dist-library-files')
);

const IMAGE_EXTENSIONS = new Set(['.png']);
const AUDIO_EXTENSIONS = new Set(['.wav']);

const mb = (bytes) => `${(bytes / 1048576).toFixed(2)} MB`;

const ensureFfmpeg = () => {
  const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (probe.error) {
    console.error('找不到 ffmpeg。请先安装（Ubuntu: apt-get install -y ffmpeg）。');
    process.exit(1);
  }
};

// PNG → WebP。lossless 时用无损编码（体积约 -20~25%），否则有损（约 -70%）。
const transcodeImage = (inputPath, outputPath) => {
  const codecArgs = lossless
    ? ['-c:v', 'libwebp', '-lossless', '1', '-compression_level', '6']
    : ['-c:v', 'libwebp', '-quality', pngQuality, '-compression_level', '6'];
  const result = spawnSync(
    'ffmpeg',
    ['-y', '-loglevel', 'error', '-i', inputPath, ...codecArgs, outputPath],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `ffmpeg 退出码 ${result.status}`);
  }
};

// WAV → FLAC（无损）或 Opus（有损，体积小得多）。
const transcodeAudio = (inputPath, outputPath) => {
  const codecArgs = lossless
    ? ['-c:a', 'flac', '-compression_level', '12']
    : ['-c:a', 'libopus', '-b:a', audioBitrate, '-application', 'audio'];
  const result = spawnSync(
    'ffmpeg',
    ['-y', '-loglevel', 'error', '-i', inputPath, ...codecArgs, outputPath],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `ffmpeg 退出码 ${result.status}`);
  }
};

const main = () => {
  if (!fs.existsSync(libraryDirectory)) {
    console.error(`目录不存在：${libraryDirectory}`);
    console.error('请先跑 `npm run fetch` 下载素材库。');
    process.exit(1);
  }

  const entries = fs
    .readdirSync(libraryDirectory)
    .filter((name) => name.endsWith('.br'));

  const candidates = { image: [], audio: [], skipped: 0 };
  for (const name of entries) {
    const baseName = name.replace(/\.br$/, '');
    const extension = pathUtil.extname(baseName).toLowerCase();
    if (IMAGE_EXTENSIONS.has(extension)) {
      candidates.image.push(name);
    } else if (AUDIO_EXTENSIONS.has(extension)) {
      candidates.audio.push(name);
    } else {
      candidates.skipped += 1;
    }
  }

  console.log(`素材库目录：${libraryDirectory}`);
  console.log(`共 ${entries.length} 个文件`);
  console.log(`  可转码图片：${candidates.image.length} 个`);
  console.log(`  可转码音频：${candidates.audio.length} 个`);
  console.log(`  跳过：${candidates.skipped} 个（svg 等，保持 brotli 原样）`);
  console.log(
    `模式：${lossless ? '无损（WebP lossless + FLAC）' : `有损（WebP q${pngQuality} + Opus ${audioBitrate}）`}`
  );

  if (!apply) {
    console.log('\n当前是统计模式，未改动任何文件。');
    console.log('加 --apply 才会真正转码。');
    return;
  }

  ensureFfmpeg();

  const tempDirectory = fs.mkdtempSync(pathUtil.join(os.tmpdir(), 'bilup-assets-'));
  const stats = { image: { count: 0, before: 0, after: 0 }, audio: { count: 0, before: 0, after: 0 } };
  const failures = [];

  const processOne = (name, kind) => {
    const filePath = pathUtil.join(libraryDirectory, name);
    const baseName = name.replace(/\.br$/, '');
    const extension = pathUtil.extname(baseName).toLowerCase();
    const compressedBefore = fs.statSync(filePath).size;

    let raw;
    try {
      raw = brotliDecompressSync(fs.readFileSync(filePath));
    } catch (error) {
      failures.push(`${name}: brotli 解压失败 (${error.message})`);
      return;
    }

    const inputPath = pathUtil.join(tempDirectory, `in${extension}`);
    const outputPath = pathUtil.join(
      tempDirectory,
      kind === 'image' ? 'out.webp' : (lossless ? 'out.flac' : 'out.ogg')
    );
    fs.writeFileSync(inputPath, raw);

    try {
      if (kind === 'image') {
        transcodeImage(inputPath, outputPath);
      } else {
        transcodeAudio(inputPath, outputPath);
      }
    } catch (error) {
      failures.push(`${name}: ffmpeg 失败 (${error.message})`);
      return;
    }

    const transcoded = fs.readFileSync(outputPath);
    // 仍然用 brotli 封装，保持 tryReadLocal() 的 `<path>.br` 查找逻辑不变。
    const compressedAfter = brotliCompressSync(transcoded);

    stats[kind].count += 1;
    stats[kind].before += compressedBefore;
    if (compressedAfter.length < compressedBefore) {
      fs.writeFileSync(filePath, compressedAfter);
      stats[kind].after += compressedAfter.length;
    } else {
      // 转完反而更大（小图很常见），保留原文件。
      stats[kind].after += compressedBefore;
    }
  };

  for (const name of candidates.image) {
    processOne(name, 'image');
  }
  for (const name of candidates.audio) {
    processOne(name, 'audio');
  }

  fs.rmSync(tempDirectory, { recursive: true, force: true });

  const totalBefore = stats.image.before + stats.audio.before;
  const totalAfter = stats.image.after + stats.audio.after;

  console.log('\n== 结果 ==');
  for (const [kind, label] of [['image', '图片'], ['audio', '音频']]) {
    const stat = stats[kind];
    if (stat.count === 0) {
      continue;
    }
    const saved = stat.before - stat.after;
    console.log(
      `  ${label}：${stat.count} 个  ${mb(stat.before)} → ${mb(stat.after)}  ` +
      `省 ${mb(saved)}（${(saved / stat.before * 100).toFixed(0)}%）`
    );
  }
  console.log(
    `  合计：${mb(totalBefore)} → ${mb(totalAfter)}，` +
    `省 ${mb(totalBefore - totalAfter)}（${((totalBefore - totalAfter) / totalBefore * 100).toFixed(0)}%）`
  );
  console.log('  这部分会 1:1 体现在安装包体积上——它们本来就是压缩态，LZMA 不会再动它们。');

  if (failures.length > 0) {
    console.log(`\n  ${failures.length} 个文件转码失败（已保留原文件）：`);
    for (const failure of failures.slice(0, 10)) {
      console.log(`    ${failure}`);
    }
    if (failures.length > 10) {
      console.log(`    ……还有 ${failures.length - 10} 个`);
    }
  }
};

main();
