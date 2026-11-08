import React from 'react';
import {connect} from 'react-redux';
import PropTypes from 'prop-types';
import {
  openLoadingProject,
  closeLoadingProject,
  openInvalidProjectModal,
  openSettingsModal
} from 'scratch-gui/src/reducers/modals';
import WindowManager from 'scratch-gui/src/addons/window-system/window-manager';
import {
  requestProjectUpload,
  setProjectId,
  defaultProjectId,
  onFetchedProjectData,
  onLoadedProject,
  requestNewProject
} from 'scratch-gui/src/reducers/project-state';
import {
  setFileHandle,
  setUsername,
  setProjectError
} from 'scratch-gui/src/reducers/tw';
import {WrappedFileHandle} from './filesystem-api.js';
import {setStrings} from '../prompt/prompt.js';

let mountedOnce = false;

/**
 * @param {string} filename
 * @returns {string}
 */
const getDefaultProjectTitle = (filename) => {
  const match = filename.match(/([^/\\]+)\.sb[2|3]?$/);
  if (!match) return filename;
  return match[1];
};

const openIframeWindow = (id, title, url, width, height) => {
  const existing = WindowManager.getWindow(id);
  if (existing) {
    existing.show().bringToFront();
    return;
  }
  const win = WindowManager.createWindow({
    id,
    title,
    width,
    height,
    minWidth: 400,
    minHeight: 300
  });
  const iframe = document.createElement('iframe');
  iframe.src = url;
  iframe.style.cssText = 'border:none;display:block;width:100%;height:100%;flex:1;background:var(--ui-modal-background,#fff);';
  win.setContent(iframe);
  win.show();
  if (win.popup) {
    win.popup.addEventListener('message', (e) => {
      if (e.source !== win.popup) {
        window.postMessage(e.data, '*');
      }
    });
  }
};

const handleClickAddonSettings = (search, title) => {
  const hash = typeof search === 'string' && search ? `#${search}` : '';
  openIframeWindow('addonSettings', title || 'Addon Settings', `tw-editor://./addons/addons.html${hash}`, 700, 650);
};

const handleClickNewWindow = () => {
  EditorPreload.openNewWindow();
};

const handleClickPackager = () => {
  EditorPreload.openPackager();
};

const handleClickPrivacy = (title) => {
  const updateCheckerAllowed = EditorPreload.getDesktopSettings().updateCheckerAllowed;
  openIframeWindow('privacyPolicy', title || 'Privacy Policy', `tw-privacy://./privacy.html?updateChecker=${updateCheckerAllowed}`, 700, 650);
};

const handleClickAbout = (title) => {
  const info = EditorPreload.getAboutInfo();
  openIframeWindow('aboutWindow', title || 'About', `tw-about://./about.html?${new URLSearchParams(info)}`, 750, 650);
};

const handleClickSourceCode = () => {
  window.open('https://github.com/Bilup');
};

const securityManager = {
  // Everything not specified here falls back to the scratch-gui security manager

  // Managed by Electron main process:
  canReadClipboard: () => true,
  canNotify: () => true,

  // Does not work in Electron:
  canGeolocate: () => false
};

const USERNAME_KEY = 'tw:username';
const DEFAULT_USERNAME = 'player';

/**
 * 估算这个作品本身需要多少内存（运行期实际会占用的量级，不是文件体积）。
 *
 * 为什么需要：`.sb3` 的体积和它加载后吃掉的内存相差一到两个数量级，而用户看到的是
 * 后者。两个放大源都很彻底：
 *   - **服装纹理**：scratch-render 把每张位图上传成 RGBA 纹理，显存/内存占用是
 *     `宽 × 高 × 4` 字节（位图服装还要按 bitmapResolution=2 算，即长宽各乘 2）。
 *     一张 300KB 的 PNG 如果画布是 1080×1080，纹理就是 1080×2×1080×2×4 ≈ 18MB。
 *   - **声音 PCM**：加载时每个声音都会被解码成 float32 PCM（`sampleCount × 4` 字节），
 *     44.1kHz 下每秒约 176KB —— 五分钟的音乐约 52MB，一小时约 634MB。
 *
 * 把这两个数字（加上服装/声音/积木的条数）跟进程内存放在同一条日志里，才能判断
 * "8GB 是这个作品真的需要，还是哪里在重复持有"。
 *
 * 只做算术，不解码、不复制数据，耗时是一次遍历（几千个对象量级）。
 * @param {object} vm scratch-vm 实例
 * @returns {object} 供主进程日志使用的统计
 */
