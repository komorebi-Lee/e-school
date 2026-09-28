/**
 * 商品展示层映射（售卖 / 租赁）。
 *
 * 背景：租赁商品（`listingType === 'RENT'`）在后端已可下单、押金隔离、归还归位，
 * 但列表与详情页此前只认识「售价」，导致租赁车在界面上显示成一台 3199 元的售卖车。
 * 把这些映射从页面里抽出来，是为了让它**可被测试**：`miniprogram/pages/**` 顶层调用
 * `Page()`，在 Node 中加载会直接崩溃，页面内的映射逻辑因此没有任何运行时覆盖
 * （`test/miniapp.test.js` 只能做源码文本断言）。
 *
 * 约定：
 * - **纯函数**：不访问 `wx` / `getApp` / `Page`，可被 `test/miniapp-runtime.test.js` 真实加载断言。
 * - **缺省即售卖**：`listingType` 缺失（存量商品）一律视为 `'SALE'`，保证向后兼容。
 * - **租赁按单位租金计价**：价格、排序、文案全部取 `rentalPlan.unitPriceInCents`，
 *   绝不使用 `priceInCents`（那是买断参考价，用它排序会让租赁车永远排在最后）。
 */

/** 商品形态。 */
const LISTING_TYPE_SALE = 'SALE';
const LISTING_TYPE_RENT = 'RENT';

/** 租赁计费单位 → 中文单位。 */
const RENTAL_UNIT_LABELS = {
  DAY: '天',
  HOUR: '小时'
};

/** 未知单位时的兜底单位（服务端只允许 DAY / HOUR）。 */
const DEFAULT_RENTAL_UNIT = 'DAY';

/**
 * 租赁计费单位的步长（毫秒）。
 *
 * 与 `server/src/app.js` 计算 `rental.dueAt` 的步长**必须一致**：
 * 服务端 `stepMs = item.rentalUnit === 'HOUR' ? 60*60*1000 : 24*60*60*1000`。
 * 前端提前展示的到期时间一旦与服务端口径不同，用户就会按错误时点归还。
 *
 * @type {Readonly<Record<string, number>>}
 */
const RENTAL_UNIT_STEP_MS = {
  DAY: 24 * 60 * 60 * 1000,
  HOUR: 60 * 60 * 1000
};

/** 租赁商品的角标文案（售卖车沿用商品自带的 badge）。 */
const RENTAL_BADGE_TEXT = '可租赁';

/** 售卖 / 租赁的服务承诺与校区适配文案。 */
const SALE_SERVICES = ['校内配送', '平台购车牌照辅助', '售后专人跟进'];
const RENTAL_SERVICES = ['校内取还', '平台租车牌照辅助', '售后专人跟进'];
const SALE_POLICY = '支持华中农业大学狮山校区校园牌照辅助申请。';
const RENTAL_POLICY = '支持华中农业大学狮山校区校内取还车，按天计费，归还验收后结算押金。';
const SALE_DELIVERY_PROMISE_DETAIL = '确认校内配送安排';
const RENTAL_DELIVERY_PROMISE_DETAIL = '确认校内取还车安排';
const SALE_PLATE_PROMISE_DETAIL = '平台购车免费辅助上牌';
const RENTAL_PLATE_PROMISE_DETAIL = '平台租车免费辅助上牌';

/** 租赁主按钮文案（结算页由 T38 负责，这里只做展示）。 */
const RENTAL_ACTION_TEXT = '立即租赁';
const SALE_ACTION_TEXT = '立即购买';
const SALE_SOLD_OUT_ACTION_TEXT = '暂无可售';

/**
 * 展示精度：报价（售价 / 单位租金 / 买断参考价）用整数元并去掉尾零。
 *
 * @type {number}
 */
const YUAN_QUOTE_DIGITS = 0;

/**
 * 展示精度：押金等**可退还 / 可被部分扣除**的金额固定两位小数。
 *
 * @type {number}
 */
const YUAN_EXACT_DIGITS = 2;

