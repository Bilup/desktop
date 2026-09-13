// 构建期完整性校验：确认安装进来的 scratch-gui 没有"调用了但没导入/没声明"的符号，
// 也没有已知形态的语法残缺。
//
// 背景：desktop 消费的是 Bilup/scratch-gui#develop-builds，它是 CI 合并出来的产物分支。
// 历史上用的是 `git merge origin/develop -X theirs`，而三方合并只按 hunk 取舍，
// **无法删除只存在于 develop-builds 的旧代码**。当 develop 重构/删除某个特性时
// （例如把 Git/版本历史重写进 lib/git/ops），合并就会留下"半新半旧"的残骸文件：
// 调用点在、对应的 import 被删掉。这类文件能编译通过，只在运行时抛 ReferenceError，
// 表现为构建成功、但编辑器打不开（"Desktop React Error"）或某个功能一点就崩。
//
// 本脚本在两处把关：
//   1. 在 patch-scratch-gui-settings.mjs 之后运行，确认已修补的致命残骸确实补齐了；
//   2. 把同类残骸的完整特征列出来，一旦再出现就在构建期报出来，而不是等用户点出来。
//
// 分级：
//   FATAL —— 挂载/渲染期就会触发，或直接导致构建失败 → 让构建失败。
//   WARN  —— 只在特定交互（保存 MWP、拖拽舞台分隔条、举报弹窗等）触发 → 只提示。
//   这些特征在 develop-builds 按 develop 重新生成后应当全部消失；若仍在，
//   说明 CI 的 develop-builds 同步又出了问题，应先去修同步而不是继续发版。
//
// 用法：node scripts/check-scratch-gui-integrity.mjs [scratch-gui 根目录]
// 默认根目录为 ./node_modules/scratch-gui

import fs from 'node:fs';
import pathUtil from 'node:path';

const ROOT = pathUtil.join(import.meta.dirname, '..');
const GUI_ROOT = process.argv[2] ?
  pathUtil.resolve(process.argv[2]) :
  pathUtil.join(ROOT, 'node_modules/scratch-gui');

const FATAL = [
  {
    file: 'src/components/menu-bar/menu-bar.jsx',
    why: '构造函数 / componentDidMount 里调用，编辑器一挂载就抛 ReferenceError，界面直接打不开',
    symbols: [
      'getProjectHistoryState',
      'subscribeProjectHistory'
    ]
  },
  {
    file: 'src/components/toast-notification/toast-notification.jsx',
    why: 'useEffect 依赖数组在渲染期求值，任何 toast 都会抛 ReferenceError',
    symbols: ['sequence']
  }
];

