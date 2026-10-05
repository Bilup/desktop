// 让 desktop 关于 scratch-gui 的依赖与网页端严格一致。
//
// 背景：网页端（scratch-gui 的 CI）用 pnpm + pnpm-lock.yaml，把 scratch-vm /
// scratch-render / scratch-audio / new-scratch-blocks 等 git 依赖钉死在具体 commit；
// 而 desktop 用 yarn 且没有 lockfile，同一个 `github:Bilup/scratch-vm#develop-builds`
// 声明会被解析成"分支最新"。两边因此随时间漂移 —— desktop 会跑到网页端前面，
// 表现为"运行作品的代码和 gui 不一致"（间歇性出现）。
//
// 这里从 scratch-gui 的 pnpm-lock.yaml 抽出全部 git(tarball) 依赖的 commit，
// 写进 desktop 的 package.json 的 resolutions，让 yarn 解析整棵依赖树时都用同一批 commit。
//
// 用法：
//   node scripts/sync-scratch-deps.mjs                # 从远端拉（CI 用）
//   node scripts/sync-scratch-deps.mjs --lock <path>  # 用本地 lockfile（离线调试）
//   node scripts/sync-scratch-deps.mjs --check        # 只校验，不写入；不一致则退出码 1
import fs from 'node:fs';
import pathUtil from 'node:path';

const ROOT = pathUtil.join(import.meta.dirname, '..');
const PACKAGE_JSON = pathUtil.join(ROOT, 'package.json');
const GUI_REPO = 'Bilup/scratch-gui';
const GUI_BRANCH = 'develop';

/** 合法 npm 包名（含 scope），用于挡住解析异常 */
const VALID_PACKAGE_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;

const argv = process.argv.slice(2);
const lockArgIndex = argv.indexOf('--lock');
const localLock = lockArgIndex !== -1 ? argv[lockArgIndex + 1] : null;
const checkOnly = argv.includes('--check');

if (lockArgIndex !== -1 && !localLock) {
    console.error('[sync] --lock 需要跟一个文件路径');
    process.exit(1);
}

/**
 * @returns {Promise<string>} pnpm-lock.yaml 内容
 */
const readLockfile = async () => {
    if (localLock) {
        console.log(`[sync] 读取本地 lockfile：${localLock}`);
        return fs.readFileSync(localLock, 'utf-8');
    }
    const url = `https://raw.githubusercontent.com/${GUI_REPO}/${GUI_BRANCH}/pnpm-lock.yaml`;
    console.log(`[sync] 拉取 ${url}`);
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`拉取 pnpm-lock.yaml 失败：HTTP ${response.status}`);
    }
    return response.text();
};

/**
 * 从 pnpm-lock.yaml 里解析所有指向 GitHub tarball 的依赖。
 * 只匹配 key 行即可 —— key 本身就带包名和 tarball 地址，例如：
 *   scratch-vm@https://codeload.github.com/Bilup/scratch-vm/tar.gz/<sha>:
 *   @bilup/scratch-l10n@https://codeload.github.com/Bilup/scratch-l10n/tar.gz/<sha>(peer)(peer):
 * @param {string} lock
 * @returns {Map<string, {owner: string, repo: string, sha: string}>}
 */