/**
 * 把任意输入归一化为 `'SALE'` / `'RENT'`。
 *
 * 缺失、空串、大小写不一致的存量数据都按售卖处理，避免脏数据把商品打成租赁。
 *
 * @param {unknown} value 原始 `listingType`。
 * @returns {'SALE'|'RENT'} 归一化后的形态。
 */
function normalizeListingType(value) {
  return String(value === undefined || value === null ? '' : value).trim().toUpperCase() === LISTING_TYPE_RENT
    ? LISTING_TYPE_RENT
    : LISTING_TYPE_SALE;
}

/**
 * 安全取数：非有限值（`NaN` / `Infinity` / `null` / 非数字字符串）回退为 `fallback`。
 *
 * @param {unknown} value 原始值。
 * @param {number} [fallback] 兜底值。
 * @returns {number} 有限数字。
 */
function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * 分 → 元的展示文本。
 *
 * 展示口径遵循 PRD 的一致约定（`01-PRD.md:56` 金额一律以分为单位）：
 * **报价用整数元、可退还 / 可被部分扣除的金额用两位小数**。
 *
 * 为什么押金必须两位小数：押金会被**部分扣除**，`¥299.00 − ¥49.50 = ¥249.50`
 * 一眼可验；若展示成 `¥299`，同样的减法会看起来像算错。押金是「账」，报价是「价」，
 * 精度要求不同 —— 所以精度是**显式参数**，而不是全局统一（用反了要有断言能抓住）。
 *
 * @param {unknown} cents 金额（分）。
 * @param {number} [fractionDigits] `YUAN_QUOTE_DIGITS`（默认，报价去尾零）/ `YUAN_EXACT_DIGITS`（押金固定两位）。
 * @returns {string} 元文本。
 */
function formatYuan(cents, fractionDigits = YUAN_QUOTE_DIGITS) {
  const yuan = Math.round(toFiniteNumber(cents)) / 100;
  if (fractionDigits > YUAN_QUOTE_DIGITS) return yuan.toFixed(fractionDigits);
  if (Number.isInteger(yuan)) return String(yuan);
  return String(Number(yuan.toFixed(YUAN_EXACT_DIGITS)));
}

/**
 * 把任意输入归一化为合法的计费单位键（`'DAY'` / `'HOUR'`）。
 *
 * 服务端只允许这两种单位，脏值一律兜底为 `'DAY'`，避免出现空白单位。
 *
 * @param {unknown} unit `'DAY'` / `'HOUR'`。
 * @returns {'DAY'|'HOUR'} 合法单位键。
 */
function normalizeRentalUnit(unit) {
  const key = String(unit === undefined || unit === null ? '' : unit).trim().toUpperCase();
  return RENTAL_UNIT_LABELS[key] ? key : DEFAULT_RENTAL_UNIT;
}

/**
 * 租赁计费单位的中文标签。
 *
 * @param {unknown} unit `'DAY'` / `'HOUR'`。
 * @returns {string} `'天'` / `'小时'`。
 */
function rentalUnitLabel(unit) {
  return RENTAL_UNIT_LABELS[normalizeRentalUnit(unit)];
}

/**
 * 归一化 `rentalPlan`，只保留展示需要的字段。
 *
 * @param {object} item 商品原始对象。
 * @returns {object|null} 归一化后的租赁方案；非租赁或脏数据返回 `null`。
 */
function readRentalPlan(item) {
  const plan = item ? item.rentalPlan : null;
  if (!plan || typeof plan !== 'object') return null;
  const unit = String(plan.unit === undefined || plan.unit === null ? '' : plan.unit).trim().toUpperCase();
  return {
    unit: RENTAL_UNIT_LABELS[unit] ? unit : DEFAULT_RENTAL_UNIT,
    unitPriceInCents: toFiniteNumber(plan.unitPriceInCents),
    minUnits: toFiniteNumber(plan.minUnits, 1),
    maxUnits: toFiniteNumber(plan.maxUnits, 1),
    depositInCents: toFiniteNumber(plan.depositInCents)
  };
}

