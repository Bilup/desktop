const AbstractWindow = require('./abstract');
const {translate} = require('../l10n');
const {APP_NAME} = require('../brand');

class SettingsWindow extends AbstractWindow {
  constructor () {
    super();

    this.window.setTitle(`${translate('menu.settings')} - ${APP_NAME}`);
    this.loadURL('tw-editor://./settings/settings.html');
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

  handleWindowOpen (details) {
    // The Bilup Accounts login flow opens a popup; rotur-sdk falls back to a
    // fullscreen iframe when window.open is denied, so don't also open the
    // auth page in the system browser.
    if (new URL(details.url).origin === 'https://accounts.bilup.org') {
      return {
        action: 'deny'
      };
    }
    return super.handleWindowOpen(details);
  }

  static show () {
    const window = AbstractWindow.singleton(SettingsWindow);
    window.show();
  }
}

module.exports = SettingsWindow;
