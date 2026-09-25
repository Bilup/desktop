const {app} = require('electron');

// requestSingleInstanceLock() crashes the app in signed MAS builds
// https://github.com/electron/electron/issues/15958
if (!process.mas && !app.requestSingleInstanceLock()) {
  app.exit();
}

const path = require('path');
const os = require('os');
const AbstractWindow = require('./windows/abstract');
const EditorWindow = require('./windows/editor');
const {checkForUpdates} = require('./update-checker');
const {tranlateOrNull} = require('./l10n');
const migrate = require('./migrate');
const settings = require('./settings');
const diagnostics = require('./diagnostics');
const protocols = require('./protocols');
require('./context-menu');
require('./menu-bar');
require('./crash-messages');

app.enableSandbox();

// Allows certain versions of Scratch Link to work without an internet connection
// https://github.com/LLK/scratch-desktop/blob/4b462212a8e406b15bcf549f8523645602b46064/src/main/index.js#L45
app.commandLine.appendSwitch('host-resolver-rules', 'MAP device-manager.scratch.mit.edu 127.0.0.1');

/**
 * 合并式追加 --enable-features / --disable-features。
 *
 * Chromium 解析重复出现的同一个 switch 时只取第一次见到的值，直接连着调用
 * 两次 appendSwitch 会让后一次被静默丢弃。所以这里先读出已有的值再拼接。
 * @param {string} switchName 'enable-features' 或 'disable-features'
 * @param {string} features 逗号分隔的 feature 名
 */
const appendFeatures = (switchName, features) => {
  const existing = app.commandLine.getSwitchValue(switchName);
  app.commandLine.appendSwitch(switchName, existing ? `${existing},${features}` : features);
};

// Windows 上 Chromium 会用系统报告的窗口遮挡状态来决定还要不要给这个窗口发
// requestAnimationFrame。这个判定经常出错：窗口只被别的窗口盖住一部分、
// 有置顶小工具浮在上面、切虚拟桌面、多显示器热插拔，都可能被误判成"完全被
// 遮挡"。一旦判错，舞台的 rAF 循环直接停摆 —— 项目逻辑照常在跑，画面却不再
// 刷新，表现就是"窗口一被挡住就卡住/掉帧"。
// 网页端很难踩到，因为浏览器标签页有自己一套可见性判定；桌面端窗口长期和
// IDE、浏览器并排使用，正是这个误判的高发场景。
// 关掉遮挡计算只影响"要不要继续绘制"，真正的后台节流仍然由
// settings.backgroundThrottling 和下面的 disable-* 开关控制。
// https://github.com/electron/electron/issues/27214
appendFeatures('disable-features', 'CalculateNativeWinOcclusion');

// SwiftShader is Chromium's software WebGL fallback. Starting in Chrome 139,
// it is disabled by default. Enabling SwiftShader is required for the editor
// to work without hardware acceleration, so adding this flag will be
// required. Google considers this dangerous, so only add the flag when it is
// needed.
// https://github.com/TurboWarp/desktop/issues/1158
// https://chromestatus.com/feature/5166674414927872
// https://chromium.googlesource.com/chromium/src/+/main/docs/gpu/swiftshader.md
//
// 注意：这个开关必须无条件打开，不能只在 "用户关掉硬件加速" 时才打开。
// 如果显卡被 Chromium 的驱动黑名单拦掉（integrated GPU + 旧驱动很常见），
// 即使 settings.hardwareAcceleration 为 true，WebGL 也只能回退到软件渲染；
// 而在 Chrome 139+ 上这个软件兜底默认是关闭的，结果是 WebGL 直接创建失败或
// 走 CPU 路径，Scratch 渲染器会慢 1~2 个数量级 —— 这正是桌面端比网页端慢的
// 头号原因之一。网页端用户往往已经升级过 Chrome/驱动，桌面端只能靠这个开关
// 兜底。
// 作用是"保证 WebGL 一定有可用后端"，不是"强制走某条路"：硬件加速不可用时它只是
// 把软件兜底放回可用状态，Chromium 仍然优先用硬件。所以它是安全的，无条件打开。
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

