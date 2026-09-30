/**
 * 订单文案格式化（当前：待支付倒计时分级）。
 *
 * ## 为什么单独成模块
 *
 * 待支付订单会占用库存、超时后服务端自动关闭。倒计时文案是用户判断
 * 「要不要现在付」的**唯一**依据，它的分级必须能被断言 —— 而不是埋在
 * `orders.js` 里：页面顶层调用 `Page()`，Node 无法加载，页内分支只能做
 * 源码文本断言，而文本断言连注释都能满足（同类说明见 `rental-journey.js`）。
 *
 * ## 分级口径
 *
 * | 剩余时间 | 文案 |
 * | --- | --- |
 * | `> 60 分钟` | `请在 X 小时 Y 分钟内完成支付` |
 * | `5 分钟 ~ 60 分钟` | `请在 X 分钟内完成支付，超时自动取消` |
 * | `< 5 分钟` | `请在 X 分 Y 秒内完成支付`；`X === 0` 时写作 `请在 Y 秒内完成支付` |
 * | `≤ 0` | `支付已超时，刷新后订单将关闭` |
 *
 * 为什么 5 分钟以内精确到秒：这是「还能再想想」与「现在就得点」的分界。
 * 分钟粒度在最后 60 秒里会一直显示「1 分钟」，用户盯着一个不动的数字，
 * 反而会以为页面卡死了。
 *
 * ## 约定
 *
 * - **只读**：不访问 `wx` / `getApp` / `Page`，不修改入参。
 * - **`now` 可注入**：三个函数都接受可选的 `now` 基准时间。否则「文案随时间变化」
 *   这件事无法被断言 —— 只能等到真的走到那个时间点。
 * - **非法输入不猜**：`expiresAt` 缺失或非法时，文案返回空串、判定返回 `false`，
 *   与改造前 `orders.js` 内的同名函数口径一致。把「拿不到时间」说成「已超时」
 *   会直接误导用户去重新下单。
 *
 * ## 范围说明
 *
 * 本模块当前只服务待支付倒计时。卡片里的其它日期文案（`formatDueText`）仍随
 * `card()` 留在 `order-card.js` —— 它只被卡片装饰消费，没有第二个调用方。
 * 等它出现第二个消费方时再上移，避免现在就为一个假想的复用把模块切碎。
 */

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * 「紧急」阈值：剩余 ≤5 分钟。
 *
 * 边界取**闭区间**（恰好剩 5:00 也算紧急）：这一档的作用是提前把刷新节奏切到
 * 秒级。宁可早一秒进入，也不要晚一秒 —— 晚的代价是用户错过支付时限。
 *
 * @type {number}
 */
const PAYMENT_URGENT_MS = 5 * MINUTE_MS;

/**
 * 「小时档」阈值：剩余 ≥60 分钟。
 *
 * @type {number}
 */
const PAYMENT_HOUR_MS = 60 * MINUTE_MS;

/** 倒计时已归零时的文案。 */
const PAYMENT_EXPIRED_TEXT = '支付已超时，刷新后订单将关闭';

/**
 * 把任意输入安全地转成毫秒时间戳。
 *
 * @param {unknown} value ISO 字符串 / 时间戳 / `Date`。
 * @returns {number} 毫秒时间戳；缺失或非法返回 `NaN`。
 */
function toTimestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (value === undefined || value === null || value === '') return NaN;
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : NaN;
}

/**
 * 把「now」归一化为毫秒时间戳。
 *
 * @param {Date|string|number} [now] 基准时间，缺省为当前时间。
 * @returns {number} 毫秒时间戳。
 */
function resolveNowTimestamp(now) {
  const time = toTimestamp(now === undefined ? Date.now() : now);
  return Number.isFinite(time) ? time : Date.now();
}

/**
 * 待支付倒计时文案（分级）。
 *
 * - `≤ 0`：`支付已超时，刷新后订单将关闭`
 * - `< 5 分钟`：`请在 X 分 Y 秒内完成支付`（`X === 0` 时省略「0 分」，写作 `请在 Y 秒内完成支付`）
 * - `< 60 分钟`：`请在 X 分钟内完成支付，超时自动取消`
 * - 其余：`请在 X 小时 Y 分钟内完成支付`
 *
 * @param {unknown} expiresAt 支付截止时间（ISO 字符串 / 时间戳 / `Date`）。
 * @param {Date|string|number} [now] 基准时间，缺省为当前时间。
 * @returns {string} 倒计时文案；`expiresAt` 缺失或非法时返回空串。
 */
function paymentCountdownText(expiresAt, now) {
  const expires = toTimestamp(expiresAt);
  if (!Number.isFinite(expires)) return '';
  const remainMs = expires - resolveNowTimestamp(now);
  if (remainMs <= 0) return PAYMENT_EXPIRED_TEXT;
  // 秒档：最后 5 分钟，文案必须含秒，否则数字长时间不动会被当成卡死。
  if (remainMs < PAYMENT_URGENT_MS) {
    const minutes = Math.floor(remainMs / MINUTE_MS);
    const seconds = Math.floor((remainMs % MINUTE_MS) / SECOND_MS);
    // 不足 1 分钟时省略「0 分」：「请在 0 分 30 秒内完成支付」读起来不自然，
    // 而这一档恰恰是用户最紧张、最需要一眼读懂的时候。
    return minutes > 0 ? `请在 ${minutes} 分 ${seconds} 秒内完成支付` : `请在 ${seconds} 秒内完成支付`;
  }
  if (remainMs < PAYMENT_HOUR_MS) {
    return `请在 ${Math.floor(remainMs / MINUTE_MS)} 分钟内完成支付，超时自动取消`;
  }
  const totalMinutes = Math.floor(remainMs / MINUTE_MS);
  return `请在 ${Math.floor(totalMinutes / 60)} 小时 ${totalMinutes % 60} 分钟内完成支付`;
}

/**
 * 是否进入「紧急」档（剩余 `≤5 分钟` 且 `>0`）。
 *
 * 已超时（`≤0`）返回 `false`：超时是另一条链路（文案换成「支付已超时」并触发
 * 刷新），不需要再走秒级高亮。
 *
 * @param {unknown} expiresAt 支付截止时间。
 * @param {Date|string|number} [now] 基准时间，缺省为当前时间。
 * @returns {boolean} 是否紧急。
 */
function isPaymentUrgent(expiresAt, now) {
  const expires = toTimestamp(expiresAt);
  if (!Number.isFinite(expires)) return false;
  const remainMs = expires - resolveNowTimestamp(now);
  return remainMs > 0 && remainMs <= PAYMENT_URGENT_MS;
}

/**
 * 是否已超时（支付截止时间已到）。
 *
 * 与 {@link paymentCountdownText} 的超时判定**同源**：同一 `now` 下
 * 「文案是超时文案」与「判定为已超时」必须同时成立，否则页面会出现
 * 「显示还有 0 分 0 秒」却不去刷新的空转状态。
 *
 * @param {unknown} expiresAt 支付截止时间。
 * @param {Date|string|number} [now] 基准时间，缺省为当前时间。
 * @returns {boolean} 是否已超时。
 */
function isPaymentExpired(expiresAt, now) {
  const expires = toTimestamp(expiresAt);
  if (!Number.isFinite(expires)) return false;
  return expires <= resolveNowTimestamp(now);
}

module.exports = {
  SECOND_MS,
  MINUTE_MS,
  HOUR_MS,
  PAYMENT_URGENT_MS,
  PAYMENT_HOUR_MS,
  PAYMENT_EXPIRED_TEXT,
  paymentCountdownText,
  isPaymentUrgent,
  isPaymentExpired
};
