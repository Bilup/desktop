const fs = require('fs');
const os = require('os');
const path = require('path');
const {app} = require('electron');

/**
 * 崩溃与运行环境的诊断日志（只写本地，不上传）。
 *
 * 为什么需要它：渲染进程崩溃时 Electron 只抛出一个 render-process-gone 事件，
 * 里面的 reason（oom / crashed / killed / launch-failed / ...）是判断方向的唯一
 * 线索。而界面上只会弹一个对话框，用户关掉之后这条信息就永久消失了 ——
 * 等到「桌面端容易崩溃」这类问题报上来时，手里没有任何证据，只能靠猜。
 *
 * 这里把每次崩溃（连同**崩溃时刻的系统内存快照**）追加落盘，让下一次崩溃自己
 * 说明原因。内存快照是重点：reason 为 oom 时，「当时还剩多少内存」比任何堆栈
 * 都有用，而这一点事后无论如何都补不回来。
 *
 * GPU 状态同理：WebGL 到底跑在硬件上还是被降级到软件渲染，界面上完全看不出来，
 * 却决定了运行作品是几十 fps 还是个位数、以及内存会不会爆。启动时采一次记下来。
 */

const LOG_FILENAME = 'diagnostics.log';

/** 日志超过这个大小就裁掉前半段，避免长期使用后无限增长。 */
const MAX_LOG_BYTES = 512 * 1024;

/**
 * @type {string|null}
 */
let cachedLogPath = null;

/**
 * Resolve the log path. Failures are not cached: getPath('userData') throws
 * before the app is ready, and we would rather retry later than permanently
 * give up on logging.
 * @returns {string|null} Log file path, or null when it cannot be resolved.
 */
const getLogPath = () => {
  if (cachedLogPath) {
    return cachedLogPath;
  }
  try {
    cachedLogPath = path.join(app.getPath('userData'), LOG_FILENAME);
    return cachedLogPath;
  } catch (error) {
    return null;
  }
};

/**
 * @param {number} bytes
 * @returns {string} eg. "1234MB"
 */
const megabytes = (bytes) => `${Math.round(bytes / (1024 * 1024))}MB`;

/**
 * 最近一次采样到的渲染进程堆状况，按 webContents id 索引。
 *
 * 不立刻写盘、只留在内存里，是为了让崩溃记录带上"崩之前最后一次看到的用量" ——
 * 进程一崩，这个数字就再也拿不到了，而它正是区分「JS 堆快满了」和「堆还很空但
 * 系统没内存了」的唯一依据（两者的处理方向完全相反）。
 * @type {Map<number, string>}
 */
const lastRendererHeap = new Map();

/**
 * 建议的渲染进程 V8 老生代上限（MB）。
 *
 * 与 `index.js` 里设置 `--js-flags=--max-old-space-size` 用的是**同一个公式**，
 * 这里复制一份是为了能在采样时判断它到底有没有生效（Chromium 的默认值是 2048）。
 * 改公式时两处都要改。
 * @returns {number}
 */
const suggestedHeapLimitMB = () => {
  const totalMB = Math.floor(os.totalmem() / (1024 * 1024));
  return Math.min(4096, Math.max(2048, Math.floor(totalMB * 0.4)));
};

/**
 * 采样渲染进程的 V8 堆上限与用量，写进日志并留在内存里备用。
 *
 * `performance.memory` 是 Chromium 的非标准扩展，但它给出的 `jsHeapSizeLimit` 是
 * **唯一能直接读出「渲染进程被允许用多少 JS 堆」的地方** —— 这个值由 Chromium 在 V8
 * 初始化时决定（默认钉在 2GB），只有 `--js-flags=--max-old-space-size` 能改。
 * 把上限和当时的用量一起记下来，既能验证改动生效，也能在崩溃时说明是哪一种内存问题。
 *
 * 只读，不需要渲染进程配合，因此不必改任何前端代码。
 * @param {Electron.WebContents} webContents
 * @returns {Promise<void>}
 */
