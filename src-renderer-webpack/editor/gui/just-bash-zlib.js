// Shim for the "node:zlib" module referenced by just-bash in the browser
// terminal. The browser environment has no native zlib, so compression
// commands are intentionally unavailable. Mirrors scratch-gui's
// just-bash-zlib.js, with a slightly wider API surface so that any
// additional zlib imports in just-bash resolve instead of warning.
const unsupported = () => {
    throw new Error('compression commands are not available in the browser terminal');
};

const constants = {
    Z_BEST_COMPRESSION: 9,
    Z_BEST_SPEED: 1,
    Z_DEFAULT_COMPRESSION: -1,
    Z_NO_COMPRESSION: 0,
    Z_DEFAULT_STRATEGY: 0,
    Z_OK: 0,
    Z_STREAM_END: 1,
    Z_NEED_DICT: 2,
    Z_ERRNO: -1,
    Z_STREAM_ERROR: -2,
    Z_DATA_ERROR: -3,
    Z_MEM_ERROR: -4,
    Z_BUF_ERROR: -5,
    Z_VERSION_ERROR: -6
};

export {
    constants,
    unsupported as gzipSync,
    unsupported as gunzipSync,
    unsupported as deflateSync,
    unsupported as inflateSync,
    unsupported as deflateRawSync,
    unsupported as inflateRawSync,
    unsupported as unzipSync,
    unsupported as brotliCompressSync,
    unsupported as brotliDecompressSync
};
