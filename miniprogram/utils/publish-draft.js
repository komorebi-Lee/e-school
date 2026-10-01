/**
 * 发布页草稿：表单规则 + 草稿持久化。
 *
 * ## 为什么单独一个模块
 *
 * 「草稿」是 `market/publish` 与 `forum/publish` 共用的概念，两页的规则也几乎一致
 * （字段上限、空草稿判定、容错读写）。若埋在各自页面里就会有两份实现 ——
 * 而两份实现迟早漂移。抽成纯函数模块后，序列化 / 反序列化 / 校验都能在 Node 里
 * 真实断言，不必依赖页面生命周期（页面脚本依赖 `Page()`，Node 里跑不起来）。
 *
 * ## ★ 图片：这里存的是**服务端 URL**，不是临时文件路径
 *
 * 两个页面的 `chooseImage()` 在 `wx.chooseMedia` 成功的回调里**立刻上传**
 * （`utils/upload.js` → `POST /api/uploads`），只把返回的
 * `/api/uploads/<uuid>.<ext>` 存进 `data.images`。临时文件路径从未被保留过。
 *
 * 这一点由**服务端契约**决定：`POST /api/market/items` 与 `POST /api/forum/posts`
 * 都会对 `!image.startsWith('/api/uploads/')` 的图片直接 400
 * （「图片必须来自平台上传目录」）。因此：
 *
 * - 把 `images` 随草稿保存 → 恢复后图片**真的能用**（服务端磁盘上的持久文件）；
 * - 若改成保存临时路径 → 服务端 400，且微信会在会话结束后清理临时文件，
 *   恢复出来就是一堆裂图 —— 那正是「向用户断言假事实」。
 *
 * `normalizeImages` 因此会**过滤掉**任何非 `/api/uploads/` 开头的项：
 * 草稿里混进别的形状只会在提交时变成一个 400，不如提前挡掉。
 *
 * ## 字段上限与服务端逐条对齐
 *
 * `FIELD_LIMITS` 的每个数字都对应 `server/src/app.js` 里一处 `requireString` 的
 * `maxLength`，价格区间对应 `priceInCents > 0 && <= 10000000`。
 * 前端计数若与服务端口径不同，就会出现「界面显示 60/60 但服务端说太长」——
 * 所以计数用的是**和服务端同一个表达式**：`String.prototype.length`（UTF-16 码元数），
 * 不是「字符数」也不是「码点数」。
 *
 * ## 失败一律不抛，但**绝不静默**
 *
 * 草稿是**辅助**能力：读不到、写不进都不该拦住用户发布，所以本模块对外不抛异常。
 * 但每个 catch 块内都写明了「为什么忽略是安全的」，且写操作**返回布尔值**
 * 供调用方决定是否提示 —— 忽略可以，但必须是**显式的**决定
 * （与全仓 `loadState.ignoreSilently` 同一原则）。
 */

/** 两页的草稿存储键。 */
const DRAFT_KEYS = {
  MARKET: 'campusGoMarketDraft',
  FORUM: 'campusGoForumDraft'
};

/**
 * 各页字段上限，逐条对应 `server/src/app.js` 的 `requireString(..., { maxLength })`。
 *
 * - market.title → 60、market.description → 500、market.contact → 50
 * - forum.title → 60、forum.content → 1000
 *
 * `priceInput` 的 20 不是服务端约束（服务端收的是 `priceInCents`），
 * 纯粹是防御一个畸长的字符串被写进 Storage。
 */
const FIELD_LIMITS = {
  market: { title: 60, description: 500, contact: 50, priceInput: 20 },
  forum: { title: 60, content: 1000 }
};

/** 价格区间（元），对应服务端 `priceInCents > 0 && priceInCents <= 10000000`。 */
const PRICE_MIN_YUAN = 0.01;
const PRICE_MAX_YUAN = 100000;
const PRICE_MIN_CENTS = 1;
const PRICE_MAX_CENTS = 10000000;

/** 图片张数上限，对应服务端 `images.slice(0, N)`。 */
const IMAGE_LIMITS = { market: 6, forum: 3 };

/** 服务端要求的图片 URL 前缀。 */
const UPLOAD_URL_PREFIX = '/api/uploads/';

/** 空草稿哨兵：见 {@link clearDraft} 的「第二道防线」。 */
const EMPTY_DRAFT = {
  title: '',
  description: '',
  contact: '',
  content: '',
  priceInput: '',
  category: '',
  condition: '',
  board: '',
  images: []
};

/**
 * 把任意值收敛成字符串。
 *
 * @param {*} value 任意值。
 * @returns {string} 字符串；非字符串一律返回空串。
 */
