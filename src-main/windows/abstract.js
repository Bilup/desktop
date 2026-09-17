const { BrowserWindow, screen, session } = require('electron');
const path = require('path');
const openExternal = require('../open-external');
const settings = require('../settings');
const diagnostics = require('../diagnostics');

/**
 * 页面加载完成后，等这么久再采样渲染进程的堆状况 —— 要等 React 挂载、默认项目
 * 加载完，读到的才是稳态值而不是启动瞬间的谷底。
 * @const {number}
 */
const RENDERER_HEAP_SAMPLE_DELAY_MS = 15000;

/** @type {Map<unknown, AbstractWindow[]>} */
const windowsByClass = new Map();

/**
 * 统计自动重载次数的时间窗口。
 * @const {number}
 */
const RENDERER_CRASH_WINDOW_MS = 60 * 1000;

/**
 * 一个统计窗口内允许的自动重载次数，超过就不再自动重载。
 *
 * 反复崩溃的原因几乎总是必然复现的：项目里某段数据稳定压垮渲染进程、显卡驱动
 * 在特定绘制上失败。这种情况下继续自动重载只会变成"崩溃→重载→崩溃"的死循环，
 * 把 CPU 占满，反而让用户连手动处理的机会都没有。
 * @const {number}
 */
const MAX_AUTO_RELOADS = 2;

/**
 * @typedef AbstractWindowOptions
 * @property {Electron.BrowserWindow} [existingWindow]
 * @property {Electron.BrowserWindow} [parentWindow]
 */

class AbstractWindow {
  /** @param {AbstractWindowOptions} options */
  constructor (options = {}) {
    this.parentWindow = options.parentWindow || null;

    /** @type {Electron.BrowserWindow} */
    this.window = options.existingWindow || new BrowserWindow(this.getWindowOptions());
    this.window.webContents.on('before-input-event', this.handleInput.bind(this));
    this.applySettings();

    // 页面加载完延迟采一次渲染进程的 V8 堆状况。`performance.memory` 只在渲染进程里
    // 有，而它是唯一能直接读出「渲染进程被允许用多少 JS 堆」的地方 —— 用来验证
    // --js-flags 有没有生效（见 index.js 的 RENDERER_HEAP_LIMIT_MB），也作为崩溃
    // 记录的基线。窗口已销毁时 recordRendererHeap 会直接返回。
    this.window.webContents.on('did-finish-load', () => {
      setTimeout(() => {
        diagnostics.recordRendererHeap(this.window.webContents);
      }, RENDERER_HEAP_SAMPLE_DELAY_MS);
    });

    if (!options.existingWindow) {
      // getCursorScreenPoint() segfaults on Linux in Wayland if called before a BrowserWindow is created, so
      // we can't compute this in getWindowOptions().
      // https://github.com/electron/electron/issues/35471
      let bounds;
      if (this.parentWindow) {
        options.parent = this.parentWindow;
        bounds = AbstractWindow.calculateWindowBounds(this.parentWindow.getBounds(), this.getDimensions());
      } else {
        // Electron's default window placement handles multimonitor setups extremely poorly on Linux
        // This also makes the window open on whatever monitor the mouse is on, which is probably what the user wants
        const activeScreen = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        bounds = AbstractWindow.calculateWindowBounds(activeScreen.workArea, this.getDimensions());
      }
      this.window.setBounds(bounds);
    }

    /**
     * ipcMain object scoped to the window's main frame only.
     */
    this.ipc = this.window.webContents.mainFrame.ipc;

    this.initialURL = null;
    this.protocol = null;

    /**
     * 最近几次渲染进程崩溃的时间戳，用于节制自动重载（见
     * handleRendererProcessGoneWithReload）。
     * @type {number[]}
     */
    this._rendererCrashTimes = [];

    const cls = this.constructor;
    if (!windowsByClass.has(cls)) {
      windowsByClass.set(cls, []);
    }
    windowsByClass.get(cls).push(this);
    this.window.on('closed', () => {
      const windows = windowsByClass.get(cls);
      const idx = windows.indexOf(this);
      if (idx !== -1) {
        windows.splice(idx, 1);
      }
    });
  }

  static getAllWindows () {
    const allWindows = [];
    for (const windows of windowsByClass.values()) {
      for (const window of windows) {
        allWindows.push(window);
      }
    }
    return allWindows;
  }

  static settingsChanged () {
    session.defaultSession.setSpellCheckerEnabled(settings.spellchecker);

    for (const window of AbstractWindow.getAllWindows()) {
      window.applySettings();
    }
  }

  static getWindowByBrowserWindow (browserWindow) {
    for (const windows of windowsByClass.values()) {
      for (const window of windows) {
        if (window.window === browserWindow) {
          return window;
        }
      }
    }
    return null;
  }

  static getWindowByWebContents (webContents) {
    for (const windows of windowsByClass.values()) {
      for (const window of windows) {
        if (window.window.webContents === webContents) {
          return window;
        }
      }
    }
    return null;
  }