// 其余 GPU 开关默认**一律不加**，让 Chromium 按自己的硬件判断走。
//
// 为什么反过来：
//   `ignore-gpu-blocklist` / `enable-gpu-rasterization` / `enable-zero-copy` /
//   `force_high_performance_gpu` 这四个都是"覆盖 Chromium 判断"的强制开关，而
//   Chromium 的黑名单与光栅化策略是在具体驱动上实测过才写进去的。被排除的配置
//   往往不是"慢一点"，而是跨显卡拷贝、驱动已知的慢路径、GPU 进程反复重建 ——
//   表现正好是**周期性卡到个位数帧率**，而网页端不做任何覆盖，所以反而是稳的。
//   前几轮无条件打开它们的理由是"黑名单机器会掉到软件渲染"，那是硬件无关的推测，
//   对多数机器不成立，却给所有机器引入了强制路径的风险。现在以"与浏览器一致"
//   为默认。
//
// 想强制启用（例如确认独显笔记本一直落在核显上），把设置文件里的
// `forceGpuFlags` 改成 true 再重启：
//   %APPDATA%/bilup-desktop/settings.json
if (settings.hardwareAcceleration) {
  if (settings.forceGpuFlags) {
    app.commandLine.appendSwitch('ignore-gpu-blocklist');
    app.commandLine.appendSwitch('enable-gpu-rasterization');
    app.commandLine.appendSwitch('enable-zero-copy');
    app.commandLine.appendSwitch('force_high_performance_gpu');
  }
} else {
  app.disableHardwareAcceleration();
}

/**
 * 放宽渲染进程的 V8 老生代上限。
 *
 * Chromium 把它**硬编码在 2GB**（V8 的 `V8HeapTrait::kMaxSize`，64 位；源码里只有
 * "物理内存 ≥16GB 时从 2GB 提到 4GB" 的实验分支），**和机器实际有多少内存无关**。
 * 对 Scratch 这种「一个大 project.json 解析成几十万个对象」的负载，2GB 是够得着的：
 * 堆一旦接近上限，V8 的 `CanExpandOldGeneration` 就会判定扩不动，于是**大幅提高
 * full GC 频率**（表现是周期性卡顿、帧率掉到个位数），再往上就是
 * "JavaScript heap out of memory"，直接崩掉渲染进程。
 *
 * 这里按物理内存给一个更宽松的上限（40%；下限保持 Chromium 的默认值 —— 收紧只会让
 * GC 更频繁；上限是 V8 在 64 位下的 4GB）：
 *   4GB 内存  -> 2048MB（等于默认）
 *   8GB 内存  -> 3276MB
 *   16GB 以上 -> 4096MB
 *
 * 它只是**上限**、不是预分配：普通项目仍然只用几百 MB，V8 需要时才增长。作用是内存
 * 充裕时不要提前进入剧烈 GC，内存紧张时也不至于被一个过小的天花板逼死在 OOM 上。
 *
 * 生效值会记进 diagnostics.log 的 `[heap]` 行（渲染进程的
 * `performance.memory.jsHeapSizeLimit`）—— 那是唯一能直接读出这个上限的地方。
 */
const totalMemoryMB = Math.floor(os.totalmem() / (1024 * 1024));
const RENDERER_HEAP_LIMIT_MB = Math.min(4096, Math.max(2048, Math.floor(totalMemoryMB * 0.4)));
app.commandLine.appendSwitch('js-flags', `--max-old-space-size=${RENDERER_HEAP_LIMIT_MB}`);

// 用户关闭后台节流时，光靠 webContents.setBackgroundThrottling(false) 只能解除
// "窗口不可见" 这一种节流；Chromium 还会在窗口被遮挡时降低该 renderer 的优先级、
// 停掉它的绘制，并把后台定时器统一降频。这几个开关只能在启动时通过命令行传入，
// 因此这里按设置预置（设置里改完需要重启才彻底生效）。
// 默认不打开，避免最小化时白耗 CPU。
if (!settings.backgroundThrottling) {
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');

  // 上面两个管的是"进程被降级"和"定时器被降频"，但 Chromium 还会单独在窗口
  // 被遮挡时把它的绘制优先级压下去。这里一并关掉，保证关掉后台节流的用户拿到
  // 的是完整的效果（三件套缺一个都还能被观察到卡顿）。
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
}

/**
 * 需要主进程介入的 https 目标。
 *
 * 这些是 AbstractWindow.onBeforeRequest 会重定向的来源：前五个换成对应的扩展库
 * 协议，后三个（Scratch 素材 CDN）在命中本地素材库时换成 tw-library://。
 *
 * ⚠️ **必须与 `src-main/windows/editor.js` 与 `src-main/windows/project-running-window.js`
 * 里的 `parsed.origin === ...` 分支保持一致**：新增一个重定向目标时，这里也要加，
 * 否则那个重定向会因为 filter 不匹配而静默失效。核对用技能
 * `scratch-perf-verify` 里的 `check-webrequest-filter.cjs`（交叉比对两处，不需要编译）。
 * @type {string[]}
 */
const INTERCEPTED_URL_PATTERNS = [
  // 扩展库
  'https://extensions.turbowarp.org/*',
  'https://extensions.bilup.org/*',
  'https://editors.astras.top/*',
  'https://extensions.mistium.com/*',
  'https://sharkpools-extensions.vercel.app/*',
  // 素材库：命中本地缓存的会重定向到 tw-library://
  'https://cdn.assets.scratch.mit.edu/*',
  'https://assets.scratch.mit.edu/*',
  'https://assets.r2.bilup.org/*'
];

