const fsPromises = require('fs/promises');
const path = require('path');
const nodeURL = require('url');
const nodeCrypto = require('crypto');
const {app, dialog, shell, net} = require('electron');
const ProjectRunningWindow = require('./project-running-window');
const PackagerWindow = require('./packager');
const SettingsWindow = require('./settings');
const {createAtomicWriteStream, writeFileAtomic} = require('../atomic-write-stream');
const {decompress: brotliDecompress} = require('../brotli');
const {translate, updateLocale, getStrings} = require('../l10n');
const {APP_NAME} = require('../brand');
const prompts = require('../prompts');
const settings = require('../settings');
const privilegedFetch = require('../fetch');
const FileAccessWindow = require('./file-access-window.js');
const ExtensionDocumentationWindow = require('./extension-documentation.js');
const AbstractWindow = require('./abstract');
const {isUpdateCheckerAllowed} = require('../update-checker');
const {getDist, getPlatform} = require('../platform');
const diagnostics = require('../diagnostics');
const packageJSON = require('../../package.json');

const TYPE_FILE = 'file';
const TYPE_URL = 'url';
const TYPE_SCRATCH = 'scratch';
const TYPE_SAMPLE = 'sample';

/**
 * 交付项目数据之后等这么久，再采一次渲染进程的堆状况。
 *
 * 打开项目是渲染进程内存涨得最猛的一次 —— 解压出的素材、解析出的对象图、按需建立的
 * 皮肤纹理都在这一步翻上去。在这个时刻采样，崩溃记录里"崩之前最后一次看到的用量"
 * 才有意义，而不是默认空项目的数字。20 秒覆盖常见的项目规模；超大项目会有偏差，
 * 但重新打开一次会再采一次。
 * @const {number}
 */
const PROJECT_LOADED_HEAP_SAMPLE_DELAY_MS = 20000;

/**
 * 示例项目默认所在的打包目录（TurboWarp 扩展库的示例）。
 *
 * 每个扩展库的示例项目各打包在自己的 dist-* 目录里（见 scripts/prepare-*.mjs 与
 * @bilup/extensions 的 builder），所以 TYPE_SAMPLE 必须跟着示例来源一起带上目录名：
 * 曾经这里写死成 dist-extensions，导致 Bilup 扩展卡上的"示例项目"去 TurboWarp 的
 * 目录里找同名文件，找不到就直接报打开失败。
 * @const {string}
 */
const DEFAULT_SAMPLE_DIRECTORY = 'dist-extensions';

class OpenedFile {
  /**
   * @param {string} type
   * @param {string} path 绝对文件路径或 URL
   * @param {string} [sampleDirectory] 仅 TYPE_SAMPLE 使用：示例所在的 dist-* 目录名
   */
  constructor (type, path, sampleDirectory = DEFAULT_SAMPLE_DIRECTORY) {
    /** @type {TYPE_FILE|TYPE_URL|TYPE_SCRATCH|TYPE_SAMPLE} */
    this.type = type;

    /**
     * Absolute file path or URL
     * @type {string}
     */
    this.path = path;

    /**
     * 仅 TYPE_SAMPLE 使用：示例项目所在的打包目录（相对仓库根目录）。
     * @type {string}
     */
    this.sampleDirectory = sampleDirectory;
  }

  async read () {
    if (this.type === TYPE_FILE) {
      return {
        name: path.basename(this.path),
        data: await fsPromises.readFile(this.path)
      };
    }

    if (this.type === TYPE_URL) {
      const buffer = await privilegedFetch(this.path);
      return {
        name: decodeURIComponent(path.basename(this.path)),
        data: buffer
      };
    }

    if (this.type === TYPE_SCRATCH) {
      const metadata = await privilegedFetch.json(`https://api.scratch.mit.edu/projects/${this.path}`);
      const token = metadata.project_token;
      const title = metadata.title;

      const projectBuffer = await privilegedFetch(`https://projects.scratch.mit.edu/${this.path}?token=${token}`);
      return {
        name: title,
        data: projectBuffer
      };
    }

    if (this.type === TYPE_SAMPLE) {
      const sampleRoot = path.resolve(__dirname, '../../', this.sampleDirectory, 'samples/');
      const resolvedPath = path.join(sampleRoot, this.path);
      if (resolvedPath.startsWith(sampleRoot)) {
        const compressedPath = `${resolvedPath}.br`;
        const compressedData = await fsPromises.readFile(compressedPath);

        // dist-extensions is all brotli'd; must decompress
        const decompressedData = await brotliDecompress(compressedData);

        return {
          name: this.path,
          data: decompressedData
        };
      }
      throw new Error('Unsafe join');
    }

    throw new Error(`Unknown type: ${this.type}`);
  }
}

