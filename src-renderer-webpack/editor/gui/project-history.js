// Stub for scratch-gui/src/lib/git/project-history.js
// This module is referenced by scratch-gui's project-fetcher-hoc.jsx
// and sb-file-uploader-hoc.jsx but the project history feature
// is not supported in the desktop environment.
// Functions are stubbed to avoid reference errors at runtime.

export const markProjectHistoryLoading = () => {
    // No-op: project history is not available in desktop
};

export const preloadProjectHistory = () => {
    // No-op: project history is not available in desktop
    return Promise.resolve({
        status: {initialized: false},
        graph: {branches: [], nodes: [], branchLogs: []},
        remotes: [],
        readme: ''
    });
};

export const getProjectHistoryState = () => ({
    phase: 'idle',
    data: null,
    error: null
});

export const subscribeProjectHistory = () => {
    // No-op: project history is not available in desktop
    return () => {};
};