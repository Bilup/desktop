const {app} = require('electron');
const os = require('os');
const diagnostics = require('./diagnostics');

/**
 * 进程内存采样（主进程侧）。
 *
 * 为什么需要它：用户报的「打开一个大作品后占了 8GB」是一个**总量**，而
 * `app.getAppMetrics()` 是唯一能把总量拆到具体进程上的接口 ——
 * Browser（主进程）、Tab（渲染进程）、GPU、Utility 各自的 WorkingSet 都在里面。
 * 不拆开就无法判断该改哪里：
 *   - 主进程持有大量 Buffer  → 协议缓存/网络读取的问题；
 *   - 渲染进程（Tab）占大头 → 项目素材在 JS 里的解码与常驻（scratch-vm/render）；
 *   - GPU 占大头            → 纹理，或硬件加速被降级到 SwiftShader。
 * 这三条的处理方向完全不同，而今天的日志只在**崩溃时**才记一次。
 *
 * 采样频率刻意很低：它要能长期开着而不影响项目本身的性能。
 * 打开项目后的几个时间点是固定的（覆盖"解码中 → 峰值 → 稳定值"），
 * 需要更细的曲线时用环境变量 BILUP_MEMORY_TRACE=1 打开周期采样。
 */

const MB = 1024 * 1024;

/**
 * 是否开启周期采样。
 *
 * 默认关闭：每次采样要跨进程调用一次渲染进程（读 `performance.memory`），
 * 长期每 10 秒一次虽不贵，但没有排障需求时纯属浪费。打开项目后的固定
 * 采样点**不受这个开关影响**，那是回答"为什么占这么多"最少需要的证据。
 */
const TRACE_ENABLED = (() => {
  const raw = process.env.BILUP_MEMORY_TRACE;
  if (typeof raw !== 'string' || raw === '') {
    return false;
  }
  const normalized = raw.toLowerCase();
  return normalized !== '0' && normalized !== 'false' && normalized !== 'off';
})();

/** 周期采样间隔（仅在 TRACE_ENABLED 时生效）。 */
const TRACE_INTERVAL_MS = 10 * 1000;

/**
 * 项目数据交付给渲染进程之后，在这些时刻各采一次。
 *
 * 5s：解压/解码大体还在进行，能看到"峰值";
 * 20s：基本加载完成，对应老代码里的单次采样点;
 * 60s：稳态，用来判断"落地后没有回收的东西有多少"。
 * @const {number[]}
 */
const PROJECT_LOAD_SAMPLE_DELAYS_MS = [5000, 20000, 60000];

/**
 * 加载完成后多久请求一次异步 full GC。
 *
 * 必须晚于 5s 那次采样：要能看到"GC 之前"的峰值，才有回收量可算。
 * 也必须在 JSZip 解压、每张图解码都结束之后，否则回收的是还没用完的中间数据，
 * 等于白跑一次。
 * @const {number}
 */
const PROJECT_LOAD_GC_DELAY_MS = 8000;

/** 异步 GC 之后等多久再读堆（async GC 不阻塞，读完立刻问会读到旧值）。 */
const GC_SETTLE_MS = 1500;

/**
 * @param {number} bytes
 * @returns {string} 例如 "3120MB"
 */
const toMB = (bytes) => `${Math.round(bytes / MB)}MB`;

/**
 * 每个进程当前/峰值的内存占用，拼成一行。
 *
 * `workingSetSize` / `peakWorkingSetSize` 的单位是 KB，`peak` 只有 Windows 有 ——
 * 峰值比当前值更重要：用户看到"8GB"往往是在任务管理器里看的瞬时值，而真正
 * 决定会不会被系统杀掉的是峰值有没有顶到物理内存。
 * @returns {string}
 */
const describeProcesses = () => {
  let metrics;
  try {
    metrics = app.getAppMetrics();
  } catch (error) {
    return 'unavailable';
  }
  return metrics.map((metric) => {
    const memory = metric.memory || {};
    const name = `${metric.type}#${metric.pid}`;
    if (typeof memory.workingSetSize !== 'number') {
      return `${name}=?`;
    }
    const current = Math.round(memory.workingSetSize * 1024 / MB);
    const peak = typeof memory.peakWorkingSetSize === 'number' ?
      Math.round(memory.peakWorkingSetSize * 1024 / MB) :
      null;
    // 峰值只在明显高于当前值时才有信息量，否则每行都拖一个重复数字。
    return peak !== null && peak > current ?
      `${name} ${current}MB(peak ${peak}MB)` :
      `${name} ${current}MB`;
  }).join(' | ');
};

