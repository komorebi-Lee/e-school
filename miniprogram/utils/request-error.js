/**
 * 请求失败的**分类**工具（纯函数，不访问 `wx` / `Page`，可在 Node 里真实断言）。
 *
 * ## 为什么必须把「404」与「网络失败」分开
 *
 * 两者的**用户可见后果**完全不同，混成一种处理会各错一半：
 *
 * 1. **404（资源确实不存在 / 不可见）** —— 重试一百次还是 404。
 *    把 404 渲染成「加载失败，请重试」会**暗示「过一会儿就好」**，
 *    让用户反复重试一个永远不会成功的请求。
 * 2. **网络失败 / 5xx** —— 重试是**有意义**的。
 *    把它渲染成「商品不存在或已下架」是在**断言一个我们并不知道的事实**：
 *    用户会以为商品被下架而离开，其实只是这一次没连上。
 *
 * 本项目改造前只有第 2 类错误（把所有失败都说成「不存在」）。
 * `pages/detail/detail.js` 的 `goneText` 是第一次分流，但只做对了一半 ——
 * 它把 404 分支改成了常驻的「该商品已下架」，**非 404 分支的文案没跟上**。
 * 本模块把这个判断单点化，避免每个页面各写一份、各漏一半。
 *
 * ## 判据
 *
 * 满足任一条即视为 404：
 *
 * - `Number(error.statusCode) === 404`
 *   —— 服务端 `ApiError` 的状态码由 `lib/cloud-request.js` 的 `responseError()`
 *   挂在错误对象上（`error.statusCode = statusCode`）。
 * - `error.code` 以 `_NOT_FOUND` 结尾
 *   —— 兜底：万一 `statusCode` 丢失，服务端所有「资源不存在」错误码都遵循
 *   这个命名（实测 `server/src/app.js` 里 36 个 404 码**全部**如此：
 *   `PRODUCT_NOT_FOUND` / `STOREFRONT_NOT_FOUND` / `MARKET_ITEM_NOT_FOUND` /
 *   `FORUM_POST_NOT_FOUND` / `NOTIFICATION_NOT_FOUND` …）。
 *
 * ★ **必须能接受任意值，不能假定它有 `statusCode` / `code`**：
 *   `wx.cloud.callContainer` 网络失败时抛出的是**只有 `errMsg` 的普通对象**，
 *   而不是 `Error`（见 `lib/cloud-request.js` —— `await callContainer(...)` 的
 *   rejection 直接向上传播，**不经过** `responseError()`）。此时
 *   `Number(undefined)` 为 `NaN`、`String(undefined)` 不含 `_NOT_FOUND`，
 *   两条判据都返回假，分类结果就是「网络失败」—— 正是我们要的。
 *
 * ★ **已知边界**：路由写错时服务端返回 404 `ROUTE_NOT_FOUND`
 *   （`app.js` 的兜底分支），本模块会把它归为 404。对用户而言「你要的东西
 *   不存在」在两种情形下都成立，故不额外区分；这是一处**有意为之**的近似。
 */

/** 视为「资源不存在」的 HTTP 状态码。 */
const NOT_FOUND_STATUS = 404;

/** 视为「资源不存在」的错误码后缀。 */
const NOT_FOUND_CODE_SUFFIX = '_NOT_FOUND';

/**
 * 判断一个失败是否表示「资源确实不存在 / 不可见」（HTTP 404）。
 *
 * @param {unknown} error 捕获到的任意失败值（可能是 `Error`，也可能是 `wx` 的普通对象）。
 * @returns {boolean} `true` 表示 404（重试无意义）；`false` 表示网络失败 / 5xx / 无法识别（可重试）。
 */
function isNotFoundError(error) {
  if (!error || typeof error !== 'object') return false;
  if (Number(error.statusCode) === NOT_FOUND_STATUS) return true;
  return String(error.code || '').endsWith(NOT_FOUND_CODE_SUFFIX);
}

/**
 * 判断一个失败是否**可重试**（即不是 404）。
 *
 * 与 `!isNotFoundError(error)` 等价，但意图可读：调用点写
 * `if (isRetryableError(error))` 比写 `if (!isNotFoundError(error))` 更难读错。
 *
 * @param {unknown} error 捕获到的任意失败值。
 * @returns {boolean} `true` 表示重试可能成功。
 */
function isRetryableError(error) {
  return !isNotFoundError(error);
}

module.exports = {
  NOT_FOUND_STATUS,
  NOT_FOUND_CODE_SUFFIX,
  isNotFoundError,
  isRetryableError
};