/**
 * 需要改写请求头/响应头的那部分：只有 http(s)。
 *
 * `onBeforeSendHeaders` 给 http(s) 请求补 referer，`onHeadersReceived` 在
 * `settings.bypassCORS` 打开时改 http(s) 响应的 CORS/CSP 头。两者对其它协议都只
 * 走 `callback({})`，所以把 scope 限制在 http(s) 不改变任何行为。
 * @type {string[]}
 */
const WEB_URL_PATTERNS = ['http://*/*', 'https://*/*'];

app.on('session-created', (session) => {
  // Permission requests are delegated to AbstractWindow

  session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (!details.isMainFrame) {
      return false;
    }
    const window = AbstractWindow.getWindowByWebContents(webContents);
    if (!window) {
      return false;
    }
    const allowed = window.handlePermissionCheck(permission, details);
    return allowed;
  });

  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (!details.isMainFrame) {
      callback(false);
      return;
    }
    const window = AbstractWindow.getWindowByWebContents(webContents);
    if (!window) {
      callback(false);
      return;
    }
    window.handlePermissionRequest(permission, details).then((allowed) => {
      callback(allowed);
    });
  });

  // 三个 webRequest 拦截器原本都没有 filter，等于这个 session 里的**每一个**请求都要
  // 跨进程到主进程走一趟 JS —— 包括编辑器自己的 tw-editor:// 资源，以及打开项目时的
  // 每一个素材请求（tw-library:// 等）。而那些 handler 对自定义协议只会
  // callback({}) 直通（见 project-running-window.js 里的 WEB_PROTOCOLS 判断），
  // 这一趟纯属开销：打开一个项目会发出上千个素材请求（真实作品 1552 个），
  // 每个请求都要乘三个拦截器。
  //
  // 自定义 scheme 写不进 filter（Chromium 报 "Wrong scheme type"），所以反过来做：
  // 把 filter 收窄成"确实需要处理的那部分"，自定义协议自然被排除。
  //
  // 为什么可以不再拦 cspReport / ping（onBeforeRequest 原本无条件 cancel 它们）：
  // 编辑器协议的 CSP 头由 getBaseProtocolHeaders() 拼装，里面没有
  // report-uri / report-to，浏览器不会产生 CSP 违规报告；编辑器也不用 <a ping>。
  // handler 里那段判断保留着，万一以后 filter 放宽仍然生效。
  session.webRequest.onBeforeRequest({
    urls: INTERCEPTED_URL_PATTERNS
  }, (details, callback) => {
    const url = details.url.toLowerCase();
    // Always allow devtools
    if (url.startsWith('devtools:')) {
      return callback({});
    }

    const webContents = details.webContents;
    const window = AbstractWindow.getWindowByWebContents(webContents);
    if (!webContents || !window) {
      // Background requests for things like loading service workers in iframes
      // are not associated with a specific webcontents, so we'll just have to
      // allow these to avoid breakage.
      return callback({});
    }

    window.onBeforeRequest(details, callback);
  });

  // 补 referer 这件事只对 http(s) 做（handler 内部就是这么判断的），filter 同样限制在 http(s)。
  session.webRequest.onBeforeSendHeaders({
    urls: WEB_URL_PATTERNS
  }, (details, callback) => {
    const url = details.url.toLowerCase();
    if (url.startsWith('devtools:')) {
      return callback({});
    }

    const webContents = details.webContents;
    const window = AbstractWindow.getWindowByWebContents(webContents);
    if (!webContents || !window) {
      return callback({});
    }

    window.onBeforeSendHeaders(details, callback);
  });

  // 同上：只有 http(s) 响应会被改写 CORS / CSP 头。
  session.webRequest.onHeadersReceived({
    urls: WEB_URL_PATTERNS
  }, (details, callback) => {
    const window = AbstractWindow.getWindowByWebContents(details.webContents);
    if (!window) {
      return callback({});
    }
    window.onHeadersReceived(details, callback);
  });

  session.on('will-download', (event, item, webContents) => {
    const options = {
      // The default filename is a better title than "blob:..."
      title: item.getFilename()
    };

    // Ensure that the type selector shows proper names on Windows instead of things like "SPRITE3 File"
    const extension = path.extname(item.getFilename()).replace(/^\./, '').toLowerCase();
    const translated = tranlateOrNull(`files.${extension}`);
    if (translated !== null) {
      options.filters = [
        {
          name: translated,
          extensions: [extension]
        }
      ];
    }

    item.setSaveDialogOptions(options);
  });
});