/**
 * 售卖价（分）：优先取服务端折算过促销的 `effectivePriceInCents`。
 *
 * @param {object} item 商品原始对象。
 * @returns {number} 实际成交价（分）。
 */
function effectivePriceInCentsOf(item) {
  const effective = item ? item.effectivePriceInCents : undefined;
  if (effective !== undefined && effective !== null) return toFiniteNumber(effective);
  return toFiniteNumber(item ? item.priceInCents : 0);
}

/**
 * 可售库存 = `availableStock`（服务端已扣除待支付占用），缺省回退到 `stock`。
 *
 * @param {object} item 商品原始对象。
 * @returns {number} 可售库存。
 */
function sellableStockOf(item) {
  const source = item || {};
  return toFiniteNumber(source.availableStock !== undefined ? source.availableStock : source.stock);
}

/**
 * 租赁单价文本，如 `'¥15/天'`。
 *
 * @param {object|null} rentalPlan 归一化后的租赁方案。
 * @returns {string} 单价文本。
 */
function rentalPriceText(rentalPlan) {
  if (!rentalPlan) return `¥0/${rentalUnitLabel(DEFAULT_RENTAL_UNIT)}`;
  return `¥${formatYuan(rentalPlan.unitPriceInCents)}/${rentalUnitLabel(rentalPlan.unit)}`;
}

/**
 * 租期区间文本，如 `'可租 1~30 天'`。
 *
 * @param {object|null} rentalPlan 归一化后的租赁方案。
 * @returns {string} 租期文本；非租赁返回空串。
 */
function rentalRangeText(rentalPlan) {
  if (!rentalPlan) return '';
  return `可租 ${rentalPlan.minUnits}~${rentalPlan.maxUnits} ${rentalUnitLabel(rentalPlan.unit)}`;
}

/**
 * 销量文案：售卖车是「已售 N」，租赁车是「N 辆在租」。
 *
 * @param {'SALE'|'RENT'} listingType 归一化后的形态。
 * @param {number} salesCount 已成交数量。
 * @returns {string} 销量文案。
 */
function salesTextOf(listingType, salesCount) {
  if (listingType === LISTING_TYPE_RENT) {
    return salesCount > 0 ? `${salesCount} 辆在租` : '待租';
  }
  return salesCount > 0 ? `已售 ${salesCount}` : '新品上架';
}

/**
 * 列表卡片展示项。
 *
 * @param {object} [item] `/api/products` 返回的商品原始对象。
 * @returns {object} 卡片展示项。
 */
function toProductCard(item = {}) {
  const source = item || {};
  const listingType = normalizeListingType(source.listingType);
  const isRental = listingType === LISTING_TYPE_RENT;
  const rentalPlan = isRental ? readRentalPlan(source) : null;
  const salesCount = toFiniteNumber(source.salesCount);

  return {
    listingType,
    isRental,
    // 租赁车给「可租赁」角标；售卖车沿用商品自带 badge（服务端未下发时保持空，与改造前一致）。
    badgeText: isRental ? RENTAL_BADGE_TEXT : String(source.badge || ''),
    priceText: isRental ? rentalPriceText(rentalPlan) : `¥${formatYuan(effectivePriceInCentsOf(source))}`,
    // 租赁车额外透出买断参考价，避免学生把「日租金 15 元」误读成整车售价。
    originalPriceText: isRental ? `原价 ¥${formatYuan(toFiniteNumber(source.priceInCents))}` : '',
    // 押金是「账」不是「价」：可退还、可被部分扣除，固定两位小数（PRD 一致口径）。
    depositText: isRental ? `押金 ¥${formatYuan(rentalPlan ? rentalPlan.depositInCents : 0, YUAN_EXACT_DIGITS)}` : '',
    rentalRangeText: isRental ? rentalRangeText(rentalPlan) : '',
    salesText: salesTextOf(listingType, salesCount),
    range: String(source.range || ''),
    // 「价格优先」排序的唯一依据：售卖车按成交价，租赁车按日租金。
    sortPriceInCents: isRental
      ? toFiniteNumber(rentalPlan ? rentalPlan.unitPriceInCents : 0)
      : effectivePriceInCentsOf(source)
  };
}