/**
 * @param {string} file
 * @param {string|null} workingDirectory
 * @returns {OpenedFile}
 */
const parseOpenedFile = (file, workingDirectory) => {
  let url;
  try {
    url = new URL(file);
  } catch (e) {
    // Error means it was not a valid full URL
  }

  if (url) {
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      // Scratch URLs require special treatment as they are not direct downloads.
      const scratchMatch = file.match(/^https?:\/\/scratch\.mit\.edu\/projects\/(\d+)\/?/);
      if (scratchMatch) {
        return new OpenedFile(TYPE_SCRATCH, scratchMatch[1]);
      }

      // Need to manually redirect extension samples to the copies we already have offline as the
      // fetching code will not go through web request handlers or custom protocols.
      // 目录名要跟着来源走：TurboWarp 的示例在 dist-extensions，Bilup 的在 dist-bilup-extensions。
      const sampleMatch = file.match(/^https?:\/\/extensions\.turbowarp\.org\/samples\/(.+\.sb3)$/);
      if (sampleMatch) {
        return new OpenedFile(TYPE_SAMPLE, decodeURIComponent(sampleMatch[1]), 'dist-extensions');
      }

      const bilupSampleMatch = file.match(/^https?:\/\/extensions\.bilup\.org\/samples\/(.+\.sb3)$/);
      if (bilupSampleMatch) {
        return new OpenedFile(TYPE_SAMPLE, decodeURIComponent(bilupSampleMatch[1]), 'dist-bilup-extensions');
      }

      return new OpenedFile(TYPE_URL, file);
    }

    // Parse file:// URLs.
    // Notably we receive these in the flatpak version of the app when we can only access a file through
    // the XDG document portal instead of having direct access with eg. --filesystem=home
    if (url.protocol === 'file:') {
      let filePath;
      try {
        filePath = nodeURL.fileURLToPath(file);
      } catch (e) {
        // Very unlikely but possible
      }

      if (filePath) {
        return new OpenedFile(TYPE_FILE, path.resolve(workingDirectory, filePath));
      }
    }

    // Don't throw an error just because we don't recognize the URL protocol as
    // Windows paths look close enough to real URLs to be parsed successfully.
  }

  return new OpenedFile(TYPE_FILE, path.resolve(workingDirectory, file));
};

/**
 * @returns {Array<{path: string; app: string;}>}
 */
const getUnsafePaths = () => {
  if (process.platform !== 'win32') {
    // This problem doesn't really exist on other platforms
    return [];
  }

  const localPrograms = path.join(app.getPath('home'), 'AppData', 'Local', 'Programs');
  const appData = app.getPath('appData');
  return [
    // Current app, regardless of where it is installed or how modded it is
    {
      path: path.dirname(app.getPath('exe')),
      app: APP_NAME,
    },
    {
      path: app.getPath('userData'),
      app: APP_NAME,
    },

    // Bilup Desktop defaults
    {
      path: path.join(appData, 'bilup-desktop'),
      app: 'Bilup Desktop'
    },
    {
      path: path.join(localPrograms, 'Bilup'),
      app: 'Bilup Desktop'
    },

    // Scratch Desktop defaults
    {
      path: path.join(appData, 'Scratch'),
      app: 'Scratch Desktop'
    },
    {
      path: path.join(localPrograms, 'Scratch 3'),
      app: 'Scratch Desktop'
    }
  ];
};

/**
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
const isChildPath = (parent, child) => {
  const relative = path.relative(parent, child);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
};

/**
 * @returns {string} A unique string.
 */
const generateFileId = () => {
  // Note that we can't use the randomUUID from web crypto as we need to support Electron 22.
  return `desktop_file_id{${nodeCrypto.randomUUID()}}`;
};

