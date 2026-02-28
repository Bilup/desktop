import React from 'react';
import ReactDOM from 'react-dom';

// Patch Theme class to fix accent color access
import {Theme} from 'scratch-gui/src/lib/themes/index.js';

// Save original methods
const originalGetGuiColors = Theme.prototype.getGuiColors;
const originalGetBlockColors = Theme.prototype.getBlockColors;

// Patch getGuiColors method
Theme.prototype.getGuiColors = function() {
    try {
        // Try the original method first
        return originalGetGuiColors.call(this);
    } catch (e) {
        // If it fails, use the correct access path
        const ACCENT_MAP = require('scratch-gui/src/lib/themes/accents.js').ACCENT_MAP;
        const GUI_MAP = require('scratch-gui/src/lib/themes/gui.js').GUI_MAP;
        const BLOCKS_MAP = require('scratch-gui/src/lib/themes/index.js').BLOCKS_MAP;
        
        // Simple object merge instead of defaultsDeep
        const result = {};
        
        // Merge accent colors
        const accentColors = ACCENT_MAP[this.accent]?.accent?.guiColors;
        if (accentColors) {
            Object.assign(result, accentColors);
        }
        
        // Merge GUI colors
        const guiColors = GUI_MAP[this.gui]?.guiColors;
        if (guiColors) {
            Object.assign(result, guiColors);
        }
        
        // Merge block colors
        const blockColors = BLOCKS_MAP[this.blocks]?.colors;
        if (blockColors) {
            Object.assign(result, blockColors);
        }
        
        return result;
    }
};

// Patch getBlockColors method
Theme.prototype.getBlockColors = function() {
    try {
        // Try the original method first
        return originalGetBlockColors.call(this);
    } catch (e) {
        // If it fails, use the correct access path
        const ACCENT_MAP = require('scratch-gui/src/lib/themes/accents.js').ACCENT_MAP;
        const GUI_MAP = require('scratch-gui/src/lib/themes/gui.js').GUI_MAP;
        const BLOCKS_MAP = require('scratch-gui/src/lib/themes/index.js').BLOCKS_MAP;
        
        // Simple object merge instead of defaultsDeep
        const result = {};
        
        // Merge accent colors
        const accentColors = ACCENT_MAP[this.accent]?.accent?.blockColors;
        if (accentColors) {
            Object.assign(result, accentColors);
        }
        
        // Merge GUI colors
        const guiColors = GUI_MAP[this.gui]?.blockColors;
        if (guiColors) {
            Object.assign(result, guiColors);
        }
        
        // Merge block colors
        const blockColors = BLOCKS_MAP[this.blocks]?.colors;
        if (blockColors) {
            Object.assign(result, blockColors);
        }
        
        return result;
    }
};

import AddonSettings from 'scratch-gui/src/addons/settings/settings.jsx';
import '../prompt/prompt.js';
import ErrorContainerHOC from '../error/error-container-hoc.jsx';

const handleExportSettings = (settings) => {
  AddonsPreload.exportSettings(JSON.stringify(settings));
};

const WrappedAddonSettings = ErrorContainerHOC(AddonSettings);

const appTarget = document.getElementById('app');
document.body.classList.add('tw-loaded');

ReactDOM.render((
  <WrappedAddonSettings
    onExportSettings={handleExportSettings}
  />
), appTarget);