/**
 * 读渲染进程的 V8 堆状况，外加编辑器上报的项目体积估算。
 *
 * 与 diagnostics.recordRendererHeap 用的是同一段堆探针，区别只在这里不写盘、
 * 只返回原始数字，供调用方自行组织日志（例如算 GC 前后的差值）。
 * `performance.memory` 在 Electron 43 上 `totalHeapSize` 可能缺失，所以解析后
 * 一律做类型检查 —— 老代码里那句 "total NaNMB" 就是没检查导致的。
 *
 * `__bilupProjectStats` 由渲染层在项目加载完成后写入（见
 * src-renderer-webpack/editor/gui/desktop-hoc.jsx）：角色/服装/声音数量，以及
 * **按未压缩尺寸估算的服装纹理与声音 PCM 字节数**。这一项是"8GB"里唯一能用
 * 数字说话的部分 —— 堆用量只覆盖 JS 对象，纹理和 AudioBuffer 都在堆外，
 * 不看这一项就看不出"这个作品本身需要多少内存"。
 * @param {Electron.WebContents|null|undefined} webContents
 * @returns {Promise<{limit: number, total: number, used: number, stats: object|null}|null>}
 */
const readRendererHeap = async (webContents) => {
  if (!webContents || webContents.isDestroyed()) {
    return null;
  }
  let raw;
  try {
    raw = await webContents.executeJavaScript(
      'JSON.stringify({' +
      'heap: (typeof performance !== "undefined" && performance.memory) ? {' +
      'limit: performance.memory.jsHeapSizeLimit,' +
      'total: performance.memory.totalHeapSize,' +
      'used: performance.memory.usedJSHeapSize' +
      '} : null,' +
      'stats: window.__bilupProjectStats || null' +
      '})',
      false
    );
  } catch (error) {
    // 渲染进程可能在采样瞬间崩溃或被导航走，这不算错误。
    return null;
  }

  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch (error) {
    return null;
  }
  if (!parsed || !parsed.heap || typeof parsed.heap.used !== 'number') {
    return null;
  }
  const stats = parsed.stats && typeof parsed.stats === 'object' ? parsed.stats : null;
  return {
    limit: typeof parsed.heap.limit === 'number' ? parsed.heap.limit : 0,
    total: typeof parsed.heap.total === 'number' ? parsed.heap.total : 0,
    used: parsed.heap.used,
    stats
  };
};

/**
 * 采一次完整快照并写进诊断日志。
 *
 * 不返回 Promise 的调用方也应该拿到结果，所以内部吞掉所有异常：
 * 采样本身出问题不能影响正在进行的加载/编辑。
 * @param {string} tag 采样点标签，例如 "project-loaded+20s"
 * @param {Electron.WebContents|null} [webContents] 该窗口的渲染进程
 * @returns {Promise<{used: number}|null>} 渲染进程堆状况，供调用方算差值
 */
const sample = async (tag, webContents) => {
  const heap = await readRendererHeap(webContents);
  const parts = [`processes: ${describeProcesses()}`];

  if (heap) {
    const limit = heap.limit > 0 ? toMB(heap.limit) : '?';
    parts.push(`renderer heap used=${toMB(heap.used)} limit=${limit}`);
  }

  if (heap && heap.stats) {
    const s = heap.stats;
    parts.push(
      `project sprites=${s.sprites || 0} costumes=${s.costumes || 0} ` +
      `textures≈${s.textureMB || 0}MB sounds=${s.sounds || 0} ` +
      `pcm≈${s.soundMB || 0}MB blocks=${s.blocks || 0}`
    );
  }

  try {
    parts.push(`sys free=${toMB(os.freemem())}/${toMB(os.totalmem())}`);
  } catch (error) {
    // 忽略：拿不到系统内存不影响其它字段。
  }
  try {
    parts.push(`main rss=${toMB(process.memoryUsage().rss)}`);
  } catch (error) {
    // 同上。
  }

  diagnostics.writeLine('mem', `${tag} | ${parts.join(' | ')}`);
  return heap;
};

/**
 * 在一个窗口的 `closed` 上挂清理，保证定时器不会比窗口活得久。
 *
 * 不清理的后果和 diagnostics.scheduleRendererHeapSample 里那段注释写的是同一件事：
 * 定时器闭包持有 BrowserWindow，窗口关了也释放不了。
 * @param {Electron.BrowserWindow} window
 * @param {NodeJS.Timeout} timer
 */
const tieToWindow = (window, timer) => {
  const clear = () => clearTimeout(timer);
  if (window && !window.isDestroyed()) {
    window.once('closed', clear);
  }
};

