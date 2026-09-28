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
 * 租赁计费单位的中文标签。
 *
 * @param {unknown} unit `'DAY'` / `'HOUR'`。
 * @returns {string} `'天'` / `'小时'`。
 */
function rentalUnitLabel(unit) {
  const key = String(unit === undefined || unit === null ? '' : unit).trim().toUpperCase();
  return RENTAL_UNIT_LABELS[key] || RENTAL_UNIT_LABELS[DEFAULT_RENTAL_UNIT];
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

module.exports = {
  LISTING_TYPE_SALE,
  LISTING_TYPE_RENT,
  RENTAL_UNIT_LABELS,
  YUAN_QUOTE_DIGITS,
  YUAN_EXACT_DIGITS,
  normalizeListingType,
  formatYuan,
  rentalUnitLabel,
  readRentalPlan,
  effectivePriceInCentsOf,
  sellableStockOf,
  salesTextOf,
  toProductCard,
  toDetailView
};