const recordRendererHeap = async (webContents) => {
  if (!webContents || webContents.isDestroyed()) {
    return;
  }

  const id = webContents.id;
  let raw;
  try {
    raw = await webContents.executeJavaScript(
      'JSON.stringify((typeof performance !== "undefined" && performance.memory) ? {' +
      'limit: performance.memory.jsHeapSizeLimit,' +
      'total: performance.memory.totalHeapSize,' +
      'used: performance.memory.usedJSHeapSize' +
      '} : null)',
      false
    );
  } catch (error) {
    logError(`Could not sample the renderer heap: ${error.message}`);
    return;
  }

  let sample;
  try {
    sample = raw ? JSON.parse(raw) : null;
  } catch (error) {
    sample = null;
  }
  if (!sample || typeof sample.limit !== 'number' || sample.limit <= 0) {
    return;
  }

  const limitMB = Math.round(sample.limit / (1024 * 1024));
  const usedMB = Math.round(sample.used / (1024 * 1024));
  const line = [
    `limit ${limitMB}MB`,
    `total ${Math.round(sample.total / (1024 * 1024))}MB`,
    `used ${usedMB}MB`,
    `${(usedMB / limitMB * 100).toFixed(1)}% of limit`
  ].join(' | ');

  const first = !lastRendererHeap.has(id);
  lastRendererHeap.set(id, line);

  if (!first) {
    // 只更新内存里的值；写盘留给崩溃记录或下一次首次采样。
    return;
  }

  const suggested = suggestedHeapLimitMB();
  if (limitMB < suggested) {
    // 上限没被放宽到预期值：要么 --js-flags 没生效，要么这个 Electron 版本
    // 不接受该参数。这不是崩溃的直接原因，但会让 GC 比预期更频繁。
    logError(
      `Renderer JS heap limit is ${limitMB}MB but ${suggested}MB was requested ` +
      '(--js-flags=--max-old-space-size had no effect).'
    );
  }
  write('heap', line);
};

/**
 * A one-line snapshot of how much memory the machine has left right now.
 * On Windows os.freemem() is the physical memory still available, which is the
 * number that decides whether an allocation in the renderer can succeed.
 * @returns {string}
 */
const describeMemory = () => {
  const parts = [`${megabytes(os.freemem())} free of ${megabytes(os.totalmem())}`];
  try {
    parts.push(`main rss ${megabytes(process.memoryUsage().rss)}`);
  } catch (error) {
    // Not important enough to fail the log line over.
  }
  return parts.join(', ');
};

/**
 * Memory held by each of this app's processes, right now.
 *
 * This is the only view of a crashed renderer's footprint that survives it: the
 * process is already gone by the time we are told about it, so its own heap
 * statistics are unreachable, but the metrics Chromium keeps for every process
 * are still available here. Seeing which process was holding what is what
 * separates "the editor leaks" from "the project genuinely needs this much".
 *
 * @returns {string}
 */
const describeProcesses = () => {
  try {
    return app.getAppMetrics().map((metric) => {
      const memory = metric.memory || {};
      // workingSetSize is reported in kilobytes.
      const size = typeof memory.workingSetSize === 'number' ?
        `${megabytes(memory.workingSetSize * 1024)}` : '?';
      return `${metric.type}#${metric.pid}=${size}`;
    }).join(' ');
  } catch (error) {
    return 'unavailable';
  }
};

/**
 * Append one line to the log, rotating the file first when it has grown past
 * the cap. Writing must never throw into the caller: this runs while the app
 * is already in a bad state.
 * @param {string} tag
 * @param {string} message
 */
const write = (tag, message) => {
  const line = `[${new Date().toISOString()}] [${tag}] ${message}`;
  console.log(line);

  const file = getLogPath();
  if (!file) {
    return;
  }

  try {
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) {
        // Keep the second half; recent events are the ones being diagnosed.
        const existing = fs.readFileSync(file);
        fs.writeFileSync(file, existing.subarray(Math.floor(existing.length / 2)));
      }
    } catch (error) {
      // The file not existing yet is the normal case.
    }
    fs.appendFileSync(file, `${line}\n`);
  } catch (error) {
    console.error('Could not write diagnostics log:', error);
  }
};

/**
 * @param {string} message
 */
const log = (message) => write('info', message);

/**
 * @param {string} message
 */
const logError = (message) => write('error', message);