  /**
   * @template T
   * @param {{new(): T}} cls 
   * @returns {T[]}
   */
  static getWindowsByClass (cls) {
    return windowsByClass.get(cls) || [];
  }

  /**
   * @template T
   * @param {{new(): T}} cls
   * @returns {T}
   */
  static singleton (cls) {
    const windows = AbstractWindow.getWindowsByClass(cls);
    if (windows.length) {
      return windows[0];
    }
    return new cls();
  }

  /**
   * @param {Electron.Rectangle} area
   * @param {{width: number; height: number;}} preferredDimensions
   * @returns {Electron.Rectangle}
   */
  static calculateWindowBounds (area, preferredDimensions) {
    const width = Math.min(area.width, preferredDimensions.width);
    const height = Math.min(area.height, preferredDimensions.height);
    const x = area.x + ((area.width - width) / 2);
    const y = area.y + ((area.height - height) / 2);
    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height)
    };
  }

  getPreload () {
    // to be overridden
  }

  getDimensions () {
    // to be overridden
    return {
      width: 200,
      height: 200
    };
  }

  isPopup () {
    // to be overridden
    return false;
  }

  getBackgroundColor () {
    // to be overridden
    return '#ffffff';
  }

  getWindowOptions () {
    /** @type {Electron.BrowserWindowConstructorOptions} */
    const options = {};

    options.useContentSize = true;
    options.minWidth = 200;
    options.minHeight = 200;

    // Child classes are expected to show the window on their own
    options.show = false;

    // These should all be redundant already, but defense-in-depth.
    options.webPreferences = {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // 必须在创建窗口时就下发，不能只靠运行时调用
      // webContents.setBackgroundThrottling()：
      // 按 Electron 文档，webPreferences.backgroundThrottling 才会同时影响
      // Page Visibility API；运行时改这个值只会改变动画/定时器节流。
      // 用户把"后台节流"关掉时，希望的是窗口就算被挡住/切到后台也照常按
      // 正常帧率跑（例如挂机跑项目），只设置一半是达不到效果的。
      backgroundThrottling: settings.backgroundThrottling
    };

    const preloadName = this.getPreload();
    if (preloadName) {
      options.webPreferences.preload = path.resolve(__dirname, '../../src-preload/', `${preloadName}.js`);
    }

    options.backgroundColor = this.getBackgroundColor();

    // On Linux the icon doesn't get baked into the executable as it does on other platforms
    if (process.platform === 'linux') {
      // This path won't work in development but it will work in production
      options.icon = path.resolve(__dirname, '../../../icon.png');
    }

    return options;
  }

  loadURL (url) {
    this.initialURL = url;
    this.protocol = new URL(url).protocol;
    return this.window.loadURL(url);
  }

  show () {
    this.window.show();
    this.window.focus();
  }

  /**
   * @see {Electron.WebContents.setWindowOpenHandler}
   * @param {Electron.HandlerDetails} details
   */
  handleWindowOpen (details) {
    // Open the Bilup Accounts login page in an in-app window instead of the
    // system browser so that the rotur-sdk postMessage flow can complete.
    if (new URL(details.url).origin === 'https://accounts.bilup.org') {
      const AccountsLoginWindow = require('./accounts-login');
      return AccountsLoginWindow.open(details.url);
    }
    openExternal(details.url);
    return {
      action: 'deny'
    };
  }

  /**
   * @param {Electron.Event} event
   * @param {Electron.Input} input
   */
  handleInput (event, input) {
    if (input.isAutoRepeat || input.isComposing || input.type !== 'keyDown' || input.meta) {
      return;
    }

    // Escape to exit fullscreen or close popup windows
    if (input.key === 'Escape') {
      if (settings.exitFullscreenOnEscape && this.window.isFullScreen() && this.canExitFullscreenByPressingEscape()) {
        event.preventDefault();
        this.window.setFullScreen(false);
      } else if (this.isPopup()) {
        event.preventDefault();
        this.window.close();  
      }
    }
    
    // On macOS, these shortcuts are handled by the menu bar
    if (process.platform !== 'darwin') {
      const webContents = this.window.webContents;

      // Ctrl+Shift+I to open dev tools
      if (input.control && input.shift && input.key.toLowerCase() === 'i' && !input.alt) {
        event.preventDefault();
        webContents.toggleDevTools();
      }

      // Ctrl+N to open new window
      if (input.control && input.key.toLowerCase() === 'n') {
        event.preventDefault();

        // Imported late to due circular dependencies
        const EditorWindow = require('./editor');
        EditorWindow.newWindow();
      }

      // Ctrl+Equals/Plus to zoom in (depends on keyboard layout)
      if (input.control && (input.key === '=' || input.key === '+')) {
        event.preventDefault();
        webContents.setZoomLevel(webContents.getZoomLevel() + 1);
      }

      // Ctrl+Minus/Underscore to zoom out
      if (input.control && input.key === '-') {
        event.preventDefault();
        webContents.setZoomLevel(webContents.getZoomLevel() - 1);
      }

      // Ctrl+0 to reset zoom
      if (input.control && input.key === '0') {
        event.preventDefault();
        webContents.setZoomLevel(0);
      }

      // F11 and alt+enter to toggle fullscreen
      if (input.key === 'F11' || (input.key === 'Enter' && input.alt)) {
        // Don't do preventDefault() for alt+enter as then the renderer won't receive the
        // event that the alt key was unpressed, which causes the costume editor to get
        // stuck in duplicating mode.
        if (input.key === 'F11') {
          event.preventDefault();
        }
        this.window.setFullScreen(!this.window.isFullScreen());
      }

      // Ctrl+R to reload
      if (input.control && input.key.toLowerCase() === 'r') {
        event.preventDefault();
        this.reload();
      }
    }
  }

  /**
   * @param {Electron.WillNavigateEvent} event 
   * @param {string} url
   */
  handleWillNavigate (event, url) {
    // Only allow windows to refresh, not navigate anywhere.
    if (url !== this.initialURL) {
      event.preventDefault();
      openExternal(url);
    }
  }

  reload () {
    // Don't use webContents.reload() because it allows the page to navigate by using
    // history.pushState() then location.reload()
    if (this.initialURL !== null) {
      this.window.webContents.loadURL(this.initialURL);
    }
  }

  /**
   * @see {Electron.Session.setPermissionCheckHandler}
   * @param {string} permisson
   * @param {Electron.PermissionCheckHandlerHandlerDetails} details
   * @returns {boolean}
   */
  handlePermissionCheck (permisson, details) {
    // to be overridden
    return permisson === 'accessibility-events';
  }

  /**
   * @see {Electron.Session.setPermissionRequestHandler}
   * @param {string} permisson
   * @param {Electron.PermissionRequestHandlerHandlerDetails} details
   * @returns {Promise<boolean>}
   */
  async handlePermissionRequest (permisson, details) {
    // to be overridden
    return false;
  }

  /**
   * @param {Electron.OnBeforeRequestListenerDetails} details
   * @param {(response: Electron.CallbackResponse) => void} callback
   */
  onBeforeRequest (details, callback) {
    // to be overridden
    callback({});
  }

  /**
   * @param {Electron.OnBeforeSendHeadersListenerDetails} details
   * @param {(response: Electron.BeforeSendResponse) => void} callback 
   */
  onBeforeSendHeaders (details, callback) {
    // to be overridden
    callback({});
  }

  /**
   * @param {Electron.OnHeadersReceivedListenerDetails} details
   * @param {(response: Electron.HeadersReceivedResponse) => void} callback
   */
  onHeadersReceived (details, callback) {
    // to be overridden
    callback({});
  }

  /**
   * @param {Electron.RenderProcessGoneDetails} details
   * @returns {boolean} Return true to cancel default warning message.
   */
  handleRendererProcessGone (details) {
    // to be overridden
    return false;
  }

  /**
   * 渲染进程崩溃后的通用恢复：把窗口重新加载回它原本的 URL，并返回 true 表示
   * 不需要再弹默认提示框。
   *
   * 崩溃之后这个窗口的 webContents 已经作废 —— 窗口还留在屏幕上，但再也不会
   * 刷新、也不响应任何操作，用户唯一的出路是关掉重开；而"关掉重开"一样会丢掉
   * 未保存的内容，还要重新打开一次文件。就地重载至少把编辑器还回去。
   *
   * 短时间内反复崩溃时放弃自动重载并返回 false，交回默认提示框让用户自己决定
   * （理由见 MAX_AUTO_RELOADS）。无论走哪条路，崩溃本身都已经记进诊断日志。
   *
   * @param {Electron.RenderProcessGoneDetails} details
   * @returns {boolean} true 表示已接管恢复，不再显示默认提示框。
   */
  handleRendererProcessGoneWithReload (details) {
    if (this.initialURL === null) {
      return false;
    }

    const now = Date.now();
    const recent = this._rendererCrashTimes.filter(
      (time) => now - time < RENDERER_CRASH_WINDOW_MS
    );
    recent.push(now);
    this._rendererCrashTimes = recent;

    if (recent.length > MAX_AUTO_RELOADS) {
      return false;
    }

    // 事件是在 webContents 已经被判定为 gone 之后发出的。等一轮事件循环再发起
    // 导航，避免和 Chromium 重建 webContents 的过程撞在一起。
    setImmediate(() => {
      if (this.window && !this.window.isDestroyed()) {
        this.reload();
      }
    });

    return true;
  }

  applySettings () {
    // to be overrridden
  }

  /**
   * Whether or not this window allows leaving OS-level fullscreen by pressing escape.
   * You do not need to check `settings` here. The caller will do that for you.
   * @returns {boolean}
   */
  canExitFullscreenByPressingEscape () {
    return true;
  }
}

module.exports = AbstractWindow;
