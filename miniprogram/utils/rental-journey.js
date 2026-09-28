/**
 * 租赁订单展示层（订单页进度条 / 应还倒计时 / 卡片文案）。
 *
 * 背景：T37/T38 让用户能选租期下单，但订单页此前只认识售卖订单 ——
 * `orders.js` 把所有订单硬编码成 `type: 'E_BIKE'`，进度条因此走 `ebikeJourney`，
 * 租赁单会显示「商家确认履约 / 校内配送 / 凭交付码收车」这类**售卖文案**，
 * 而租赁的真实流程是「取车 → 租期中 → 申请归还 → 归还完成」。
 *
 * 为什么单独成模块（而不是塞进 `product-view.js`）：
 * - `product-view.js` 的职责是**商品展示**（列表卡片 / 详情页），输入是商品；
 * - 本模块的职责是**订单展示**，输入是订单（`orderKind` / `rental`），
 *   且只有一个消费方（订单页）。两者生命周期与数据源都不同，混在一起会让
 *   「商品」与「订单」两个概念互相污染。
 *
 * 为什么必须是**纯函数**：`orders.js` 顶层调用 `Page()`，在 Node 中加载会崩溃，
 * 页面内的分支没有任何运行时覆盖（只能做源码文本断言，而文本断言连注释都能满足）。
 * 把「第几步是当前步」「还差几天几小时」「能不能点申请归还」抽成纯函数，
 * 才能真正被 `test/miniapp-runtime.test.js` 断言。
 *
 * 约定：
 * - **缺省即售卖**：`orderKind` 缺失（存量订单）一律按售卖处理，绝不误判为租赁。
 * - **状态未知即降级**：`rental.status` 不在白名单时返回空进度条，**不猜**状态。
 * - **只读**：不访问 `wx` / `getApp` / `Page`，不修改入参。
 */

const { formatYuan, formatRentalDueAt, rentalUnitLabel, YUAN_EXACT_DIGITS } = require('./product-view');

/** 租赁订单形态标记（服务端 `order.orderKind`）。 */
const ORDER_KIND_RENTAL = 'RENTAL';

/** 租赁状态（服务端 `order.rental.status`）。 */
const RENTAL_STATUS = Object.freeze({
  RENTING: 'RENTING',
  RETURN_REQUESTED: 'RETURN_REQUESTED',
  RETURNED: 'RETURNED'
});

/**
 * 租赁进度条的 4 个步骤（与 `server/src/domain/rental.js` 的状态机一一对应）。
 *
 * @type {ReadonlyArray<{key: string, title: string, detail: string}>}
 */
const RENTAL_STEPS = Object.freeze([
  { key: 'PAID', title: '已支付待取车', detail: '凭交付码到校内取车点取车' },
  { key: 'RENTING', title: '租期中', detail: '按约定租期使用，留意归还时点' },
  { key: 'RETURN_REQUESTED', title: '申请归还', detail: '等待商家核验归还' },
  { key: 'RETURNED', title: '归还完成', detail: '押金将在核验后原路退回' }
]);

/**
 * 租赁状态 → 当前步下标。
 *
 * `RENTING` 时第 1 步（已支付待取车）已完成、第 2 步（租期中）为当前步。
 * 状态不在表里 ⇒ 返回 `undefined` ⇒ 降级为空进度条。
 *
 * @type {Readonly<Record<string, number>>}
 */
const RENTAL_STATUS_STEP_INDEX = Object.freeze({
  RENTING: 1,
  RETURN_REQUESTED: 2,
  RETURNED: 3
});

/**
 * 是否为租赁订单。
 *
 * `orderKind` 缺失（存量订单）或非 `'RENTAL'` 一律视为售卖。
 * 大小写与首尾空格做归一化，与 `product-view.js` 的 `normalizeListingType` 保持一致口径。
 *
 * @param {object|null|undefined} order 订单记录。
 * @returns {boolean} 是否租赁订单。
 */
function isRentalOrder(order) {
  if (!order) return false;
  const kind = typeof order.orderKind === 'string' ? order.orderKind.trim().toUpperCase() : '';
  return kind === ORDER_KIND_RENTAL;
}