class EditorWindow extends ProjectRunningWindow {
  /**
   * @param {OpenedFile|null} initialFile
   * @param {boolean} isInitiallyFullscreen
   */
  constructor (initialFile, isInitiallyFullscreen) {
    super();

    /**
     * Ideally we would revoke access after loading a new project, but our file handle handling in
     * the GUI isn't robust enough for that yet. We do at least use random file handle IDs which
     * makes it much harder for malicious code in the renderer process to enumerate all previously
     * opened IDs and overwrite them.
     * @type {Map<string, OpenedFile>}
     */
    this.openedFiles = new Map();
    this.activeFileId = null;

    if (initialFile !== null) {
      this.activeFileId = generateFileId();
      this.openedFiles.set(this.activeFileId, initialFile);
    }

    /**
     * @param {string} id
     * @returns {OpenedFile}
     * @throws if invalid ID
     */
    const getFileById = (id) => {
      if (!this.openedFiles.has(id)) {
        throw new Error('Invalid file ID');
      }
      return this.openedFiles.get(id);
    };

    let processingWillPreventUnload = false;
    this.window.webContents.on('will-prevent-unload', () => {
      // Using showMessageBoxSync synchronously in the event handler causes broken focus on Windows.
      // See https://github.com/TurboWarp/desktop/issues/1245
      // To work around that, we won't cancel that will-prevent-unload event so the window stays
      // open. After a very short delay to let focus get fixed, we'll show a dialog and force close
      // the window ourselves if the user wants.

      // Due to the timeout, this event could theoretically fire multiple times before we show the
      // dialog. Make sure to only show one dialog if that happens.
      if (processingWillPreventUnload) {
        return;
      }
      processingWillPreventUnload = true;

      setTimeout(() => {
        const choice = dialog.showMessageBoxSync(this.window, {
          title: APP_NAME,
          type: 'info',
          buttons: [
            translate('unload.stay'),
            translate('unload.leave')
          ],
          cancelId: 0,
          defaultId: 0,
          message: translate('unload.message'),
          detail: translate('unload.detail'),
          noLink: true
        });
        if (choice === 1) {
          this.window.destroy();
        }
        processingWillPreventUnload = false;
      });
    });

    this.window.on('page-title-updated', (event, title, explicitSet) => {
      event.preventDefault();
      if (explicitSet && title) {
        this.window.setTitle(`${title} - ${APP_NAME}`);
      } else {
        this.window.setTitle(APP_NAME);
      }
    });
    this.window.setTitle(APP_NAME);

    this.ipc.on('is-initially-fullscreen', (e) => {
      e.returnValue = isInitiallyFullscreen;
    });

    this.ipc.handle('get-initial-file', () => {
      return this.activeFileId;
    });

    this.ipc.handle('get-file', async (event, id) => {
      const file = getFileById(id);
      const {name, data} = await file.read();

      // 数据已经交出去，等渲染进程把它解压、解析完再采一次堆状况（只更新内存里的值，
      // 不写盘；真正写盘发生在崩溃记录里，见 diagnostics.recordCrash）。
      // 采样延迟十几秒，用户很可能已经关掉窗口或切到别的文件了，所以必须走
      // scheduleRendererHeapSample —— 它会在回调内部先检查窗口是否已销毁。
      diagnostics.scheduleRendererHeapSample(this.window, PROJECT_LOADED_HEAP_SAMPLE_DELAY_MS);

      return {
        name,
        type: file.type,
        data
      };
    });

    this.ipc.on('set-locale', async (event, locale) => {
      if (settings.locale !== locale) {
        settings.locale = locale;
        updateLocale(locale);

        // Imported late due to circular dependency
        const rebuildMenuBar = require('../menu-bar');
        rebuildMenuBar();

        // Let the save happen in the background, not important
        Promise.resolve().then(() => settings.save());
      }
      event.returnValue = {
        strings: getStrings()
      };
    });

    this.ipc.handle('set-changed', (event, changed) => {
      this.window.setDocumentEdited(changed);
    });

    this.ipc.handle('opened-file', (event, id) => {
      const file = getFileById(id);
      if (file.type !== TYPE_FILE) {
        throw new Error('Not a file');
      }
      this.activeFileId = id;
      this.window.setRepresentedFilename(file.path);
    });

    this.ipc.handle('closed-file', () => {
      this.activeFileId = null;
      this.window.setRepresentedFilename('');
    });

    this.ipc.handle('show-open-file-picker', async () => {
      const result = await dialog.showOpenDialog(this.window, {
        properties: ['openFile'],
        defaultPath: settings.lastDirectory,
        filters: [
          {
            name: 'Scratch Project',
            extensions: ['sb3', 'sb2', 'sb'],
          }
        ]
      });
      if (result.canceled) {
        return null;
      }

      const filePath = result.filePaths[0];
      settings.lastDirectory = path.dirname(filePath);
      await settings.save();

      const id = generateFileId();
      this.openedFiles.set(id, new OpenedFile(TYPE_FILE, filePath));

      return {
        id,
        name: path.basename(filePath)
      };
    });

    this.ipc.handle('show-save-file-picker', async (event, suggestedName) => {
      const result = await dialog.showSaveDialog(this.window, {
        defaultPath: path.join(settings.lastDirectory, suggestedName),
        filters: [
          {
            name: 'Scratch 3 Project',
            extensions: ['sb3'],
          }
        ]
      });
      if (result.canceled) {
        return null;
      }

      const filePath = result.filePath;

      const unsafePath = getUnsafePaths().find(i => isChildPath(i.path, filePath));
      if (unsafePath) {
        // No need to block until the message box is closed
        dialog.showMessageBox(this.window, {
          type: 'error',
          title: APP_NAME,
          message: translate('unsafe-path.title'),
          detail: translate(`unsafe-path.details`)
            .replace('{APP_NAME}', unsafePath.app)
            .replace('{file}', filePath),
          noLink: true
        });  
        return null;
      }

      settings.lastDirectory = path.dirname(filePath);
      await settings.save();

      const id = generateFileId();
      this.openedFiles.set(id, new OpenedFile(TYPE_FILE, filePath));

      return {
        id,
        name: path.basename(filePath)
      };
    });

    this.ipc.handle('get-preferred-media-devices', () => {
      return {
        microphone: settings.microphone,
        camera: settings.camera
      };
    });

    this.ipc.on('start-write-stream', async (startEvent, id) => {
      const file = getFileById(id);
      if (file.type !== TYPE_FILE) {
        throw new Error('Not a file');
      }

      const port = startEvent.ports[0];

      /** @type {NodeJS.WritableStream|null} */
      let writeStream = null;

      const handleError = (error) => {
        console.error('Write stream error', error);
        port.postMessage({
          error
        });

        // Make sure the port is started in case we encounter an error before we normally
        // begin to accept messages.
        port.start();
      };

      try {
        writeStream = await createAtomicWriteStream(file.path);
      } catch (error) {
        handleError(error);
        return;
      }

      writeStream.on('atomic-error', handleError);

      const handleMessage = (data) => {
        if (data.write) {
          if (writeStream.write(data.write)) {
            // Still more space in the buffer. Ask for more immediately.
            return;
          }
          // Wait for the buffer to become empty before asking for more.
          return new Promise(resolve => {
            writeStream.once('drain', resolve);
          });
        } else if (data.finish) {
          // Wait for the atomic file write to complete.
          return new Promise(resolve => {
            writeStream.once('atomic-finish', resolve);
            writeStream.end();
          });
        } else if (data.abort) {
          writeStream.emit('error', new Error('Aborted by renderer process'));
          return;
        }
        throw new Error('Unknown message from renderer');
      };

      port.on('message', async (messageEvent) => {
        try {
          const data = messageEvent.data;
          const id = data.id;
          const result = await handleMessage(data);
          port.postMessage({
            response: {
              id,
              result
            }
          });
        } catch (error) {
          handleError(error);
        }
      });

      port.start();
    });

    this.ipc.on('alert', (event, message) => {
      event.returnValue = prompts.alert(this.window, message);
    });

    this.ipc.on('confirm', (event, message) => {
      event.returnValue = prompts.confirm(this.window, message);
    });

    this.ipc.handle('open-packager', () => {
      PackagerWindow.forEditor(this);
    });

    this.ipc.handle('open-new-window', () => {
      EditorWindow.newWindow();
    });

    this.window.webContents.on('will-frame-navigate', (event) => {
      if (!event.isMainFrame && /^https?:/.test(event.url)) {
        event.preventDefault();
        require('../open-external')(event.url);
      }
    });

    this.ipc.on('get-about-info', (event) => {
      event.returnValue = {
        appName: APP_NAME,
        version: packageJSON.version,
        dist: getDist(),
        electron: process.versions.electron,
        platform: getPlatform(),
        arch: process.arch
      };
    });

    this.ipc.handle('export-settings', async (event, exportedSettings) => {
      const result = await dialog.showSaveDialog(this.window, {
        defaultPath: path.join(app.getPath('downloads'), 'mistwarp-addon-settings.json'),
        filters: [
          {
            name: 'JSON',
            extensions: ['json']
          }
        ]
      });
      if (result.canceled) {
        return;
      }
      await writeFileAtomic(result.filePath, exportedSettings);
    });

    this.ipc.handle('get-advanced-customizations', async () => {
      const USERSCRIPT_PATH = path.join(app.getPath('userData'), 'userscript.js');
      const USERSTYLE_PATH = path.join(app.getPath('userData'), 'userstyle.css');

      const [userscript, userstyle] = await Promise.all([
        fsPromises.readFile(USERSCRIPT_PATH, 'utf-8').catch(() => ''),
        fsPromises.readFile(USERSTYLE_PATH, 'utf-8').catch(() => '')
      ]);

      return {
        userscript,
        userstyle
      };
    });

    this.ipc.handle('check-drag-and-drop-path', (event, filePath) => {
      FileAccessWindow.check(filePath);
    });

    /**
     * Refers to the full screen button in the editor, not the OS-level fullscreen through
     * F11/Alt+Enter (Windows, Linux) or buttons provided by the OS (macOS).
     */
    this.isInEditorFullScreen = false;

    this.ipc.handle('set-is-full-screen', (event, isFullScreen) => {
      this.isInEditorFullScreen = !!isFullScreen;
    });

    this.ipc.on('get-desktop-settings', (event) => {
      event.returnValue = {
        updateCheckerAllowed: isUpdateCheckerAllowed(),
        updateChecker: settings.updateChecker,
        microphone: settings.microphone,
        camera: settings.camera,
        backgroundThrottling: settings.backgroundThrottling,
        bypassCORS: settings.bypassCORS,
        spellchecker: settings.spellchecker,
        exitFullscreenOnEscape: settings.exitFullscreenOnEscape,
        cloudExtensions: settings.cloudExtensions,
        isOnline: net.isOnline()
      };
    });

    this.ipc.handle('set-desktop-setting', async (event, key, value) => {
      // 先写入内存，即使下面的应用逻辑抛错，设置也要保存到磁盘，
      // 否则用户切换开关后重启会回滚，表现为"设置无法打开/关闭"。
      switch (key) {
        case 'updateChecker':
          settings.updateChecker = value;
          break;
        case 'microphone':
          settings.microphone = value;
          break;
        case 'camera':
          settings.camera = value;
          break;
        case 'backgroundThrottling':
          settings.backgroundThrottling = value;
          break;
        case 'bypassCORS':
          settings.bypassCORS = value;
          break;
        case 'spellchecker':
          settings.spellchecker = value;
          break;
        case 'exitFullscreenOnEscape':
          settings.exitFullscreenOnEscape = value;
          break;
        case 'cloudExtensions':
          settings.cloudExtensions = value;
          break;
        default:
          throw new Error(`Unknown desktop setting: ${key}`);
      }

      // 异步应用设置；失败只记录日志，不影响持久化
      try {
        if (key === 'backgroundThrottling' || key === 'spellchecker') {
          AbstractWindow.settingsChanged();
        }
      } catch (error) {
        console.error('Failed to apply desktop setting:', key, error);
      }

      await settings.save();
    });

    this.ipc.handle('open-user-data', () => {
      shell.showItemInFolder(app.getPath('userData'));
    });

    this.loadURL('tw-editor://./gui/gui.html');
    this.show();
  }