app.on('web-contents-created', (event, webContents) => {
  // For safety reasons, we add these listeners here so that they apply to any web contents,
  // even ones that somehow got created without an associated one of our AbstractWindows
  // also being created.

  webContents.on('will-navigate', (event, url) => {
    const window = AbstractWindow.getWindowByWebContents(webContents);
    if (window) {
      window.handleWillNavigate(event, url);
    } else {
      // Unknown web contents; give minimal possible permissions.
      event.preventDefault();
    }
  });

  webContents.setWindowOpenHandler((details) => {
    const window = AbstractWindow.getWindowByWebContents(webContents);
    if (window) {
      return window.handleWindowOpen(details);
    }
    // Unknown web contents; give minimal possible permissions.
    return {
      action: 'deny'
    };
  });

  // We don't use Electron's webview, so disable it entirely as an extra layer of security.
  webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
});

app.on('window-all-closed', () => {
  if (!isMigrating) {
    app.quit();
  }
});

// macOS
app.on('activate', () => {
  if (app.isReady() && !isMigrating && AbstractWindow.getWindowsByClass(EditorWindow).length === 0) {
    EditorWindow.newWindow();
  }
});

// macOS
const filesQueuedToOpen = [];
app.on('open-file', (event, path) => {
  event.preventDefault();
  // This event can be called before ready.
  if (app.isReady() && !isMigrating) {
    // The path we get should already be absolute
    EditorWindow.openFiles([path], '');
  } else {
    filesQueuedToOpen.push(path);
  }
});

/**
 * @param {string[]} argv
 * @returns {{files: string[]; fullscreen: boolean;}}
 */
const parseCommandLine = (argv) => {
  // argv could be any of:
  // bilup.exe project.sb3
  // electron.exe --inspect=sdf main.js project.sb3
  // electron.exe main.js project.sb3

  const files = argv
    // Remove --inspect= and other flags
    .filter((i) => !i.startsWith('--'))
    // Ignore macOS process serial number argument eg. "-psn_0_98328"
    // https://github.com/TurboWarp/desktop/issues/939
    .filter((i) => !i.startsWith('-psn_'))
    // Remove turbowarp.exe, electron.exe, etc. and the path to the app if it exists
    // defaultApp is true when the path to the app is in argv
    .slice(process.defaultApp ? 2 : 1);

  const fullscreen = argv.includes('--fullscreen');

  return {
    files,
    fullscreen
  };
};

let isMigrating = true;
let migratePromise = null;

app.on('second-instance', (event, argv, workingDirectory) => {
  migratePromise.then(() => {
    const commandLineOptions = parseCommandLine(argv);
    EditorWindow.openFiles(commandLineOptions.files, commandLineOptions.fullscreen, workingDirectory);
  });
});

app.whenReady().then(() => {
  diagnostics.bootMark('app ready');

  AbstractWindow.settingsChanged();

  // 预热编辑器资源。
  //
  // 自定义协议不经过 Chromium 的 HTTP 缓存，编辑器 HTML 与入口包每次启动都要由
  // 主进程重新从 asar 读一遍，而且正好落在"窗口已出现、用户在看转圈"的那一刻。
  // 提前发起读盘，让它和下面的 migrate()、窗口构造天然重叠，首屏那次请求就只剩
  // 一次内存命中。见 protocols.js 的 prewarmEditorAssets。
  //
  // 放在最前面是有意的：越早发起，能重叠进去的部分越多；它自己是异步且静默失败的，
  // 不会阻塞任何后续步骤。
  protocols.prewarmEditorAssets();

  // 记下这次运行的版本、硬件与 GPU 特性状态，然后不阻塞启动继续往下走。
  // 崩溃日志里"当时机器还剩多少内存"和"WebGL 有没有被降级到软件渲染"是判断
  // 崩溃原因最关键的两个数字，而它们事后都补不回来。
  diagnostics.recordEnvironment().catch((error) => {
    console.error('Could not record diagnostics:', error);
  });

  migratePromise = migrate().then((shouldContinue) => {
    if (!shouldContinue) {
      // If we use exit() instead of quit() then openExternal() calls made before the app quits
      // won't work on Windows.
      app.quit();
      return;
    }

    isMigrating = false;

    const commandLineOptions = parseCommandLine(process.argv);
    EditorWindow.openFiles([
      ...filesQueuedToOpen,
      ...commandLineOptions.files
    ], commandLineOptions.fullscreen, process.cwd());
    diagnostics.bootMark('first window created');

    if (AbstractWindow.getAllWindows().length === 0) {
      // No windows were successfully opened. Let's just quit.
      app.quit();
    }

    checkForUpdates()
      .catch((error) => {
        // We don't want to show a full error message when updates couldn't be fetched.
        // The website might be down, the internet might be broken, might be a school
        // network that blocks turbowarp.org, etc.
        console.error('Error checking for updates:', error);
      });
  });
});
