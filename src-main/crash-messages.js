const {app, dialog, BrowserWindow} = require('electron');
const {translate} = require('./l10n');
const {APP_NAME} = require('./brand');
const AbstractWindow = require('./windows/abstract');
const diagnostics = require('./diagnostics');
const {clearMemoryCache} = require('./protocols');

/**
 * 内存不足导致进程被终止之后，主动把主进程能立刻腾出的内存腾出来。
 *
 * 重建渲染进程需要一大块连续内存，而这时候系统本来就紧。主进程的协议缓存是眼下
 * 唯一能马上让出来的量（LRU 上限的几十到上百 MB），丢掉它只意味着下次请求重新
 * 读盘解压 —— 用这个换渲染进程能顺利起来是划算的。
 * @param {string} reason
 */
const releaseMemoryAfterOom = (reason) => {
  if (reason !== 'oom') {
    return;
  }
  clearMemoryCache();
  diagnostics.log('Out of memory: released the main process protocol cache');
};

/**
 * 同一个进程反复崩溃时不要反复弹框。
 *
 * GPU 进程崩溃是可以自愈的：Chromium 会重建它，重建后如果再崩就再崩一次。如果
 * 每一次都弹一个模态框，用户会陷入"点掉一个又冒出一个"的循环，什么都做不了，
 * 而他要的信息（崩了、为什么）看一次就够了。事件本身照常全部写进诊断日志，
 * 所以抑制提示不会丢证据。
 * @const {number}
 */
const MESSAGE_COOLDOWN_MS = 60 * 1000;

/** @type {Map<string, number>} */
const lastMessageTimes = new Map();

/**
 * @param {string} key
 * @returns {boolean} Whether a message should be shown for this key right now.
 */
const shouldShowMessage = (key) => {
  const now = Date.now();
  const last = lastMessageTimes.get(key);
  if (typeof last === 'number' && now - last < MESSAGE_COOLDOWN_MS) {
    return false;
  }
  lastMessageTimes.set(key, now);
  return true;
};

const showCrashMessage = (window, type, code, reason) => {
  // non-technical users won't know what "OOM" means but may be able to understand
  // what "out of memory" means
  if (reason === 'oom') {
    reason = 'out of memory';
  }

  dialog.showMessageBoxSync(window, {
    title: APP_NAME,
    type: 'error',
    message: translate('crash.title'),
    detail: translate('crash.description')
      .replace('{type}', type)
      .replace('{code}', code)
      .replace('{reason}', reason),
    noLink: true
  });
};

/**
 * 窗口崩溃后已经就地重载回来时给用户的说明。
 *
 * 不能什么都不说：用户只会看到界面闪一下、项目重新加载，很容易以为一切正常，
 * 而重载后项目回到的是**上次保存的状态** —— 崩溃时内存里那些没保存的改动已经
 * 丢了。用户有权知道自己应该检查什么。
 *
 * 用非阻塞的对话框，不挡住正在进行的重载。
 * @param {Electron.BrowserWindow|null} window
 * @param {Electron.RenderProcessGoneDetails} details
 */
const showRecoveredMessage = (window, details) => {
  const reason = details.reason === 'oom' ? 'out of memory' : details.reason;
  dialog.showMessageBox(window, {
    title: APP_NAME,
    type: 'warning',
    message: translate('crash.recovered.title'),
    detail: translate('crash.recovered.description')
      .replace('{reason}', reason),
    noLink: true
  });
};

/**
 * @param {Electron.WebContents} webContents
 * @returns {string} The page that was loaded, or an empty string.
 */
const getUrlSafely = (webContents) => {
  if (!webContents || webContents.isDestroyed()) {
    return '';
  }
  try {
    return webContents.getURL();
  } catch (error) {
    return '';
  }
};

app.on('render-process-gone', (event, webContents, details) => {
  diagnostics.recordCrash(
    'Renderer',
    details.reason,
    details.exitCode,
    getUrlSafely(webContents),
    webContents && !webContents.isDestroyed() ? webContents.id : null
  );
  releaseMemoryAfterOom(details.reason);

  const abstractWindow = AbstractWindow.getWindowByWebContents(webContents);
  const handled = (
    abstractWindow &&
    abstractWindow.handleRendererProcessGone(details)
  );

  const browserWindow = BrowserWindow.fromWebContents(webContents);

  if (handled) {
    // 窗口已经把自己重新加载回来了，所以这里说的是"发生了什么"，而不是"崩了"。
    showRecoveredMessage(browserWindow, details);
  } else if (shouldShowMessage(`Renderer:${details.reason}`)) {
    showCrashMessage(browserWindow, 'Renderer', details.exitCode, details.reason);
  }
});

app.on('child-process-gone', (event, details) => {
  diagnostics.recordCrash(details.type, details.reason, details.exitCode);
  releaseMemoryAfterOom(details.reason);

  if (shouldShowMessage(`${details.type}:${details.reason}`)) {
    showCrashMessage(null, details.type, details.exitCode, details.reason);
  }
});
