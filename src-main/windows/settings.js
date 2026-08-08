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

  static show () {
    const window = AbstractWindow.singleton(SettingsWindow);
    window.show();
  }
}

module.exports = SettingsWindow;
