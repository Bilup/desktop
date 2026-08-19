const {net} = require('electron');
const AbstractWindow = require('./abstract');
const {translate} = require('../l10n');
const {APP_NAME} = require('../brand');
const settings = require('../settings');
const {isUpdateCheckerAllowed} = require('../update-checker');
const RichPresence = require('../rich-presence.js');

class SettingsWindow extends AbstractWindow {
  constructor () {
    super();

    this.window.setTitle(`${translate('menu.settings')} - ${APP_NAME}`);

    this.ipc.on('get-desktop-settings', (event) => {
      event.returnValue = {
        updateCheckerAllowed: isUpdateCheckerAllowed(),
        updateChecker: settings.updateChecker,
        microphone: settings.microphone,
        camera: settings.camera,
        hardwareAcceleration: settings.hardwareAcceleration,
        backgroundThrottling: settings.backgroundThrottling,
        bypassCORS: settings.bypassCORS,
        spellchecker: settings.spellchecker,
        exitFullscreenOnEscape: settings.exitFullscreenOnEscape,
        richPresenceAvailable: RichPresence.isAvailable(),
        richPresence: settings.richPresence,
        cloudExtensions: settings.cloudExtensions,
        isOnline: net.isOnline()
      };
    });

    this.ipc.handle('set-desktop-setting', async (event, key, value) => {
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
        case 'hardwareAcceleration':
          settings.hardwareAcceleration = value;
          break;
        case 'backgroundThrottling':
          settings.backgroundThrottling = value;
          AbstractWindow.settingsChanged();
          break;
        case 'bypassCORS':
          settings.bypassCORS = value;
          break;
        case 'spellchecker':
          settings.spellchecker = value;
          AbstractWindow.settingsChanged();
          break;
        case 'exitFullscreenOnEscape':
          settings.exitFullscreenOnEscape = value;
          break;
        case 'richPresence':
          settings.richPresence = value;
          if (value) {
            RichPresence.enable();
          } else {
            RichPresence.disable();
          }
          break;
        case 'cloudExtensions':
          settings.cloudExtensions = value;
          break;
        default:
          throw new Error(`Unknown desktop setting: ${key}`);
      }
      await settings.save();
    });

    this.loadURL('tw-editor://./settings/settings.html');
  }

  getPreload () {
    return 'editor';
  }

  getDimensions () {
    return {
      width: 900,
      height: 700
    };
  }

  isPopup () {
    return true;
  }

  getBackgroundColor () {
    return '#ffffff';
  }

  static show () {
    const window = AbstractWindow.singleton(SettingsWindow);
    window.show();
  }
}

module.exports = SettingsWindow;
