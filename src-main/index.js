const {app} = require('electron');

// requestSingleInstanceLock() crashes the app in signed MAS builds
// https://github.com/electron/electron/issues/15958
if (!process.mas && !app.requestSingleInstanceLock()) {
  app.exit();
}

const path = require('path');
const AbstractWindow = require('./windows/abstract');
const EditorWindow = require('./windows/editor');
const {checkForUpdates} = require('./update-checker');
const {tranlateOrNull} = require('./l10n');
const migrate = require('./migrate');
const settings = require('./settings');
require('./protocols');
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

  session.webRequest.onBeforeRequest((details, callback) => {
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

  session.webRequest.onBeforeSendHeaders((details, callback) => {
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

  session.webRequest.onHeadersReceived((details, callback) => {
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
  AbstractWindow.settingsChanged();

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