const estimateProjectFootprint = (vm) => {
    const runtime = vm && vm.runtime;
    if (!runtime || !Array.isArray(runtime.targets)) {
        return null;
    }

    let sprites = 0;
    let costumes = 0;
    let texels = 0;
    let sounds = 0;
    let pcmBytes = 0;
    let blocks = 0;
    let assetBytes = 0;

    for (const target of runtime.targets) {
        const sprite = target.sprite;
        if (!sprite) {
            continue;
        }
        if (target.isOriginal) {
            sprites++;
        }
        for (const costume of (sprite.costumes || [])) {
            costumes++;
            // size 是"服装单位"下的尺寸，纹理按 bitmapResolution 分配 texel。
            const resolution = costume.bitmapResolution || 1;
            const width = costume.size && costume.size[0] ? costume.size[0] : 0;
            const height = costume.size && costume.size[1] ? costume.size[1] : 0;
            texels += Math.round(width * resolution) * Math.round(height * resolution);
            if (costume.asset && costume.asset.data && costume.asset.data.length) {
                assetBytes += costume.asset.data.length;
            }
        }
        for (const sound of (sprite.sounds || [])) {
            sounds++;
            pcmBytes += (sound.sampleCount || 0) * 4;
            if (sound.asset && sound.asset.data && sound.asset.data.length) {
                assetBytes += sound.asset.data.length;
            }
        }
        if (target.blocks && target.blocks._blocks) {
            blocks += Object.keys(target.blocks._blocks).length;
        }
    }

    const toMB = (bytes) => Math.round(bytes / (1024 * 1024));

    return {
        sprites,
        costumes,
        // 一张纹理按 RGBA 4 字节/texel 估算；实际还会因为缩放级别额外生成缩略纹理。
        textureMB: toMB(texels * 4),
        sounds,
        soundMB: toMB(pcmBytes),
        blocks,
        // 压缩后的原始素材字节数，用来对比上面的放大幅度。
        assetMB: toMB(assetBytes)
    };
};