/**
 * 请求渲染进程做一次异步 full GC，并记录回收量。
 *
 * 为什么这一步值得单独做：打开大作品时峰值里有一大块是**已经没人引用的中间数据**——
 * JSZip 解压缓冲、每张位图解码时的临时 canvas、ProjectAssetLoad 里按素材 md5
 * 建的 image/sound promise 缓存。这些在加载结束后全是垃圾，但 V8 只在**需要**时
 * 才回收：桌面端把老生代上限放到了 4GB（见 index.js），于是"需要"这个条件
 * 要等到堆涨到很高才成立，任务管理器里看到的就是"打开一个作品常驻 8GB"。
 *
 * `gc({execution: 'async'})` 是非阻塞的：它把 GC 排进 V8 自己的任务队列，
 * 不卡界面（同步 `gc()` 在大堆上会有几百毫秒停顿）。需要 `--expose-gc`
 * （见 index.js 的 js-flags），没有就静默跳过 —— 这是个优化，不是功能前提。
 * @param {Electron.BrowserWindow} window
 * @returns {Promise<void>}
 */
const releaseTransients = async (window) => {
  if (!window || window.isDestroyed()) {
    return;
  }
  const webContents = window.webContents;
  if (!webContents || webContents.isDestroyed()) {
    return;
  }

  const before = await readRendererHeap(webContents);
  if (!before) {
    return;
  }

  let result;
  try {
    result = await webContents.executeJavaScript(`(() => {
      if (typeof gc !== 'function') return JSON.stringify({available: false});
      try {
        gc({type: 'major', execution: 'async'});
      } catch (error) {
        try {
          gc();
        } catch (inner) {
          return JSON.stringify({available: false, error: String(inner)});
        }
      }
      return JSON.stringify({available: true});
    })()`, false);
  } catch (error) {
    return;
  }

  let parsed;
  try {
    parsed = result ? JSON.parse(result) : null;
  } catch (error) {
    parsed = null;
  }
  if (!parsed || !parsed.available) {
    // 没开 --expose-gc（例如旧构建、或被 Electron 忽略）时只留一行说明。
    diagnostics.writeLine('mem', 'post-load gc unavailable (--expose-gc not active)');
    return;
  }

  setTimeout(() => {
    if (!window || window.isDestroyed()) {
      return;
    }
    readRendererHeap(window.webContents).then((after) => {
      if (!after) {
        return;
      }
      const released = before.used - after.used;
      diagnostics.writeLine(
        'mem',
        `post-load gc released ${toMB(Math.max(0, released))} ` +
        `(used ${toMB(before.used)} -> ${toMB(after.used)})`
      );
    }).catch(() => {});
  }, GC_SETTLE_MS);
};

/**
 * 项目数据已经交给渲染进程（见 windows/editor.js 的 get-file）后调用。
 *
 * 这条路径是内存涨得最猛的一次，所以固定采几个点，并且在这些点之间做一次
 * 主动回收。任何一步失败都只影响日志。
 * @param {Electron.BrowserWindow} window
 */
const afterProjectLoad = (window) => {
  if (!window || window.isDestroyed()) {
    return;
  }

  for (const delay of PROJECT_LOAD_SAMPLE_DELAYS_MS) {
    const timer = setTimeout(() => {
      if (!window || window.isDestroyed()) {
        return;
      }
      sample(`project-loaded+${delay / 1000}s`, window.webContents).catch(() => {});
    }, delay);
    tieToWindow(window, timer);
  }

  const gcTimer = setTimeout(() => {
    releaseTransients(window).catch(() => {});
  }, PROJECT_LOAD_GC_DELAY_MS);
  tieToWindow(window, gcTimer);
};

/**
 * 启用周期采样（需要 BILUP_MEMORY_TRACE）。
 *
 * 排障时用的是"打开同一个大作品 → 看曲线"，固定采样点只有三个，看不出
 * "改一处代码后峰值降了多少"之外的形状；周期采样能给出完整曲线。
 * 不在窗口 closed 之前停掉的话，定时器会一直跑（并且持有窗口）。
 * @param {Electron.BrowserWindow} window
 */
const startWindowTrace = (window) => {
  if (!TRACE_ENABLED || !window || window.isDestroyed()) {
    return;
  }

  sample('window-opened', window.webContents).catch(() => {});

  const timer = setInterval(() => {
    if (!window || window.isDestroyed()) {
      clearInterval(timer);
      return;
    }
    sample('tick', window.webContents).catch(() => {});
  }, TRACE_INTERVAL_MS);

  // 后台采样不应该拖住退出流程。
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  if (window && !window.isDestroyed()) {
    window.once('closed', () => clearInterval(timer));
  }
};

module.exports = {
  afterProjectLoad,
  isTraceEnabled: () => TRACE_ENABLED,
  sample,
  startWindowTrace
};
