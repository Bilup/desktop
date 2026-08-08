const {BrowserWindow} = require('electron');
const AbstractWindow = require('./abstract');

class AccountsLoginWindow extends AbstractWindow {
  constructor (options) {
    super(options);

    this.window.setTitle('Bilup Accounts');
    this.window.setMenuBarVisibility(false);
  }

  getDimensions () {
    return {
      width: 520,
      height: 700
    };
  }

  isPopup () {
    return true;
  }

  handleWillNavigate (event, url) {
    // The Bilup Accounts login flow may redirect within accounts.bilup.org.
    if (new URL(url).origin === 'https://accounts.bilup.org') {
      return;
    }
    super.handleWillNavigate(event, url);
  }

  handleWindowOpen (details) {
    if (new URL(details.url).origin === 'https://accounts.bilup.org') {
      return AccountsLoginWindow.open(details.url);
    }
    return super.handleWindowOpen(details);
  }

  /**
   * Builds a window-open-handler response that opens `url` in an in-app
   * BrowserWindow. Using `createWindow` keeps the `window.open` result wired
   * to the opener, so rotur-sdk's postMessage login flow keeps working.
   * @param {string} url
   * @returns {Electron.HandlerResponse}
   */
  static open (url) {
    return {
      action: 'deny',
      createWindow: (options) => {
        const win = new BrowserWindow({
          ...options,
          width: 520,
          height: 700,
          useContentSize: true
        });
        new AccountsLoginWindow({existingWindow: win});
        return win;
      }
    };
  }
}

module.exports = AccountsLoginWindow;