/**
 * 取归一化后的租赁状态（大写、去空格）。
 *
 * @param {object|null|undefined} order 订单记录。
 * @returns {string} 状态字符串；无租赁信息返回空串。
 */
function rentalStatusOf(order) {
  const status = order && order.rental ? order.rental.status : '';
  return typeof status === 'string' ? status.trim().toUpperCase() : '';
}

/**
 * 构造租赁进度条。
 *
 * @param {object|null|undefined} order 订单记录（需 `orderKind === 'RENTAL'` 与 `rental.status`）。
 * @returns {Array<{key: string, title: string, detail: string, done: boolean, current: boolean}>}
 *   4 步进度条；非租赁或状态未知时返回空数组。
 */
function buildRentalJourney(order) {
  if (!isRentalOrder(order)) return [];
  const currentIndex = RENTAL_STATUS_STEP_INDEX[rentalStatusOf(order)];
  if (currentIndex === undefined) return [];
  return RENTAL_STEPS.map((step, index) => ({
    key: step.key,
    title: step.title,
    detail: step.detail,
    done: index < currentIndex,
    current: index === currentIndex
  }));
}

/**
 * 安全地把任意输入转成 `Date`。
 *
 * @param {unknown} value 日期 / ISO 字符串 / 时间戳。
 * @returns {Date|null} 合法 `Date`；非法返回 `null`。
 */
