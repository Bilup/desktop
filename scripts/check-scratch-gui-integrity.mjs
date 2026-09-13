// 构建期完整性校验：确认安装进来的 scratch-gui 没有"调用了但没导入"的符号。
//
// 背景：desktop 消费的是 Bilup/scratch-gui#develop-builds，它是 CI 用
// `git merge origin/develop -X theirs` 合并出来的产物分支。三方合并只按 hunk
// 取舍，无法删除只存在于 develop-builds 的旧代码，于是会产生"半新半旧"的残骸
// 文件——调用点在、导入块却被删掉了。这类文件能编译通过，只会在运行时抛
// ReferenceError，表现为构建成功、但编辑器一打开就显示 "Desktop React Error"。
//
// patch-scratch-gui-settings.mjs 会先把已知残骸补好；本脚本在其之后运行，
// 用于确认补齐确实生效。一旦这里失败，说明 scratch-gui 又出现了新的残骸
// （或补丁失效），应当先去修 CI 的 develop-builds 同步，而不是继续发版。
//
// 用法：node scripts/check-scratch-gui-integrity.mjs [scratch-gui 根目录]
// 默认根目录为 ./node_modules/scratch-gui

import fs from 'node:fs';
import pathUtil from 'node:path';

const ROOT = pathUtil.join(import.meta.dirname, '..');
const GUI_ROOT = process.argv[2] ?
  pathUtil.resolve(process.argv[2]) :
  pathUtil.join(ROOT, 'node_modules/scratch-gui');

// 每个条目：文件 + 该文件中"必须被导入或被声明"的符号。
// 这些符号正是待修复残骸里出现过的（被删掉的 import 块对应的调用点）。
const TARGETS = [
  {
    file: 'src/components/menu-bar/menu-bar.jsx',
    symbols: [
      'getProjectHistoryState',
      'preloadProjectHistory',
      'subscribeProjectHistory',
      'createMwp',
      'downloadBlob',
      'projectFilename'
    ]
  }
];

const isDeclared = (content, name) => {
  const asImport = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`).test(content) ||
    new RegExp(`import\\s+${name}\\s+from`).test(content);
  const asBinding = new RegExp(`(?:const|let|var)\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(content) ||
    new RegExp(`(?:const|let|var|function|class)\\s+${name}\\b`).test(content);
  return asImport || asBinding;
};

const isUsed = (content, name) => new RegExp(`(?:^|[^\\w$.])${name}\\s*[(.,;)\\]]`, 'm').test(content) ||
  new RegExp(`(?:^|[^\\w$.])${name}\\s*$`, 'm').test(content);

if (!fs.existsSync(GUI_ROOT)) {
  console.log(`[check] scratch-gui not found at ${GUI_ROOT}, skipping`);
  process.exit(0);
}

const problems = [];
for (const {file, symbols} of TARGETS) {
  const fullPath = pathUtil.join(GUI_ROOT, file);
  if (!fs.existsSync(fullPath)) {
    problems.push(`${file}: 文件不存在（scratch-gui 安装不完整？）`);
    continue;
  }
  const content = fs.readFileSync(fullPath, 'utf-8');
  for (const name of symbols) {
    if (isUsed(content, name) && !isDeclared(content, name)) {
      problems.push(`${file}: 使用了 ${name}，但既没有导入也没有本地声明`);
    }
  }
}

if (problems.length) {
  console.error('\n[check] scratch-gui 完整性校验失败：\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error([
    '',
    '这说明 node_modules/scratch-gui 是一个"合并残骸"版本：调用点还在，',
    '对应的 import 已被 develop-builds 的同步合并删掉。运行时会抛 ReferenceError，',
    '页面只会显示 "Desktop React Error"，编辑器打不开。',
    '',
    '根因在 Bilup/scratch-gui 的 .github/workflows/CI.yml（"Deploy to develop-builds" 曾用',
    '`git merge origin/develop -X theirs`）。请先修复该同步逻辑，让 develop-builds 的源码',
    '严格等于 develop，再重新发版。',
    ''
  ].join('\n'));
  process.exit(1);
}

console.log('[check] scratch-gui integrity OK');
