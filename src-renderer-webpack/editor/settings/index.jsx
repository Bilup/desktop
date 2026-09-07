import {addLocaleData, IntlProvider} from 'react-intl';
import React from 'react';
import ReactDOM from 'react-dom';
import {MemoryRouter} from 'react-router-dom';

import {localeData} from '@bilup/scratch-l10n';
import editorMessages from '@bilup/scratch-l10n/locales/editor-msgs';
import addAdditionalTranslations from 'scratch-gui/src/lib/tw-translations/index.js';
import communityTranslations from 'scratch-gui/src/community/translations/zh-cn.json';
import IntlBridge from 'scratch-gui/src/lib/tw-use-intl.jsx';
import {detectLocale} from 'scratch-gui/src/lib/utils/detect-locale.js';
import {UserProvider} from 'scratch-gui/src/community/UserContext.jsx';
import Settings from 'scratch-gui/src/community/pages/Settings.jsx';
import ErrorContainerHOC from '../error/error-container-hoc.jsx';

const SafeSettings = ErrorContainerHOC(Settings);

// Community design tokens are global CSS; they must not be processed as CSS modules.
import '!!style-loader!css-loader!scratch-gui/src/community/styles/tokens.css';

// Register locale data (required for react-intl to format numbers/dates).
addLocaleData(localeData);

// Merge TW/Bilup extra translations and community site translations.
addAdditionalTranslations(editorMessages);
for (const locale of Object.keys(editorMessages)) {
  const toMixIn = communityTranslations[locale.toLowerCase()];
  if (toMixIn) {
    Object.assign(editorMessages[locale], toMixIn);
  }
}
const supportedLocales = Object.keys(editorMessages);
const locale = detectLocale(supportedLocales);

const appTarget = document.getElementById('app');
document.body.classList.add('tw-loaded');

ReactDOM.render(
  <IntlProvider locale={locale} messages={editorMessages[locale]}>
    {/*
      Settings 页面来自 gui 社区站,内部会使用 react-router 的
      useSearchParams/useLocation(在网站里它运行在 Router 内)。桌面端是
      独立渲染的裸页面,这里补一个 MemoryRouter,否则会触发
      invariant 抛错导致整页白屏。
    */}
    <MemoryRouter initialEntries={['/settings']}>
      <IntlBridge>
        <UserProvider>
          <SafeSettings isScratchDesktop={true} />
        </UserProvider>
      </IntlBridge>
    </MemoryRouter>
  </IntlProvider>,
  appTarget
);
