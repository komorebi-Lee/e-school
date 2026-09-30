/**
 * 分块加载的三态工具（loading / error / data）。
 *
 * ## 为什么需要这个模块
 *
 * 改造前，页面里散落着 19 处空 catch（`.catch` 后面接一个空函数体）——
 * 接口失败时**什么都不发生**：
 * 没有错误提示、没有重试入口，数据保持空白或陈旧。更危险的是另一类写法
 * （`forum.js` / `market.js`）在失败时 `setData({ posts: [] })`，
 * 用户会**相信一个错误的结论**：「确实没有帖子」。
 *
 * 本模块把「一块数据的加载状态」显式化，并钉死三条约定：
 *
 * 1. **失败绝不清空数据** —— `rejectBlock` 把 `prev` 原样带回。
 *    旧数据比「假装没有数据」有用得多：用户可以继续看上次的列表，
 *    只是顶部多一条「加载失败，点击重试」。清空数据是在**制造一个假事实**。
 * 2. **错误态必须可见且可重试** —— 由调用方渲染错误占位（文案 + 重试按钮），
 *    而不是 toast。toast 会消失，用户回头就不知道发生了什么。
 * 3. **块之间互相独立** —— 一个块失败不能让其他块也进入错误态。
 *    这是 PRD T28 的核心要求：一个接口挂掉不该拖垮整页。
 *
 * ## 块形状
 *
 * ```js
 * { loading: boolean, error: string, data?: unknown }
 * ```
 *
 * `data` 只有加载成功过才存在。`error` 非空即表示「当前展示的是失败态」。
 *
 * ## 纯函数 + 一个薄包装
 *
 * `initialBlock` / `initialListBlock` / `beginBlock` / `resolveBlock` / `rejectBlock` /
 * `blockErrorText` 都是纯函数，可以在 Node 里真实断言；`loadBlock` 是唯一的薄包装，
 * 它只依赖注入进来的 `setData`，不访问 `wx`。
 *
 * 本模块不访问 `wx` / `getApp` / `Page`，不修改入参。
 */

/** 拿不到可读文案时的兜底提示。 */
const DEFAULT_ERROR_TEXT = '加载失败，请重试';

/**
 * 错误文案上限（字符）。
 *
 * 为什么必须截断：错误占位是**单行**展示区，而 `error.message` 可能很长
 * （后端堆栈、SQL 片段、整段 HTML 错误页）。不截断会把布局撑爆，
 * 反而让「重试」按钮被挤出屏幕 —— 修静默失败的初衷就落空了。
 */
const MAX_ERROR_TEXT_LENGTH = 60;

/**
 * 初始块状态：加载中、无错误、无数据。
 *
 * @returns {{loading: boolean, error: string}} 初始块状态。
 */
function initialBlock() {
  return { loading: true, error: '' };
}

/**
 * 初始「列表」块：加载中、无错误、**数据为空数组**。
 *
 * 为什么列表块必须显式给 `data: []`（而不是用 {@link initialBlock}）：
 *
 * `rejectBlock` 的「不清空」是靠把 `prev.data` 原样带回实现的 —— 也就是说，
 * 只有 `prev` **有** `data` 时它才带得回来。若初始块没有 `data` 字段，
 * 那么「首次加载就失败」之后，块里依旧没有 `data`。于是模板里的
 * `xxx.data.length` 会取到 `undefined`，而 `undefined` 在 `wx:if` 里是假值 ——
 * **「失败」被渲染成了「空列表」**，正是本次要消灭的那个误导。
 *
 * 给一个空数组兜底后，模板层可以永远这样区分三态：
 *
 * ```html
 * <view wx:if="{{xxx.loading && !xxx.data.length}}">加载中…</view>
 * <view wx:elif="{{!xxx.data.length && !xxx.error}}">暂无数据</view>
 * <view wx:else>列表</view>
 * ```
 *
 * @returns {{loading: boolean, error: string, data: Array}} 初始列表块状态。
 */
function initialListBlock() {
  return { ...initialBlock(), data: [] };
}

/**
 * 进入「加载中」状态（重试时复用）。
 *
 * **保留 `prev` 上的数据字段**：重试期间旧列表继续可见，
 * 不会因为「刷新」而闪成空白。
 *
 * @param {{loading?: boolean, error?: string, data?: unknown}} [prev] 上一次的块状态。
 * @returns {{loading: boolean, error: string}} 进入加载中的块状态。
 */