/**
 * 详情页展示项。
 *
 * @param {object} [product] `/api/products/:id` 返回的商品原始对象。
 * @returns {object} 详情展示项。
 */
function toDetailView(product = {}) {
  const source = product || {};
  const listingType = normalizeListingType(source.listingType);
  const isRental = listingType === LISTING_TYPE_RENT;
  const rentalPlan = isRental ? readRentalPlan(source) : null;
  const unitLabel = rentalUnitLabel(rentalPlan ? rentalPlan.unit : DEFAULT_RENTAL_UNIT);
  const sellableStock = sellableStockOf(source);

  return {
    listingType,
    isRental,
    badgeText: isRental ? RENTAL_BADGE_TEXT : String(source.badge || '校园专享'),
    priceText: isRental ? rentalPriceText(rentalPlan) : `¥${formatYuan(effectivePriceInCentsOf(source))}`,
    originalPriceText: isRental ? `原价 ¥${formatYuan(toFiniteNumber(source.priceInCents))}` : '',
    // 押金是「账」不是「价」：可退还、可被部分扣除，固定两位小数（PRD 一致口径）。
    depositText: isRental ? `押金 ¥${formatYuan(rentalPlan ? rentalPlan.depositInCents : 0, YUAN_EXACT_DIGITS)}` : '',
    rentalRangeText: isRental ? rentalRangeText(rentalPlan) : '',
    rentalUnitLabel: unitLabel,
    // 底部栏副标题：租赁车说「取还」，售卖车说「配送」。
    headlineText: isRental ? `校内取还 · 按${unitLabel}计费` : '校内配送 · 可协助上牌',
    // 租赁车即使被租空也保留「立即租赁」，是否可点由 disabled 依据 sellableStock 控制。
    actionText: isRental ? RENTAL_ACTION_TEXT : (sellableStock > 0 ? SALE_ACTION_TEXT : SALE_SOLD_OUT_ACTION_TEXT),
    range: String(source.range || ''),
    // 服务承诺区文案按形态切换：租赁车同样支持牌照辅助，但表述不能是「购车」。
    service: isRental ? RENTAL_SERVICES.slice() : (Array.isArray(source.service) ? source.service : SALE_SERVICES.slice()),
    policy: isRental ? RENTAL_POLICY : (source.policy || SALE_POLICY),
    deliveryPromiseDetail: isRental ? RENTAL_DELIVERY_PROMISE_DETAIL : SALE_DELIVERY_PROMISE_DETAIL,
    platePromiseDetail: isRental ? RENTAL_PLATE_PROMISE_DETAIL : SALE_PLATE_PROMISE_DETAIL
  };
}

// ===========================================================================
// 结算页（T38）：租赁租期选择与费用拆分
// ===========================================================================
//
// 结算页 `checkout.js` 顶层调用 `Page()`，在 Node 里无法加载，因此「选 3 天要付多少」
// 这类**直接决定用户付多少钱**的逻辑必须住在纯函数里，才能被运行时测试真实断言。
//
// 口径与 `server/src/app.js` 的建单逻辑逐字对齐（`buildRentalOrderItem` +
// `totalInCents += rentalDepositTotalInCents`）：
//   租金合计 = 单位租金 × 租期
//   押金     = 每单固定一份（与服务端 `createRentalDeposit` 的「每单固定押金」一致）
//   应付合计 = 租金合计 + 押金 + 配送费
//
// ★ 押金**绝不**并入租金合计：服务端 L1 防线要求押金不进 `subtotalInCents`，
//   前端若把两者合并展示，用户看到的「租金」就会与实际分账口径不符。