const parseGitDeps = (lock) => {
    const deps = new Map();
    const keyedTarballs = new Set();

    // 包名一律不允许出现空白/引号/@，避免跨行误匹配（曾经因此把整段 YAML 当成键名）。
    // 末尾的 `'?` 是必需的：pnpm 会给带 scope 的 key 加单引号，形如
    //   '@bilup/scratch-l10n@https://codeload.github.com/...':
    const keyRe = /^ {2}'?((?:@[^/'"\s]+\/)?[^@'"\s]+)'?@(https:\/\/codeload\.github\.com\/([^/\s]+)\/([^/\s]+)\/tar\.gz\/([0-9a-f]{40}))'?(?:\(|:)/gm;
    let match;
    while ((match = keyRe.exec(lock))) {
        const [, name, tarball, owner, repo, sha] = match;
        if (!VALID_PACKAGE_NAME.test(name)) {
            throw new Error(
                `pnpm-lock 解析出非法包名 ${JSON.stringify(name.slice(0, 60))} —— ` +
                'lockfile 格式可能已变化，中止以免写坏 package.json'
            );
        }
        keyedTarballs.add(tarball);
        if (!deps.has(name)) {
            deps.set(name, {owner, repo, sha});
        }
    }

    // 交叉校验：出现在 resolution 里的每个 tarball，都必须能从 key 行认出来。
    // 少了任何一个都说明正则和 lockfile 格式已经对不上，宁可直接失败也不要静默漏钉。
    const resolutionRe = /resolution:\s*\{tarball:\s*(https:\/\/codeload\.github\.com\/[^}]+?)\}/g;
    const missed = new Set();
    while ((match = resolutionRe.exec(lock))) {
        const url = match[1].trim();
        if (!keyedTarballs.has(url)) {
            missed.add(url);
        }
    }
    if (missed.size) {
        throw new Error(
            `有 ${missed.size} 个 git 依赖未能从 key 行解析（正则与 lockfile 格式不匹配），中止：\n  ` +
            [...missed].slice(0, 5).join('\n  ')
        );
    }

    return deps;
};

/**
 * 以原始文本方式替换 package.json 里的 resolutions 块，避免 JSON.stringify
 * 重排整个文件、产生无关 diff。
 * @param {string} raw
 * @param {Record<string, string>} resolutions
 * @returns {string}
 */
const writeResolutions = (raw, resolutions) => {
    const lines = Object.keys(resolutions)
        .sort()
        .map((name) => `    ${JSON.stringify(name)}: ${JSON.stringify(resolutions[name])}`);
    const block = `  "resolutions": {\n${lines.join(',\n')}\n  },`;

    // 先移除已有的 resolutions 块，保证幂等
    const withoutOld = raw.replace(/\n  "resolutions": \{[\s\S]*?\n  \},/, '');

    if (/\n  "private":/.test(withoutOld)) {
        return withoutOld.replace(/\n(  "private":)/, `\n${block}\n$1`);
    }
    return withoutOld.replace(/\n\}\s*$/, `\n${block}\n}\n`);
};

const main = async () => {
    const lock = await readLockfile();
    const deps = parseGitDeps(lock);

    if (deps.size === 0) {
        throw new Error('未从 pnpm-lock.yaml 解析出任何 git 依赖 —— lockfile 格式可能已变化，中止');
    }

    const raw = fs.readFileSync(PACKAGE_JSON, 'utf-8');
    const pkg = JSON.parse(raw);
    const current = pkg.resolutions || {};

    const wanted = {};
    const added = [];
    const changed = [];
    for (const [name, {owner, repo, sha}] of [...deps].sort((a, b) => a[0].localeCompare(b[0]))) {
        const want = `github:${owner}/${repo}#${sha}`;
        wanted[name] = want;
        if (current[name] === want) continue;
        if (current[name]) {
            changed.push(`${name}: ${current[name]} -> ${want}`);
        } else {
            added.push(`${name} -> ${want}`);
        }
    }

    if (checkOnly) {
        if (added.length || changed.length) {
            console.error('[sync] --check 失败：desktop 的 resolutions 与 scratch-gui 的 lockfile 不一致');
            for (const line of added) console.error(`  + ${line}`);
            for (const line of changed) console.error(`  ~ ${line}`);
            process.exit(1);
        }
        console.log(`[sync] --check 通过：${deps.size} 个 git 依赖与 scratch-gui 一致`);
        return;
    }

    if (!added.length && !changed.length) {
        console.log(`[sync] 已与 scratch-gui 一致（${deps.size} 个 git 依赖），无需修改`);
        return;
    }

    // 与已有 resolutions 合并：只增改 lockfile 里出现的包，其余条目原样保留。
    // 那些可能是人工添加的（例如针对某个构建问题的临时覆盖），删掉会出事故。
    fs.writeFileSync(PACKAGE_JSON, writeResolutions(raw, {...current, ...wanted}), 'utf-8');

    console.log(`[sync] 已对齐 scratch-gui 的 ${deps.size} 个 git 依赖：`);
    for (const line of added) console.log(`  + ${line}`);
    for (const line of changed) console.log(`  ~ ${line}`);
};

main().catch((error) => {
    console.error(`[sync] ${error.message}`);
    process.exit(1);
});
