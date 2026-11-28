import * as fs from 'node:fs';
import * as pathUtil from 'node:path';
import {spawnSync} from 'node:child_process';
import { computeSHA256, persistentFetch } from './lib.mjs';
import packagerInfo from './packager.json' with { type: 'json' };

const path = pathUtil.join(import.meta.dirname, '../src-renderer/packager/standalone.html');

const localPackagerDir = process.env.BILUP_PACKAGER_DIR
  ? pathUtil.resolve(process.env.BILUP_PACKAGER_DIR)
  : pathUtil.join(import.meta.dirname, '../../packager');

const localStandalonePath = pathUtil.join(localPackagerDir, 'dist', 'standalone.html');

// Windows 上 npm 是 npm.cmd，spawnSync 不经过 shell 时无法执行（EINVAL，
// status 为 null），表现为 "Packager build failed with exit code null"。
const npmSpawnOptions = {
  ...(process.platform === 'win32' ? { shell: true } : {})
};

const tryUseLocalPackager = () => {
  try {
    if (!fs.existsSync(localPackagerDir)) return false;
    if (!fs.existsSync(pathUtil.join(localPackagerDir, 'package.json'))) return false;

    if (!fs.existsSync(localStandalonePath)) {
      const nodeModulesPath = pathUtil.join(localPackagerDir, 'node_modules');
      if (!fs.existsSync(nodeModulesPath)) {
        console.log(`Installing packager dependencies in ${localPackagerDir}`);
        const install = spawnSync('npm', ['ci'], {
          ...npmSpawnOptions,
          cwd: localPackagerDir,
          stdio: 'inherit'
        });
        if (install.status !== 0) {
          throw new Error(`Packager install failed with exit code ${install.status}`);
        }
      }

      console.log('Building standalone packager');
      const build = spawnSync('npm', ['run', 'build-standalone-prod'], {
        ...npmSpawnOptions,
        cwd: localPackagerDir,
        stdio: 'inherit'
      });
      if (build.status !== 0) {
        throw new Error(`Packager build failed with exit code ${build.status}`);
      }
    }

    if (!fs.existsSync(localStandalonePath)) {
      throw new Error(`Expected packager output at ${localStandalonePath} but it does not exist`);
    }

    fs.mkdirSync(pathUtil.dirname(path), {
      recursive: true
    });
    fs.copyFileSync(localStandalonePath, path);

    console.log(`Using local packager from ${localStandalonePath}`);
    return true;
  } catch (e) {
    console.warn('Failed to use local packager; falling back to downloading released packager.');
    console.warn(e);
    return false;
  }
};

const isAlreadyDownloaded = () => {
  try {
    const data = fs.readFileSync(path);
    return computeSHA256(data) === packagerInfo.sha256;
  } catch (e) {
    // file might not exist, ignore
  }
  return false;
};

// 远端 CI 不允许回退到本地源码目录。runner 上本不该有 ../packager，但一旦出现
// （自定义镜像、submodule、上一轮残留），本地构建会静默替换发布产物，让
// packager.json 锁定的版本失效，而日志看起来一切正常。需要显式放开时用
// BILUP_PACKAGER_ALLOW_LOCAL=1。
const allowLocalPackager = !process.env.CI || process.env.BILUP_PACKAGER_ALLOW_LOCAL === '1';
if (!allowLocalPackager) {
  console.log('CI 环境：跳过本地 packager 源码目录，强制使用 packager.json 锁定的发布产物');
}
const usedLocal = allowLocalPackager ? tryUseLocalPackager() : false;

if (usedLocal) {
  process.exit(0);
}

if (isAlreadyDownloaded()) {
  console.log('Packager already updated');
  process.exit(0);
}

console.log(`Downloading ${packagerInfo.src}`);
console.time('Download packager');

persistentFetch(packagerInfo.src)
  .then((res) => res.arrayBuffer())
  .then((buffer) => {
    const sha256 = computeSHA256(buffer);
    if (packagerInfo.sha256 !== sha256) {
      throw new Error(`Hash mismatch: expected ${packagerInfo.sha256} but found ${sha256}`);
    }

    fs.mkdirSync(pathUtil.dirname(path), {
      recursive: true
    });
    fs.writeFileSync(path, new Uint8Array(buffer));
  })
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