/**
 * 归一化传入的租赁方案。
 *
 * 同时接受三种形态，方便调用方少写胶水代码：
 * - 已归一化的方案（`readRentalPlan` 的返回值）；
 * - 原始 `rentalPlan` 对象；
 * - 整个商品对象（自动取其 `rentalPlan`）。
 *
 * 单位租金缺失或非正数视为方案损坏，返回 `null`（不租赁，绝不按售价计价）。
 *
 * @param {object|null|undefined} input 租赁方案 / 商品对象。
 * @returns {object|null} 归一化方案；损坏返回 `null`。
 */
function normalizeRentalPlanInput(input) {
  if (!input || typeof input !== 'object') return null;
  const plan = input.rentalPlan && typeof input.rentalPlan === 'object' ? input.rentalPlan : input;
  if (!plan || typeof plan !== 'object') return null;
  const unitPriceInCents = Math.round(toFiniteNumber(plan.unitPriceInCents));
  if (!(unitPriceInCents > 0)) return null;
  const minUnits = Math.max(1, Math.round(toFiniteNumber(plan.minUnits, 1)));
  const maxUnits = Math.max(minUnits, Math.round(toFiniteNumber(plan.maxUnits, minUnits)));
  return {
    unit: normalizeRentalUnit(plan.unit),
    unitPriceInCents,
    minUnits,
    maxUnits,
    depositInCents: Math.max(0, Math.round(toFiniteNumber(plan.depositInCents)))
  };
}

/**
 * 把租期夹取到 `[minUnits, maxUnits]` 内并取整。
 *
 * 结算页的步进器已拦住越界，这里再夹一次是**纵深防御**：
 * 任何调用方（含未来的其他入口）都不可能用越界租期算出金额。
 *
 * @param {unknown} units 原始租期。
 * @param {object} plan 归一化方案。
 * @returns {number} 合法租期。
 */
function clampRentalUnits(units, plan) {
  const parsed = Math.round(toFiniteNumber(units, plan.minUnits));
  return Math.min(plan.maxUnits, Math.max(plan.minUnits, parsed));
}

/**
 * 租赁费用拆分。
 *
 * @param {object} [options] 入参。
 * @param {object|null} [options.rentalPlan] 租赁方案（或商品对象）。
 * @param {number} [options.rentalUnits] 用户选择的租期。
 * @param {number} [options.deliveryFeeInCents] 校内配送费（分）。
 * @returns {object|null} 费用拆分；非租赁返回 `null`（调用方据此走售卖分支）。
 */
function computeRentalFees({ rentalPlan, rentalUnits, deliveryFeeInCents } = {}) {
  const plan = normalizeRentalPlanInput(rentalPlan);
  if (!plan) return null;
  const units = clampRentalUnits(rentalUnits, plan);
  const unitRentInCents = plan.unitPriceInCents;
  const rentInCents = unitRentInCents * units;
  const depositInCents = plan.depositInCents;
  const delivery = Math.max(0, Math.round(toFiniteNumber(deliveryFeeInCents)));
  const totalInCents = rentInCents + depositInCents + delivery;
  return {
    rentalUnits: units,
    unitRentInCents,
    rentInCents,
    depositInCents,
    deliveryFeeInCents: delivery,
    totalInCents,
    // 租金是「报价」：整数元、去尾零。
    rentText: `¥${formatYuan(rentInCents)}`,
    // 押金是「可退还、可被部分扣除的账」：固定两位小数。
    depositText: `¥${formatYuan(depositInCents, YUAN_EXACT_DIGITS)}`,
    deliveryFeeText: delivery > 0 ? `¥${formatYuan(delivery)}` : '免费',
    // 应付合计同时含押金，属于「实付」；这里仍按报价口径展示整数元（合计是用户实付的钱，
    // 精度由押金那一行负责，避免同一张卡里出现两种「总价」写法）。
    totalText: `¥${formatYuan(totalInCents)}`,
    depositNoticeText: `押金 ¥${formatYuan(depositInCents, YUAN_EXACT_DIGITS)} 在归还核验后原路退回，不计入商家分账`
  };
}

/**
 * 把到期时间格式化为「M月D日 HH:mm 前归还」。
 *
 * @param {Date} date 到期时间。
 * @returns {string} 展示文案。
 */
