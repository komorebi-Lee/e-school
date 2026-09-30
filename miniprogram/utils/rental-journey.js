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
 * - **未支付即未开始**：`PENDING_PAYMENT` 渲染流程但一步都不点亮，
 *   绝不把「已支付待取车」标成已完成（服务端租期从**支付成功**起算）。
 * - **状态未知即降级**：`rental.status` 不在白名单时返回空进度条，**不猜**状态。
 * - **只读**：不访问 `wx` / `getApp` / `Page`，不修改入参。
 */

const { formatYuan, formatRentalDueAt, rentalUnitLabel, YUAN_EXACT_DIGITS } = require('./product-view');

/** 租赁订单形态标记（服务端 `order.orderKind`）。 */
const ORDER_KIND_RENTAL = 'RENTAL';

/** 租赁状态（服务端 `order.rental.status`）。 */
const RENTAL_STATUS = Object.freeze({
  /** 已建单、未支付：租期尚未起算（服务端建单时的初始状态）。 */
  PENDING_PAYMENT: 'PENDING_PAYMENT',
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
 * 租期尚未起算的状态：进度条照常渲染，但**一步都不点亮**。
 *
 * 为什么不返回空数组：空数组在本模块的语义是「这不是租赁单 / 状态无法识别」，
 * 与售卖单的返回值完全一样。若未支付租赁单也返回空数组，订单页就再也分不出
 * 「待支付的租赁单」和「普通售卖单」—— 而那正是 T39 要消除的混淆。
 * 4 步全灰（无 `done`、无 `current`）表达的是「流程还没开始」，信息量严格更多。
 *
 * @type {ReadonlyArray<string>}
 */
const RENTAL_NOT_STARTED_STATUSES = Object.freeze([RENTAL_STATUS.PENDING_PAYMENT]);

/**
 * 商家端租赁「下一步」文案表（键见 `merchantRentalPhase`）。
 *
 * ⚠️ 文案里**不得出现「配送」**：租赁是用户到校内取车点取车。
 * `RENTING_FULFILLING` 说的是「核验交付码，确认用户已取车」——
 * 复用既有的交付码机制，但不沿用售卖链路的配送措辞。
 *
 * @type {Readonly<Record<string, string>>}
 */
const MERCHANT_RENTAL_NEXT_STEPS = Object.freeze({
  PENDING_PAYMENT: '等待用户支付',
  RENTING_PAID: '等待用户到店取车',
  RENTING_FULFILLING: '核验交付码，确认用户已取车',
  RETURN_REQUESTED: '用户已申请归还，请核验车辆后确认归还',
  RETURNED: '已归还，等待押金原路退回'
});

/**
 * 商家端租赁订单状态标签表（列表右上角徽标，键见 `merchantRentalPhase`）。
 *
 * @type {Readonly<Record<string, string>>}
 */
const MERCHANT_RENTAL_STATUS_LABELS = Object.freeze({
  PENDING_PAYMENT: '待支付',
  RENTING_PAID: '待取车',
  RENTING_FULFILLING: '租期中',
  RETURN_REQUESTED: '待核验归还',
  RETURNED: '已归还'
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
 * - `PENDING_PAYMENT`（已建单未支付）：4 步全部 `done: false`、`current: false`
 *   —— 「租期未开始」。**绝不允许**把第 1 步标成已完成（那是改动前的缺陷：
 *   用户没付钱就看到「已支付待取车」）。
 * - `RENTING` / `RETURN_REQUESTED` / `RETURNED`：按状态点亮。
 * - 状态不在白名单：返回空数组，**不猜**状态。
 *
 * @param {object|null|undefined} order 订单记录（需 `orderKind === 'RENTAL'` 与 `rental.status`）。
 * @returns {Array<{key: string, title: string, detail: string, done: boolean, current: boolean}>}
 *   4 步进度条；非租赁或状态无法识别时返回空数组。
 */
function buildRentalJourney(order) {
  if (!isRentalOrder(order)) return [];
  const status = rentalStatusOf(order);
  if (RENTAL_NOT_STARTED_STATUSES.includes(status)) {
    return RENTAL_STEPS.map((step) => ({
      key: step.key,
      title: step.title,
      detail: step.detail,
      done: false,
      current: false
    }));
  }
  const currentIndex = RENTAL_STATUS_STEP_INDEX[status];
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
 * 未支付单（`PENDING_PAYMENT`）**自动**落在拒绝侧 —— 租期还没起算，
 * 谈不上归还。这不是额外加的一道支付判断，而是与 `RENTING` 单一来源对齐：
 * 服务端 `RENTAL_ACTIONS.RETURN_REQUEST` 只允许 `RENTING` 起，两边口径一致。
 *
 * @param {object|null|undefined} order 订单记录。
 * @returns {boolean} 是否显示「申请归还」。
 */
function canRequestReturn(order) {
  return isRentalOrder(order) && rentalStatusOf(order) === RENTAL_STATUS.RENTING;
}

/**
 * 「核验归还」按钮的显示条件（**商家端**）。
 *
 * 只有**租赁单**且 `rental.status === 'RETURN_REQUESTED'` 才可核验：
 * 用户没申请就没得核验（`RENTING`），已核验过再点就是重复提交（`RETURNED`，
 * 服务端会回 `409 RENTAL_ALREADY_RETURNED`）。
 *
 * 判定必须同时要求 `orderKind === 'RENTAL'`：只认 `rental.status` 的话，
 * 一张声明为 `SALE` 却恰好带 `rental` 字段的订单（数据损坏、或未来复用字段）
 * 会让售卖单上冒出「核验归还」按钮 —— 那是资损级的误操作入口。
 *
 * @param {object|null|undefined} order 订单记录。
 * @returns {boolean} 是否显示「核验归还」。
 */
function canVerifyRentalReturn(order) {
  return isRentalOrder(order) && rentalStatusOf(order) === RENTAL_STATUS.RETURN_REQUESTED;
}

/**
 * 商家端租赁文案：把「订单状态 + 租赁状态」两维信息压成一个租赁阶段键。
 *
 * 为什么要两维：`rental.status === 'RENTING'` 在商家视角下有**两个完全不同的阶段** ——
 * `order.status === 'PAID'` 时用户还没来取车（商家该等），
 * `order.status === 'FULFILLING'` 时车已在用户手上（商家该核验交付码）。
 * 只看 `rental.status` 会把这两个阶段混成一句话。
 *
 * @param {object|null|undefined} order 订单记录。
 * @returns {string|null} 阶段键；非租赁或状态无法识别返回 `null`。
 */
function merchantRentalPhase(order) {
  if (!isRentalOrder(order)) return null;
  const status = rentalStatusOf(order);
  if (status === RENTAL_STATUS.PENDING_PAYMENT) return 'PENDING_PAYMENT';
  if (status === RENTAL_STATUS.RETURN_REQUESTED) return 'RETURN_REQUESTED';
  if (status === RENTAL_STATUS.RETURNED) return 'RETURNED';
  if (status === RENTAL_STATUS.RENTING) {
    return order.status === 'FULFILLING' ? 'RENTING_FULFILLING' : 'RENTING_PAID';
  }
  return null;
}

/**
 * 商家端租赁「下一步」文案。
 *
 * ⚠️ **租赁单绝不出现「配送」**：租赁是用户到校内取车点取车，不是配送。
 * 改造前商家端所有订单都走 `nextSteps[order.status]`，租赁单在 `FULFILLING`
 * 时显示「核验交付码并完成配送」—— 对租赁是错的（取车 vs 配送）。
 *
 * 返回值约定：**非租赁返回 `null`**（调用方回落到既有售卖文案表，保证售卖链路
 * 逐字不变）；租赁单**永不返回 `null`**，状态无法识别时给「等待更新」——
 * 这样「租赁单不会显示售卖文案」是结构性保证，而不是靠状态值恰好命中。
 *
 * @param {object|null|undefined} order 订单记录。
 * @returns {string|null} 商家下一步文案；非租赁返回 `null`。
 */
function merchantRentalNextStep(order) {
  if (!isRentalOrder(order)) return null;
  const phase = merchantRentalPhase(order);
  return phase ? MERCHANT_RENTAL_NEXT_STEPS[phase] : '等待更新';
}

/**
 * 商家端租赁订单状态标签。
 *
 * 与 {@link merchantRentalNextStep} 的分工：这个是列表右上角的状态徽标，
 * 那个是「下一步」提示行。状态无法识别时返回 `null`，让调用方回落到既有的
 * `statusLabels`（基于 `order.status`，不涉及租赁语义，回落是安全的）。
 *
 * @param {object|null|undefined} order 订单记录。
 * @returns {string|null} 状态标签；非租赁或状态无法识别返回 `null`。
 */
function merchantRentalStatusLabel(order) {
  const phase = merchantRentalPhase(order);
  return phase ? MERCHANT_RENTAL_STATUS_LABELS[phase] : null;
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
 * `ebikeJourney` / `afterSaleJourney` 由调用方注入（归 `order-card.js` 所有 ——
 * 订单卡片装饰层，M3-P1-05 从 `orders.js` 抽出），本模块不复制售卖文案，避免两处维护同一份文案。
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
  RENTAL_NOT_STARTED_STATUSES,
  MERCHANT_RENTAL_NEXT_STEPS,
  MERCHANT_RENTAL_STATUS_LABELS,
  isRentalOrder,
  rentalStatusOf,
  buildRentalJourney,
  isRentalOverdue,
  rentalCountdownText,
  rentalCardText,
  canRequestReturn,
  canVerifyRentalReturn,
  merchantRentalPhase,
  merchantRentalNextStep,
  merchantRentalStatusLabel,
  shouldRefreshCountdown,
  selectOrderJourney
};