function textOf(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * 截断到上限。
 *
 * 为什么是**截断**而不是丢弃整份草稿：截断保留用户尽可能多的内容，
 * 同时保证「界面上显示的」与「提交时会发出去的」是同一个值。
 * 若只截展示、不截数据，就会重现 T21 那个「显示与数据不一致」的缺陷。
 *
 * @param {*} value 原始值。
 * @param {number} maxLength 上限（UTF-16 码元数）。
 * @returns {string} 截断后的字符串。
 */
function clampText(value, maxLength) {
  const text = textOf(value);
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

/**
 * 计算字数计数（与服务端 `requireString` 同一口径）。
 *
 * @param {*} value 输入值。
 * @param {number} maxLength 上限。
 * @returns {{length: number, maxLength: number, over: boolean, text: string}} 计数结果。
 */
function countText(value, maxLength) {
  const length = textOf(value).length;
  return {
    length,
    maxLength,
    over: length > maxLength,
    text: `${length}/${maxLength}`
  };
}

/**
 * 过滤并截断图片 URL 列表。
 *
 * 只保留 `/api/uploads/` 开头的项：服务端对其它形状一律 400，提前挡掉比
 * 让用户在提交时吃一个 400 更好。同时保证恢复出来的图片**真的能渲染**。
 *
 * @param {*} value 原始 images。
 * @param {number} maxCount 张数上限。
 * @returns {string[]} 合法图片 URL。
 */
function normalizeImages(value, maxCount) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string' && item.startsWith(UPLOAD_URL_PREFIX))
    .slice(0, maxCount);
}

/**
 * 价格输入校验。
 *
 * 与服务端 `Math.round(Number(body.priceInCents))` 后的
 * `!Number.isFinite || <= 0 || > 10000000` 判定同源，只是这里从「元」出发。
 *
 * **空输入返回空串**（不是错误）：未填写不算「填错了」，提交时由 `submit()` 兜底提示。
 * 这样按钮不会在用户还没开始填时就被置灰。
 *
 * @param {*} input 价格输入框的原始值。
 * @returns {string} 错误文案；合法或未填写时为空串。
 */
function priceErrorOf(input) {
  const raw = textOf(input).trim();
  if (!raw) return '';
  const cents = Math.round(Number(raw) * 100);
  if (!Number.isFinite(cents)) return '请输入有效的价格数字';
  if (cents < PRICE_MIN_CENTS || cents > PRICE_MAX_CENTS) {
    return `价格需在 ${PRICE_MIN_YUAN} 元到 ${PRICE_MAX_YUAN} 元之间`;
  }
  return '';
}

/**
 * 把价格输入换算成分（与服务端同源）。
 *
 * @param {*} input 价格输入框的原始值。
 * @returns {number} 分；无法换算时为 `NaN`。
 */
function priceInCentsOf(input) {
  return Math.round(Number(textOf(input).trim()) * 100);
}

/**
 * 从页面 data 里取出要持久化的市场草稿。
 *
 * @param {object} data 页面 `this.data`。
 * @returns {object} 草稿对象。
 */
function marketDraftOf(data = {}) {
  return {
    title: clampText(data.title, FIELD_LIMITS.market.title),
    description: clampText(data.description, FIELD_LIMITS.market.description),
    contact: clampText(data.contact, FIELD_LIMITS.market.contact),
    priceInput: clampText(data.priceInput, FIELD_LIMITS.market.priceInput),
    category: textOf(data.selectedCategory && data.selectedCategory.key),
    condition: textOf(data.selectedCondition && data.selectedCondition.key),
    images: normalizeImages(data.images, IMAGE_LIMITS.market)
  };
}

/**
 * 从页面 data 里取出要持久化的论坛草稿。
 *
 * @param {object} data 页面 `this.data`。
 * @returns {object} 草稿对象。
 */
function forumDraftOf(data = {}) {
  return {
    title: clampText(data.title, FIELD_LIMITS.forum.title),
    content: clampText(data.content, FIELD_LIMITS.forum.content),
    board: textOf(data.selectedBoard && data.selectedBoard.key),
    images: normalizeImages(data.images, IMAGE_LIMITS.forum)
  };
}

/**
 * 归一化市场草稿（从 Storage 读出来的任意形状 → 可信形状）。
 *
 * @param {*} raw Storage 里的原始值。
 * @returns {object|null} 归一化后的草稿；非对象时返回 `null`。
 */
function normalizeMarketDraft(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return {
    title: clampText(raw.title, FIELD_LIMITS.market.title),
    description: clampText(raw.description, FIELD_LIMITS.market.description),
    contact: clampText(raw.contact, FIELD_LIMITS.market.contact),
    priceInput: clampText(raw.priceInput, FIELD_LIMITS.market.priceInput),
    category: textOf(raw.category),
    condition: textOf(raw.condition),
    images: normalizeImages(raw.images, IMAGE_LIMITS.market)
  };
}

/**
 * 归一化论坛草稿。
 *
 * @param {*} raw Storage 里的原始值。
 * @returns {object|null} 归一化后的草稿；非对象时返回 `null`。
 */
function normalizeForumDraft(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return {
    title: clampText(raw.title, FIELD_LIMITS.forum.title),
    content: clampText(raw.content, FIELD_LIMITS.forum.content),
    board: textOf(raw.board),
    images: normalizeImages(raw.images, IMAGE_LIMITS.forum)
  };
}

/**
 * 市场草稿是否「空」。
 *
 * 分类 / 成色**不算内容**：它们有默认值，永远非空，若计入则「进页面就退出」
 * 也会被当成有草稿，从而覆盖掉上一次的有效草稿（正是要避免的情形）。
 *
 * @param {object|null} draft 草稿。
 * @returns {boolean} 是否为空。
 */
function isEmptyMarketDraft(draft) {
  if (!draft) return true;
  return !draft.title && !draft.description && !draft.contact && !draft.priceInput
    && !(draft.images || []).length;
}

/**
 * 论坛草稿是否「空」。
 *
 * @param {object|null} draft 草稿。
 * @returns {boolean} 是否为空。
 */
function isEmptyForumDraft(draft) {
  if (!draft) return true;
  return !draft.title && !draft.content && !(draft.images || []).length;
}

/**
 * 读草稿。
 *
 * @param {string} key 存储键。
 * @param {Function} normalize 归一化函数，入参为 Storage 原始值。
 * @returns {object|null} 归一化后的草稿；读不到或读取失败时返回 `null`。
 */
function readDraft(key, normalize) {
  try {
    return normalize(wx.getStorageSync(key));
  } catch (error) {
    // 读取失败一律当作「没有草稿」。草稿是辅助能力，读不到不该拦住用户发布；
    // 而且此处页面尚未渲染完，也没有可用的位置提示。归一化函数本身也不抛
    // （非对象一律返回 null），所以这里覆盖的是 `getStorageSync` 自身抛错。
    return null;
  }
}

/**
 * 写草稿。
 *
 * @param {string} key 存储键。
 * @param {object} draft 草稿内容。
 * @returns {boolean} 是否写入成功。
 */
function writeDraft(key, draft) {
  try {
    wx.setStorageSync(key, draft);
    return true;
  } catch (error) {
    // `setStorageSync` 可能因配额耗尽 / 隐私模式而抛错。草稿是辅助能力，
    // 写不进去不该打断用户的发布流程；返回值交给调用方决定是否提示。
    // 注意：调用点在 `onHide` / `onUnload` 里，那时页面已不可见，弹 toast 没有意义，
    // 所以页面侧选择不提示 —— 这是**显式**的取舍，不是漏处理。
    return false;
  }
}

/**
 * 清草稿。
 *
 * @param {string} key 存储键。
 * @returns {boolean} 是否清理成功。
 */
function clearDraft(key) {
  try {
    wx.removeStorageSync(key);
    return true;
  } catch (error) {
    // ★ 清理失败不能就这么算了：残留的草稿会在下次进页面时被恢复成
    // 「已发布的内容」，用户会以为上次发布失败而再发一次 —— 重复发布。
    // 所以退一步写入一个**空草稿**：`isEmptyMarketDraft` / `isEmptyForumDraft`
    // 会把它判成「没有草稿」，恢复逻辑因此不会生效。这是第二道防线。
    return writeDraft(key, EMPTY_DRAFT);
  }
}

module.exports = {
  DRAFT_KEYS,
  FIELD_LIMITS,
  IMAGE_LIMITS,
  PRICE_MIN_YUAN,
  PRICE_MAX_YUAN,
  PRICE_MIN_CENTS,
  PRICE_MAX_CENTS,
  UPLOAD_URL_PREFIX,
  EMPTY_DRAFT,
  textOf,
  clampText,
  countText,
  normalizeImages,
  priceErrorOf,
  priceInCentsOf,
  marketDraftOf,
  forumDraftOf,
  normalizeMarketDraft,
  normalizeForumDraft,
  isEmptyMarketDraft,
  isEmptyForumDraft,
  readDraft,
  writeDraft,
  clearDraft
};