function formatRentalDueAt(date) {
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${month}月${day}日 ${hours}:${minutes} 前归还`;
}

/**
 * 计算租赁到期时间。
 *
 * ⚠️ **只展示到期时间，不编造免罚宽限**：服务端 `rentalPlan` 目前没有
 * 宽限期 / 超时费率字段，任何「之后 N 小时免罚」的文案都是凭空捏造。
 * 待 `T32` 扩展模型后再补。
 *
 * @param {number} rentalUnits 租期。
 * @param {string} unit 计费单位（`'DAY'` / `'HOUR'`）。
 * @param {Date|string|number} [now] 起租时间，缺省为当前时间。
 * @returns {{dueAt: string, dueAtText: string}} 到期时间（ISO）与展示文案。
 */
function computeRentalDueAt(rentalUnits, unit, now) {
  const base = now instanceof Date ? now : (now === undefined || now === null ? new Date() : new Date(now));
  const safeBase = Number.isFinite(base.getTime()) ? base : new Date();
  const stepMs = RENTAL_UNIT_STEP_MS[normalizeRentalUnit(unit)];
  const units = Math.max(0, Math.round(toFiniteNumber(rentalUnits)));
  const dueDate = new Date(safeBase.getTime() + units * stepMs);
  return { dueAt: dueDate.toISOString(), dueAtText: formatRentalDueAt(dueDate) };
}

/**
 * 租期步进（+1 / -1）的越界拦截。
 *
 * 返回 `accepted: false` 时调用方**必须保持原值不变**并（可选）提示 `message`。
 * `locked: true` 表示 `minUnits === maxUnits`，选择器整体不可用。
 *
 * 抽成纯函数是为了让「越界不可增加」这条规则**可被运行时断言**，
 * 而不是只能对页面做源码文本断言（文本断言连注释都能满足）。
 *
 * @param {object} [options] 入参。
 * @param {object|null} [options.rentalPlan] 租赁方案（或商品对象）。
 * @param {number} [options.rentalUnits] 当前租期。
 * @param {'increase'|'decrease'} [options.action] 步进方向。
 * @returns {object|null} `{ accepted, locked, rentalUnits, message }`；非租赁返回 `null`。
 */
function stepRentalUnits({ rentalPlan, rentalUnits, action } = {}) {
  const plan = normalizeRentalPlanInput(rentalPlan);
  if (!plan) return null;
  const current = clampRentalUnits(rentalUnits, plan);
  const label = rentalUnitLabel(plan.unit);
  if (plan.minUnits >= plan.maxUnits) {
    return { accepted: false, locked: true, rentalUnits: current, message: `该商品租期固定为 ${plan.minUnits} ${label}` };
  }
  const delta = action === 'increase' ? 1 : action === 'decrease' ? -1 : 0;
  if (delta === 0) return { accepted: false, locked: false, rentalUnits: current, message: '' };
  const next = current + delta;
  if (next < plan.minUnits) return { accepted: false, locked: false, rentalUnits: current, message: `至少租 ${plan.minUnits} ${label}` };
  if (next > plan.maxUnits) return { accepted: false, locked: false, rentalUnits: current, message: `最多可租 ${plan.maxUnits} ${label}` };
  return { accepted: true, locked: false, rentalUnits: next, message: '' };
}

module.exports = {
  LISTING_TYPE_SALE,
  LISTING_TYPE_RENT,
  RENTAL_UNIT_LABELS,
  RENTAL_UNIT_STEP_MS,
  YUAN_QUOTE_DIGITS,
  YUAN_EXACT_DIGITS,
  normalizeListingType,
  formatYuan,
  normalizeRentalUnit,
  rentalUnitLabel,
  readRentalPlan,
  effectivePriceInCentsOf,
  sellableStockOf,
  salesTextOf,
  toProductCard,
  toDetailView,
  normalizeRentalPlanInput,
  computeRentalFees,
  computeRentalDueAt,
  stepRentalUnits
};