const DesktopHOC = function (WrappedComponent) {
  class DesktopComponent extends React.Component {
    constructor (props) {
      super(props);
      this.state = {
        title: ''
      };
      this.handleUpdateProjectTitle = this.handleUpdateProjectTitle.bind(this);
      this.handleWindowMessage = this.handleWindowMessage.bind(this);

      // Changing locale always re-mounts this component
      const stateFromMain = EditorPreload.setLocale(this.props.locale);
      this.messages = stateFromMain.strings;
      setStrings({
        ok: this.messages['prompt.ok'],
        cancel: this.messages['prompt.cancel']
      });

      const storedUsername = localStorage.getItem(USERNAME_KEY);
      if (typeof storedUsername === 'string') {
        this.props.onSetReduxUsername(storedUsername);
      } else {
        this.props.onSetReduxUsername(DEFAULT_USERNAME);
      }
    }
    componentDidMount () {
      window.addEventListener('message', this.handleWindowMessage);

      EditorPreload.setExportForPackager(() => this.props.vm.saveProjectSb3('arraybuffer')
        .then((buffer) => ({
          name: this.state.title,
          data: buffer
        })));

      // This component is re-mounted when the locale changes, but we only want to load
      // the initial project once.
      if (mountedOnce) {
        return;
      }
      mountedOnce = true;

      this.props.onLoadingStarted();
      (async () => {
        // Note that 0 is a valid ID and does mean there is a file open
        const id = await EditorPreload.getInitialFile();
        if (id === null) {
          this.props.onHasInitialProject(false, this.props.loadingState);
          this.props.onLoadingCompleted();
          return;
        }

        this.props.onHasInitialProject(true, this.props.loadingState);
        const {name, type, data} = await EditorPreload.getFile(id);

        await this.props.vm.loadProject(data);
        this.props.onLoadingCompleted();
        this.props.onLoadedProject(this.props.loadingState, true);

        // 把体积估算挂到 window 上，供主进程的内存采样一起写进诊断日志
        // （见 src-main/memory-trace.js 的 readRendererHeap）。只有几个数字，
        // 不持有任何 VM 对象，也不会影响 GC。
        try {
          window.__bilupProjectStats = estimateProjectFootprint(this.props.vm);
        } catch (error) {
          // 统计失败不影响加载
        }

        const title = getDefaultProjectTitle(name);
        if (title) {
          this.setState({
            title
          });
        }

        if (type === 'file' && name.endsWith('.sb3')) {
          this.props.onSetFileHandle(new WrappedFileHandle(id, name));
        }
      })().catch(error => {
        console.error(error);

        this.props.onShowErrorModal(error);
        this.props.onLoadingCompleted();
        this.props.onLoadedProject(this.props.loadingState, false);
        this.props.onHasInitialProject(false, this.props.loadingState);
        this.props.onRequestNewProject();
      });
    }
    componentDidUpdate (prevProps, prevState) {
      if (this.props.projectChanged !== prevProps.projectChanged) {
        EditorPreload.setChanged(this.props.projectChanged);
      }

      if (this.state.title !== prevState.title) {
        document.title = this.state.title;
      }

      if (this.props.fileHandle !== prevProps.fileHandle) {
        if (this.props.fileHandle) {
          EditorPreload.openedFile(this.props.fileHandle.id);
        } else {
          EditorPreload.closedFile();
        }
      }

      if (this.props.reduxUsername !== prevProps.reduxUsername) {
        localStorage.setItem(USERNAME_KEY, this.props.reduxUsername);
      }

      if (this.props.isFullScreen !== prevProps.isFullScreen) {
        EditorPreload.setIsFullScreen(this.props.isFullScreen);
      }
    }
    componentWillUnmount () {
      window.removeEventListener('message', this.handleWindowMessage);
    }
    handleWindowMessage (e) {
      if (e.data && typeof e.data.mwExportAddonSettings === 'string') {
        EditorPreload.exportAddonSettings(e.data.mwExportAddonSettings);
        return;
      }
      const what = e.data && e.data.mwOpenWindow;
      if (what === 'settings') {
        this.props.onOpenSettingsModal();
      } else if (what === 'about') {
        handleClickAbout(this.messages['about'].replace('{APP_NAME}', EditorPreload.getAboutInfo().appName));
      } else if (what === 'addons') {
        handleClickAddonSettings(null, this.messages['addon-settings']);
      } else if (what === 'privacy') {
        handleClickPrivacy(this.messages['privacy-policy']);
      }
    }
    handleUpdateProjectTitle (newTitle) {
      this.setState({
        title: newTitle
      });
    }
    render() {
      const {
        locale,
        loadingState,
        projectChanged,
        fileHandle,
        reduxUsername,
        onFetchedInitialProjectData,
        onHasInitialProject,
        onLoadedProject,
        onLoadingCompleted,
        onLoadingStarted,
        onRequestNewProject,
        onSetFileHandle,
        onSetReduxUsername,
        onShowErrorModal,
        onOpenSettingsModal,
        vm,
        ...props
      } = this.props;
      return (
        <WrappedComponent
          projectTitle={this.state.title}
          onUpdateProjectTitle={this.handleUpdateProjectTitle}
          onClickAddonSettings={(search) => handleClickAddonSettings(search, this.messages['addon-settings'])}
          onClickNewWindow={handleClickNewWindow}
          onClickPackager={handleClickPackager}
          onClickAbout={[
            {
              title: this.messages['in-app-about.privacy'],
              onClick: () => handleClickPrivacy(this.messages['privacy-policy']),
              icon: 'shield'
            },
            {
              title: this.messages['in-app-about.about'],
              onClick: () => handleClickAbout(this.messages['about'].replace('{APP_NAME}', EditorPreload.getAboutInfo().appName)),
              icon: 'info'
            },
            {
              title: this.messages['in-app-about.source-code'],
              onClick: handleClickSourceCode,
              icon: 'code'
            },
          ]}
          securityManager={securityManager}
          {...props}
        />
      );
    }
  }

  DesktopComponent.propTypes = {
    locale: PropTypes.string.isRequired,
    loadingState: PropTypes.string.isRequired,
    projectChanged: PropTypes.bool.isRequired,
    fileHandle: PropTypes.shape({
      id: PropTypes.string.isRequired
    }),
    isFullScreen: PropTypes.bool.isRequired,
    reduxUsername: PropTypes.string.isRequired,
    onFetchedInitialProjectData: PropTypes.func.isRequired,
    onHasInitialProject: PropTypes.func.isRequired,
    onLoadedProject: PropTypes.func.isRequired,
    onLoadingCompleted: PropTypes.func.isRequired,
    onLoadingStarted: PropTypes.func.isRequired,
    onRequestNewProject: PropTypes.func.isRequired,
    onSetFileHandle: PropTypes.func.isRequired,
    onSetReduxUsername: PropTypes.func.isRequired,
    onShowErrorModal: PropTypes.func.isRequired,
    onOpenSettingsModal: PropTypes.func.isRequired,
    vm: PropTypes.shape({
      loadProject: PropTypes.func.isRequired
    }).isRequired
  };

  const mapStateToProps = state => ({
    locale: state.locales.locale,
    loadingState: state.scratchGui.projectState.loadingState,
    isFullScreen: state.scratchGui.mode.isFullScreen,
    projectChanged: state.scratchGui.projectChanged,
    fileHandle: state.scratchGui.tw.fileHandle,
    reduxUsername: state.scratchGui.tw.username,
    vm: state.scratchGui.vm
  });

  const mapDispatchToProps = dispatch => ({
    onLoadingStarted: () => dispatch(openLoadingProject()),
    onLoadingCompleted: () => dispatch(closeLoadingProject()),
    onHasInitialProject: (hasInitialProject, loadingState) => {
      if (hasInitialProject) {
        return dispatch(requestProjectUpload(loadingState));
      }
      return dispatch(setProjectId(defaultProjectId));
    },
    onFetchedInitialProjectData: (projectData, loadingState) => dispatch(onFetchedProjectData(projectData, loadingState)),
    onLoadedProject: (loadingState, loadSuccess) => {
      return dispatch(onLoadedProject(loadingState, /* canSave */ false, loadSuccess));
    },
    onRequestNewProject: () => dispatch(requestNewProject(false)),
    onSetFileHandle: fileHandle => dispatch(setFileHandle(fileHandle)),
    onSetReduxUsername: username => dispatch(setUsername(username)),
    onShowErrorModal: error => {
      dispatch(setProjectError(error));
      dispatch(openInvalidProjectModal());
    },
    onOpenSettingsModal: () => dispatch(openSettingsModal())
  });

  return connect(
    mapStateToProps,
    mapDispatchToProps
  )(DesktopComponent);
};

export default DesktopHOC;
