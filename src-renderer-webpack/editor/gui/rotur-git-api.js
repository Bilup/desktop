// Stub for scratch-gui/src/lib/rotur/git-api.js
// This module is referenced by scratch-gui/src/lib/git/sync-remotes.js
// but does not exist in the Bilup/scratch-gui#develop-builds package.
// Functions are stubbed to avoid build errors; rotur-specific git sync
// is not supported in the desktop environment.

export const getAuth = () => {
    console.warn('rotur git-api is not available in desktop environment');
    return null;
};

export const isRoturGitUrl = () => false;