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
// ⛔ 写进 resolutions 的地址必须是 `<repo>/archive/<sha>.tar.gz`，不能是 `github:repo#sha`。
// yarn 1 解析 git 依赖时会先跑 `git ls-remote --heads --tags`，只认「分支/tag 的 tip」；
// 而 pnpm 锁的是一个任意 commit，一旦它不再是任何 ref 的 tip，yarn 就报
//   error Couldn't find match for "<sha>" in "refs/heads/..." for "https://github.com/..."
// 直接让 install 失败（2026-10-27 CI 就挂在 scratch-vm 的 e5b1731 上）。
// archive 地址走 HTTP 直取那个 commit 的快照，不依赖 ref，内容与 pnpm 拿到的完全一致。
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

/**
 * 生成 resolutions 里用的地址（原因见文件头）。
 * @param {string} owner
 * @param {string} repo
 * @param {string} sha
 * @returns {string}
 */
const pinSpec = (owner, repo, sha) => `https://github.com/${owner}/${repo}/archive/${sha}.tar.gz`;

/**
 * 把历史遗留的 `github:<owner>/<repo>#<40 位 sha>` 归一成 archive 地址。
 * 只处理「钉死 commit」的形式；`#branch` 这类保持原样。
 * @param {string} value
 * @returns {string}
 */
const normalizePin = (value) => {
    const matched = /^github:([^/#\s]+)\/([^/#\s]+)#([0-9a-f]{40})$/i.exec(value);
    return matched ? pinSpec(matched[1], matched[2], matched[3]) : value;
};

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
 *
 * 换行符按原文件来：Windows 检出（core.autocrlf=true）下 package.json 是 CRLF，
 * 若这里只用 '\n' 拼新块，就会写出一个 CRLF/LF 混杂的文件 —— git 会把整份文件
 * 当成重写（261 行全变），review 时什么也看不出来。
 * @param {string} rawInput
 * @param {Record<string, string>} resolutions
 * @returns {string}
 */
const writeResolutions = (rawInput, resolutions) => {
    const usesCrlf = rawInput.includes('\r\n');
    const raw = usesCrlf ? rawInput.replace(/\r\n/g, '\n') : rawInput;

    const lines = Object.keys(resolutions)
        .sort()
        .map((name) => `    ${JSON.stringify(name)}: ${JSON.stringify(normalizePin(resolutions[name]))}`);
    const block = `  "resolutions": {\n${lines.join(',\n')}\n  },`;

    // 先移除已有的 resolutions 块，保证幂等
    const withoutOld = raw.replace(/\n  "resolutions": \{[\s\S]*?\n  \},/, '');

    const out = /\n  "private":/.test(withoutOld)
        ? withoutOld.replace(/\n(  "private":)/, `\n${block}\n$1`)
        : withoutOld.replace(/\n\}\s*$/, `\n${block}\n}\n`);

    return usesCrlf ? out.replace(/\n/g, '\r\n') : out;
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

    // 目标 resolutions（单一真相源）：
    //   - lockfile 里出现的包，一律按 lockfile 钉死；
    //   - 其余已有条目保留（可能是针对某个构建问题的人工覆盖，删掉会出事故），
    //     但写法统一换成 archive 地址 —— 旧的 `github:#sha` 写法同样会让 yarn 挂。
    const target = {};
    for (const [name, {owner, repo, sha}] of deps) {
        target[name] = pinSpec(owner, repo, sha);
    }
    for (const [name, value] of Object.entries(current)) {
        if (!(name in target)) {
            target[name] = normalizePin(value);
        }
    }

    const added = [];
    const changed = [];
    const reformatted = [];
    for (const name of Object.keys(target).sort()) {
        const before = current[name];
        const after = target[name];
        if (before === undefined) {
            added.push(`${name} -> ${after}`);
        } else if (before === after) {
            continue;
        } else if (normalizePin(before) === after) {
            // 只差写法：也算需要写盘，不能让 --check 放过它
            reformatted.push(`${name}: 旧 github: 写法 -> archive 地址`);
        } else {
            changed.push(`${name}: ${before} -> ${after}`);
        }
    }

    if (checkOnly) {
        if (added.length || changed.length || reformatted.length) {
            console.error('[sync] --check 失败：desktop 的 resolutions 与 scratch-gui 的 lockfile 不一致');
            for (const line of added) console.error(`  + ${line}`);
            for (const line of changed) console.error(`  ~ ${line}`);
            for (const line of reformatted) console.error(`  ~ ${line}`);
            process.exit(1);
        }
        console.log(`[sync] --check 通过：${deps.size} 个 git 依赖与 scratch-gui 一致`);
        return;
    }

    if (!added.length && !changed.length && !reformatted.length) {
        console.log(`[sync] 已与 scratch-gui 一致（${deps.size} 个 git 依赖），无需修改`);
        return;
    }

    fs.writeFileSync(PACKAGE_JSON, writeResolutions(raw, target), 'utf-8');

    console.log(`[sync] 已对齐 scratch-gui 的 ${deps.size} 个 git 依赖：`);
    for (const line of added) console.log(`  + ${line}`);
    for (const line of changed) console.log(`  ~ ${line}`);
    for (const line of reformatted) console.log(`  ~ ${line}`);
};

main().catch((error) => {
    console.error(`[sync] ${error.message}`);
    process.exit(1);
});
