/**
 * 商品跳转目标：按 `category` 决定进哪个详情页。
 *
 * ## 为什么需要它
 *
 * 收藏 / 足迹列表里既有电动车也有电话卡，但两个页面过去一律跳
 * `/pages/detail/detail`。电话卡落到**电瓶车详情页** —— 用户看到一张「车」页面
 * 上写着电话卡的名字，字段缺失、按钮语义错乱（`detail` 页的购买按钮是买车逻辑）。
 *
 * ## 为什么抽成纯函数
 *
 * 只有纯函数才能被 `test/miniapp-runtime.test.js` **真实加载并断言**。
 * 写在页面脚本里就只能做源码 grep —— 而 grep 断言不到行为：把分流逻辑删掉、
 * 或把两个分支写反，源码里那行 `if (category === 'PHONE_PLAN')` 依然在。
 *
 * ## 为什么走 `openLink` 而不是裸 `wx.navigateTo`
 *
 * 全仓不变量要求站内跳转统一走 `utils/navigation.js` 的 `openLink`：
 * 它能识别 tabBar 页（`navigateTo` 跳 tabBar 页会直接失败），且失败不再静默
 * （会给出提示并回滚焦点参数）。裸 `navigateTo` 失败时用户点了毫无反应。
 */

const { openLink } = require('./navigation');

/** 电话卡品类的 `category` 取值，与服务端 `products[].category` 一致。 */
const PHONE_PLAN_CATEGORY = 'PHONE_PLAN';

/** 电话卡套餐页（`card.js` 的 `onLoad` 读 `options.planId` 定位套餐）。 */
const PHONE_PLAN_PAGE = '/pages/card/card';

/** 商品详情页（电动车等实物商品）。 */
const PRODUCT_DETAIL_PAGE = '/pages/detail/detail';

/**
 * 计算某件商品的详情页地址。
 *
 * - `PHONE_PLAN` → `/pages/card/card?planId=<id>`（电话卡套餐页）
 * - 其他（含 `E_BIKE_NEW`）→ `/pages/detail/detail?id=<id>`（商品详情页）
 * - **未知 `category` → 回落 `detail`**
 * - `id` 为空 → 返回 `''`，调用方据此跳过跳转
 *
 * ### 未知品类为什么回落 `detail` 而不是提示
 *
 * 1. `detail` 是**改造前的默认落点**，未知品类走它与旧行为逐字一致（零回归）；
 * 2. 反过来把未知品类送进 `card` 是**更严重**的错配 —— `card` 是电话卡专用页，
 *    会按套餐渲染月费 / 话费 / 实名激活，对别的品类全是错的；
 * 3. 也不选「弹提示不跳」：那会把一个「现在能用、只是页面不够贴切」的入口
 *    变成**死路**（用户点了没反应），正是本会话一直在修的那类问题。
 *
 * @param {{ id?: string, category?: string }} product 商品（只需 id 与 category）。
 * @returns {string} 可交给 `openLink` 的站内地址；`id` 缺失时为空串。
 */
function productDetailUrl(product) {
  const source = product || {};
  const rawId = source.id === undefined || source.id === null ? '' : source.id;
  const id = String(rawId).trim();
  if (!id) return '';
  const encodedId = encodeURIComponent(id);
  if (source.category === PHONE_PLAN_CATEGORY) {
    return `${PHONE_PLAN_PAGE}?planId=${encodedId}`;
  }
  return `${PRODUCT_DETAIL_PAGE}?id=${encodedId}`;
}

/**
 * 打开某件商品的详情页（按品类分流）。
 *
 * @param {{ id?: string, category?: string }} product 商品。
 * @param {object} [options] 透传给 `openLink` 的选项（如自定义 `fail`）。
 * @returns {string} 实际使用的地址；未跳转（`id` 缺失）时为空串。
 */
function openProductDetail(product, options) {
  const url = productDetailUrl(product);
  if (!url) return '';
  openLink(url, options);
  return url;
}

module.exports = {
  PHONE_PLAN_CATEGORY,
  PHONE_PLAN_PAGE,
  PRODUCT_DETAIL_PAGE,
  productDetailUrl,
  openProductDetail
};