function toDate(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * 把「now」归一化为 `Date`。
 *
 * @param {Date|string|number} [now] 基准时间，缺省为当前时间。
 * @returns {Date} 合法 `Date`。
 */
function resolveNow(now) {
  return toDate(now) || new Date();
}

/**
 * 是否已逾期。
 *
 * @param {unknown} dueAt 应还时间。
 * @param {Date|string|number} [now] 基准时间。
 * @returns {boolean} 是否已到期/逾期。
 */
function isRentalOverdue(dueAt, now) {
  const due = toDate(dueAt);
  if (!due) return false;
  return due.getTime() <= resolveNow(now).getTime();
}

/**
 * 应还倒计时文案。
 *
 * - 未到期：`距应还还有 2 天 3 小时`
 * - 已逾期：`已逾期 5 小时`（**不含**「还有」）
 *
 * 不足 1 小时时退化为分钟，避免出现「还有 0 小时」这种无意义文案。
 *
 * @param {unknown} dueAt 应还时间（ISO 字符串 / 时间戳 / `Date`）。
 * @param {Date|string|number} [now] 基准时间，缺省为当前时间。
 * @returns {string} 倒计时文案；`dueAt` 非法时返回空串。
 */
function rentalCountdownText(dueAt, now) {
  const due = toDate(dueAt);
  if (!due) return '';
  const diffMs = due.getTime() - resolveNow(now).getTime();
  const overdue = diffMs <= 0;
  const totalMinutes = Math.floor(Math.abs(diffMs) / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0) parts.push(`${hours} 小时`);
  if (days === 0 && hours === 0) parts.push(`${Math.max(1, minutes)} 分钟`);
  return overdue ? `已逾期 ${parts.join(' ')}` : `距应还还有 ${parts.join(' ')}`;
}

/**
 * 租赁卡片文案（金额 / 租期 / 应还时间）。
 *
 * 精度口径沿用 `product-view.js` 的一致约定：
 * - 单位租金是**报价** ⇒ 整数元去尾零（`¥15/天`，不是 `¥15.00/天`）；
 * - 押金是**可退还、可被部分扣除的账** ⇒ 固定两位小数（`¥299.00`）。
 *
 * @param {object|null|undefined} order 订单记录。
 * @returns {{priceText: string, termText: string, depositText: string, dueAtText: string}|null}
 *   文案对象；非租赁返回 `null`。
 */
function rentalCardText(order) {
  if (!isRentalOrder(order) || !order.rental) return null;
  const rental = order.rental;
  const units = Math.max(0, Math.round(Number(rental.units) || 0));
  const rentAmountInCents = Math.max(0, Math.round(Number(rental.rentAmountInCents) || 0));
  // 服务端只下发整项租金，单位租金由其还原（`buildRentalOrderItem` 注释里明确说过可还原）。
  const unitRentInCents = units > 0 ? Math.round(rentAmountInCents / units) : 0;
  const unitLabel = rentalUnitLabel(rental.unit);
  const due = toDate(rental.dueAt);
  // 已归还的订单不再展示「应还时间」：车已还、账已结，再显示「…前归还」只会误导。
  const showDue = rentalStatusOf(order) !== RENTAL_STATUS.RETURNED;
  return {
    priceText: `¥${formatYuan(unitRentInCents)}/${unitLabel}`,
    termText: units > 0 ? `共 ${units} ${unitLabel}` : '',
    depositText: `¥${formatYuan(Math.max(0, Math.round(Number(rental.depositInCents) || 0)), YUAN_EXACT_DIGITS)}`,
    dueAtText: due && showDue ? formatRentalDueAt(due) : ''
  };
}

/**
 * 「申请归还」按钮的显示条件。
 *
 * 只有**租赁单**且状态为 `RENTING` 才可申请归还：
 * `RETURN_REQUESTED`（已申请）与 `RETURNED`（已归还）再点都是重复提交。
 *
 * @param {object|null|undefined} order 订单记录。
 * @returns {boolean} 是否显示「申请归还」。
 */
function canRequestReturn(order) {
  return isRentalOrder(order) && rentalStatusOf(order) === RENTAL_STATUS.RENTING;
}

/**
 * 订单页倒计时定时器是否需要继续刷新。
 *
 * 订单页的定时器原来只服务「待支付订单」，`refreshCountdowns` 在没有待支付订单时
 * 直接 `return` —— 租赁的应还倒计时因此**永远不会刷新**。
 * 这个谓词把「是否还有需要走秒的东西」显式化，租赁单（未归还且有应还时间）也算数。
 *
 * @param {Array<object>} [records] 订单记录列表。
 * @returns {boolean} 是否需要继续刷新。
 */
function shouldRefreshCountdown(records) {
  const list = Array.isArray(records) ? records : [];
  return list.some((item) => {
    if (!item) return false;
    if (item.status === 'PENDING_PAYMENT' && item.paymentExpiresAt) return true;
    return isRentalOrder(item)
      && rentalStatusOf(item) !== RENTAL_STATUS.RETURNED
      && Boolean(item.rental && item.rental.dueAt);
  });
}

/**
 * 订单进度条的唯一选择点：租赁走租赁进度条，售卖保持原有口径。
 *
 * 为什么把「选择」也抽成纯函数：这样「租赁单不会误走售卖进度条」与
 * 「售卖单仍走 `ebikeJourney`」这两件事都能被**运行时**断言，
 * 而不是只能在页面源码里 grep `ebikeJourney`。
 *
 * `ebikeJourney` / `afterSaleJourney` 由调用方注入（仍归 `orders.js` 所有），
 * 本模块不复制售卖文案，避免两处维护同一份文案。
 *
 * @param {object} [options] 入参。
 * @param {object|null} [options.order] 订单记录。
 * @param {boolean} [options.isEbike] 是否电瓶车订单（沿用页面既有的 `type === 'E_BIKE'`）。
 * @param {string} [options.status] 订单状态。
 * @param {object|null} [options.activeAfterSale] 进行中的售后记录。
 * @param {object} [options.ebikeJourney] 售卖进度条文案表。
 * @param {object} [options.afterSaleJourney] 售后进度条文案表。
 * @returns {Array<object>} 进度条步骤数组。
 */
function selectOrderJourney(options = {}) {
  const { order, isEbike, status, activeAfterSale, ebikeJourney, afterSaleJourney } = options;
  if (isRentalOrder(order)) return buildRentalJourney(order);
  if (!isEbike) return [];
  if (activeAfterSale && activeAfterSale.status !== 'CLOSED') {
    return (afterSaleJourney && afterSaleJourney[activeAfterSale.status]) || [];
  }
  return (ebikeJourney && ebikeJourney[status]) || [];
}

module.exports = {
  ORDER_KIND_RENTAL,
  RENTAL_STATUS,
  RENTAL_STEPS,
  isRentalOrder,
  rentalStatusOf,
  buildRentalJourney,
  isRentalOverdue,
  rentalCountdownText,
  rentalCardText,
  canRequestReturn,
  shouldRefreshCountdown,
  selectOrderJourney
};