function beginBlock(prev) {
  const base = prev && typeof prev === 'object' ? prev : {};
  return { ...base, loading: true, error: '' };
}

/**
 * 进入「加载成功」状态。
 *
 * @param {{loading?: boolean, error?: string, data?: unknown}} [prev] 上一次的块状态。
 * @returns {{loading: boolean, error: string}} 成功块状态。
 */
function resolveBlock(prev) {
  const base = prev && typeof prev === 'object' ? prev : {};
  return { ...base, loading: false, error: '' };
}

/**
 * 进入「加载失败」状态。
 *
 * ★ **不清空数据**：`prev` 上的数据字段原样带回。这是本模块的核心约定 ——
 * 失败时清空列表等于告诉用户「这里本来就没有东西」，而事实是「我们没取到」。
 * 两者对用户的意义完全不同。
 *
 * @param {unknown} error 捕获到的错误（通常带 `message`）。
 * @param {{loading?: boolean, error?: string, data?: unknown}} [prev] 上一次的块状态。
 * @returns {{loading: boolean, error: string}} 失败块状态（含 `prev` 的数据字段）。
 */
function rejectBlock(error, prev) {
  const base = prev && typeof prev === 'object' ? prev : {};
  return { ...base, loading: false, error: blockErrorText(error) };
}

/**
 * 从任意错误对象里提取可读文案，并做长度截断。
 *
 * @param {unknown} error 捕获到的错误。
 * @returns {string} 可读文案；无法提取时返回 {@link DEFAULT_ERROR_TEXT}。
 */
function blockErrorText(error) {
  const raw = error && typeof error.message === 'string' ? error.message.trim() : '';
  const text = raw || DEFAULT_ERROR_TEXT;
  if (text.length <= MAX_ERROR_TEXT_LENGTH) return text;
  return `${text.slice(0, MAX_ERROR_TEXT_LENGTH - 1)}…`;
}

/**
 * 加载一个数据块：统一 `beginBlock` → `loader()` → `resolveBlock` / `rejectBlock`。
 *
 * 成功时把 `loader` 的解析值写进块状态的 `data`；失败时**只**更新状态字段，
 * 数据字段由 `prev` 原样带回（见 {@link rejectBlock}）。
 *
 * **本函数不 rethrow**：失败已经落成可见的状态字段，调用方不需要再包一层
 * `.catch` —— 那正是改造前 19 处空 catch 的来源。需要判断成败请看
 * `data[stateKey].error`。
 *
 * @param {object} options 入参。
 * @param {Function} options.setData 页面注入的 `setData`（需已绑定 this）。
 * @param {string} options.stateKey 块状态在 `data` 上的键，如 `'blocks.trend'`。
 * @param {Function} options.loader 返回 Promise 的加载函数，解析值即该块的数据。
 * @param {object} [options.prev] 该块上一次的状态（用于保留旧数据）。
 * @returns {Promise<unknown>} 成功时解析为数据；失败时解析为 `undefined`。
 * @throws {TypeError} 入参不合法（缺 `setData` / `stateKey` / `loader`）。
 */
function loadBlock(options = {}) {
  const { setData, stateKey, loader, prev } = options;
  if (typeof setData !== 'function') throw new TypeError('loadBlock 需要 setData 函数');
  if (typeof stateKey !== 'string' || !stateKey) throw new TypeError('loadBlock 需要非空 stateKey');
  if (typeof loader !== 'function') throw new TypeError('loadBlock 需要 loader 函数');

  // 进入加载中：保留 prev 上的数据，重试期间旧内容不闪白。
  setData({ [stateKey]: beginBlock(prev) });

  return Promise.resolve()
    .then(() => loader())
    .then((data) => {
      setData({ [stateKey]: { ...resolveBlock(prev), data } });
      return data;
    })
    .catch((error) => {
      // ★ 失败路径只写状态字段；`rejectBlock` 会把 prev 的数据字段原样带回，
      // 所以这里**不会**清空任何数据。这是本模块最容易被改坏的一行。
      setData({ [stateKey]: rejectBlock(error, prev) });
      return undefined;
    });
}

module.exports = {
  DEFAULT_ERROR_TEXT,
  MAX_ERROR_TEXT_LENGTH,
  initialBlock,
  initialListBlock,
  beginBlock,
  resolveBlock,
  rejectBlock,
  blockErrorText,
  loadBlock
};