  getPreload () {
    return 'editor';
  }

  getDimensions () {
    return {
      width: 1280,
      height: 800
    };
  }

  getBackgroundColor () {
    return '#333333';
  }

  applySettings () {
    // 窗口可能正在销毁（closed 事件触发前 webContents 已销毁），
    // 调用 setBackgroundThrottling 会抛错，导致 settingsChanged() 中断。
    if (this.window.isDestroyed()) {
      return;
    }
    this.window.webContents.setBackgroundThrottling(settings.backgroundThrottling);
  }

  onBeforeRequest (details, callback) {
    if (details.resourceType === 'cspReport' || details.resourceType === 'ping') {
      return callback({
        cancel: true
      });
    }

    // 扩展库改写与素材库改写都在 ProjectRunningWindow.onBeforeRequest 里
    // （映射表：src-main/extension-library-redirect.js）。这里不要重复实现，
    // 两份实现一旦不完全一致，就会出现"某个来源在编辑器里失效"的问题。
    super.onBeforeRequest(details, callback);
  }

  enumerateMediaDevices () {
    // Used by desktop settings
    return new Promise((resolve, reject) => {
      this.ipc.once('enumerated-media-devices', (event, result) => {
        if (typeof result.error !== 'undefined') {
          reject(result.error);
        } else {
          resolve(result.devices);
        }
      });
      this.window.webContents.send('enumerate-media-devices');
    });
  }