// 已知的"语法残骸"形态：try 后面直接 `});`，缺 catch/finally —— webpack 会直接编译失败。
//
// 注意两个坑（都实测踩过）：
//   1. 不要用一条 `[\s\S]*?` 大正则跨行匹配——它会从这段 try 一路跨到文件后面另一段
//      正确代码的 `});` 上，把已修好的文件判成坏的；
//   2. 不能直接在整个窗口里找 `});`——`request(..., {method: 'DELETE'});` 这种调用本身
//      就含 `});`。
// 所以：先定位起点，再只看 `await refresh();` 之后紧跟的是 `} catch/finally`（正常）
// 还是 `});`（残骸）。
const detectDanglingTry = (content) => {
  const idx = content.search(/try\s*\{\s*await request\(`\/theme\?uuid=/);
  if (idx < 0) return false;
  const window = content.slice(idx, idx + 1000);
  const refresh = window.search(/await refresh\(\);/);
  if (refresh < 0) return false;
  const rest = window.slice(refresh).replace(/^await refresh\(\);\s*/, '');
  if (/^\}\s*(catch|finally)\b/.test(rest)) return false;
  return /^\}\);/.test(rest);
};

const SYNTAX_FAULTS = [
  {
    file: 'src/community/components/WarpThemePanel.jsx',
    why: 'try 缺 catch/finally（合并残骸），会让 webpack 编译失败、产物缺失',
    detect: detectDanglingTry
  }
];

const WARN = [
  {
    file: 'src/components/menu-bar/menu-bar.jsx',
    why: '保存 MWP / Fractch Terminal / "另存为"菜单项 时才触发（编辑器本身能打开）',
    symbols: [
      'preloadProjectHistory',
      'createMwp',
      'downloadBlob',
      'projectFilename',
      'saveAs',
      'commitChanges',
      'openFractchTerminalWindow',
      'FileInput'
    ]
  },
  {
    file: 'src/components/gui/gui.jsx',
    why: '拖拽舞台分隔条、或关闭窗口清理监听器时才触发',
    symbols: ['onUp']
  },
  {
    file: 'src/community/components/ReportModal.jsx',
    why: '打开举报弹窗时触发',
    symbols: ['REASONS']
  },
  {
    file: 'src/community/pages/MyStuff.jsx',
    why: '在 My Stuff 里删除项目时触发',
    symbols: ['setOpenMenu']
  }
];

/**
 * 该符号在本文件里是否被使用。刻意排除 `x.name`（属性 / 消息 id）这类形态，
 * 否则 `mw.menuBar.gitPush` 之类会被误判成引用。
 */
const isUsed = (content, name) => {
  const call = new RegExp(`(?:^|[^\\w$.])${name}\\s*[(\\[.,;)\\]}?=]|(?:^|[^\\w$.])${name}\\s*$`, 'm');
  const jsx = new RegExp(`<\\s*${name}[\\s/>]`);
  const tail = new RegExp(`(?:^|[^\\w$.])${name}\\s*$`, 'm');
  return call.test(content) || jsx.test(content) || tail.test(content);
};

/** 该符号在本文件里是否已被导入或声明（宁可宽松，避免误报导致误停构建）。 */
const isDeclared = (content, name) => {
  const patterns = [
    new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`),
    new RegExp(`import\\s+${name}\\s+from`),
    new RegExp(`import\\s*\\*\\s*as\\s+${name}\\b`),
    new RegExp(`(?:const|let|var)\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`),
    new RegExp(`(?:const|let|var)\\s*\\[[^\\]]*\\b${name}\\b[^\\]]*\\]`),
    new RegExp(`(?:const|let|var|function|class)\\s+${name}\\b`),
    new RegExp(`function\\s*\\*?\\s*[\\w$]*\\s*\\([^)]*\\b${name}\\b`),
    new RegExp(`catch\\s*\\([^)]*\\b${name}\\b`),
    new RegExp(`\\(\\s*[^)]*\\b${name}\\b[^)]*\\)\\s*=>`),
    new RegExp(`\\(?\\s*${name}\\s*\\)?\\s*=>`),
    new RegExp(`\\.\\.\\.\\s*${name}\\b`)
  ];
  return patterns.some((re) => re.test(content));
};

if (!fs.existsSync(GUI_ROOT)) {
  console.log(`[check] scratch-gui not found at ${GUI_ROOT}, skipping`);
  process.exit(0);
}

const fatal = [];
const warn = [];
const skipped = [];

const checkSymbols = (list, bucket) => {
  for (const {file, why, symbols} of list) {
    const fullPath = pathUtil.join(GUI_ROOT, file);
    if (!fs.existsSync(fullPath)) {
      skipped.push(file);
      continue;
    }
    const content = fs.readFileSync(fullPath, 'utf-8');
    for (const name of symbols || []) {
      if (isUsed(content, name) && !isDeclared(content, name)) {
        bucket.push(`${file}: 使用了 ${name} 但既未导入也未声明 —— ${why}`);
      }
    }
  }
};

checkSymbols(FATAL, fatal);
checkSymbols(WARN, warn);

for (const {file, why, detect} of SYNTAX_FAULTS) {
  const fullPath = pathUtil.join(GUI_ROOT, file);
  if (!fs.existsSync(fullPath)) {
    skipped.push(file);
    continue;
  }
  if (detect(fs.readFileSync(fullPath, 'utf-8'))) {
    fatal.push(`${file}: ${why}`);
  }
}

if (warn.length) {
  console.warn('\n[check] scratch-gui 仍有合并残骸（非致命，特定交互才会触发）：\n');
  for (const w of warn) console.warn(`  ! ${w}`);
  console.warn('\n  这些应当在 develop-builds 按 develop 重新生成后消失。');
}

if (fatal.length) {
  console.error('\n[check] scratch-gui 完整性校验失败（致命）：\n');
  for (const f of fatal) console.error(`  - ${f}`);
  console.error([
    '',
    '这说明 node_modules/scratch-gui 是"合并残骸"版本：调用点还在，对应的 import 已被',
    'develop-builds 的同步合并删掉。运行时会抛 ReferenceError —— 编辑器打不开，或页面只剩',
    '"Desktop React Error"。',
    '',
    '根因在 Bilup/scratch-gui 的 .github/workflows/CI.yml（"Deploy to develop-builds"）：',
    '不得再用 `git merge origin/develop -X theirs`（它无法删除产物分支独有的旧代码）。',
    '正确做法是让 develop-builds 的源码严格等于 develop，然后重新生成该分支。',
    ''
  ].join('\n'));
  process.exit(1);
}

if (skipped.length) console.log(`[check] 跳过不存在的文件 ${skipped.length} 个`);
console.log('[check] scratch-gui integrity OK');