/**
 * Record a process death. Called from the render-process-gone and
 * child-process-gone handlers, before anything tries to recover.
 * @param {string} type Electron's process type, eg. "Renderer" or "GPU".
 * @param {string} reason Electron's exit reason, eg. "oom" or "crashed".
 * @param {number} exitCode
 * @param {string} [url] Page that was loaded, when known.
 * @param {number|null} [webContentsId] Used to attach the last heap sample taken
 * from that renderer, which is the only surviving record of how full its JS heap
 * was when it died.
 */
const recordCrash = (type, reason, exitCode, url, webContentsId) => {
  const details = [
    `${type} process gone`,
    `reason=${reason}`,
    `exitCode=${exitCode}`,
    `memory: ${describeMemory()}`
  ];
  if (url) {
    details.push(`url=${url}`);
  }
  write('crash', details.join(' | '));
  write('crash', `processes: ${describeProcesses()}`);

  if (typeof webContentsId === 'number') {
    const heap = lastRendererHeap.get(webContentsId);
    if (heap) {
      write('crash', `renderer heap at last sample: ${heap}`);
      lastRendererHeap.delete(webContentsId);
    }
  }

  if (reason === 'oom') {
    logError(
      `${type} process ran out of memory. ` +
      'That is a memory limit, not a logic error: check what the project loads ' +
      '(costumes, sounds, clones) and whether the machine has memory to spare.'
    );
  }
};

/**
 * Record which graphics features Chromium says are available.
 *
 * "enabled" means accelerated; anything mentioning software means the work fell
 * back to the CPU, which is both slower by orders of magnitude and far hungrier
 * for the same memory the renderer needs.
 */
const recordGpuFeatureStatus = () => {
  let status;
  try {
    status = app.getGPUFeatureStatus();
  } catch (error) {
    logError(`Could not read GPU feature status: ${error.message}`);
    return;
  }
  if (!status || typeof status !== 'object') {
    return;
  }

  const keys = Object.keys(status).sort();
  write('gpu', keys.map((key) => `${key}=${status[key]}`).join(' | '));

  const software = keys.filter((key) => String(status[key]).includes('software'));
  if (software.length > 0) {
    logError(
      `Graphics is running on the CPU for: ${software.join(', ')}. ` +
      'Hardware acceleration is not in use.'
    );
  }
};

/**
 * Record the adapter list and which one is active.
 *
 * Worth logging in full because "which GPU did it pick" is invisible from the
 * UI and is a common cause of both slowness and instability on machines with
 * more than one adapter (hybrid laptops, and anything with a virtual display
 * driver installed).
 */
const recordGpuInfo = async () => {
  let info;
  try {
    info = await app.getGPUInfo('basic');
  } catch (error) {
    logError(`Could not read GPU info: ${error.message}`);
    return;
  }
  if (!info || !Array.isArray(info.gpuDevice)) {
    return;
  }

  info.gpuDevice.forEach((device, index) => {
    write('gpu', [
      `device[${index}]`,
      `active=${Boolean(device.active)}`,
      `vendor=${device.vendorString || device.vendorId}`,
      `device=${device.deviceString || device.deviceId}`,
      `driver=${device.driverVersion || 'unknown'}`
    ].join(' '));
  });

  const active = info.gpuDevice.filter((device) => device.active);
  if (active.length > 1) {
    logError(`More than one active GPU reported (${active.length}); rendering may move between them.`);
  }
};

/**
 * Collect everything worth knowing about this run. Safe to call once the app is
 * ready; it never rejects.
 * @returns {Promise<void>}
 */
const recordEnvironment = async () => {
  write('env', [
    `app ${app.getVersion()}`,
    `electron ${process.versions.electron || 'unknown'}`,
    `chrome ${process.versions.chrome || 'unknown'}`,
    `platform ${process.platform} ${os.release()} (${os.arch()})`,
    `cpus ${os.cpus().length}`,
    `memory ${megabytes(os.totalmem())}`,
    `free ${megabytes(os.freemem())}`
  ].join(' | '));

  recordGpuFeatureStatus();
  await recordGpuInfo();
};

module.exports = {
  log,
  logError,
  recordCrash,
  recordEnvironment,
  recordRendererHeap
};