  handleWindowOpen (details) {
    if (details.url === 'about:blank' && details.features.includes('mistwarpAddonWindow')) {
      const features = {};
      for (const feature of details.features.split(',')) {
        const [key, value] = feature.split('=');
        features[key] = value;
      }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent: this.window,
          fullscreenable: false,
          minWidth: +features.minWidth || 200,
          minHeight: +features.minHeight || 150,
          resizable: features.resizable !== '0',
          alwaysOnTop: features.alwaysOnTop === '1',
          backgroundColor: this.getBackgroundColor()
        }
      };
    }

    const url = new URL(details.url);
    const params = new URLSearchParams(url.search);

    // Open the community settings page in a separate window
    if (
      url.protocol === 'tw-editor:' &&
      url.host === '.' &&
      url.pathname === '/settings'
    ) {
      SettingsWindow.show();
      return {
        action: 'deny'
      };
    }

    // Open extension sample projects in-app
    if (
      url.protocol === 'tw-editor:' &&
      url.host === '.' &&
      params.has('project_url')
    ) {
      const projectUrl = params.get('project_url');
      const parsedFile = parseOpenedFile(projectUrl, null);
      if (parsedFile.type === TYPE_SAMPLE) {
        new EditorWindow(parsedFile, null);
        return {
          action: 'deny'
        };
      }
    }

    // Open extension documentation in-app
    const extensionsDocsMatch = details.url.match(
      /^https:\/\/extensions\.turbowarp\.org\/([\w_\-.\/]+)$/
    );
    if (extensionsDocsMatch) {
      ExtensionDocumentationWindow.open(extensionsDocsMatch[1]);
      return {
        action: 'deny'
      };
    }

    const bilupExtensionsDocsMatch = details.url.match(
      /^https:\/\/extensions\.bilup\.org\/([\w_\-.\/]+)$/
    );
    if (bilupExtensionsDocsMatch) {
      ExtensionDocumentationWindow.open(bilupExtensionsDocsMatch[1], 'bl-extensions');
      return {
        action: 'deny'
      };
    }

    return super.handleWindowOpen(details);
  }

  canExitFullscreenByPressingEscape () {
    return !this.isInEditorFullScreen;
  }

  /**
   * @param {string[]} files
   * @param {boolean} fullscreen
   * @param {string|null} workingDirectory
   */
  static openFiles (files, fullscreen, workingDirectory) {
    if (files.length === 0) {
      EditorWindow.newWindow(fullscreen);
    } else {
      for (const file of files) {
        new EditorWindow(parseOpenedFile(file, workingDirectory), fullscreen);
      }
    }
  }

  /**
   * Open a new window with the default project.
   * @param {boolean} fullscreen
   */
  static newWindow (fullscreen) {
    new EditorWindow(null, fullscreen);
  }
}

module.exports = EditorWindow;
