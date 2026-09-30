const { request } = require("../../services/api");
const loadState = require("../../utils/load-state");

function stars(rating) {
  return "★★★★★".slice(0, Math.max(0, Math.min(5, Number(rating) || 0)));
}

Page({
  // ★ 三态块（加载中 / 失败 / 无数据）。
  // 改造前失败时 `setData({ loading: false })` —— 连错误都没有，旧评价静默滞留，
  // 用户会把「上一次的结果」当成刚拉到的，且无从重试。
  data: { reviewsBlock: loadState.initialListBlock() },
  onShow() { this.load(); },
  /**
   * 加载我的评价。
   *
   * 失败时 `loadBlock` 只写 `error` 文案，**上一次的列表原样保留**。
   *
   * @returns {Promise<void>} 加载（或失败）完成后解析。
   */
  load() {
    return loadState.loadBlock({
      setData: (patch) => this.setData(patch),
      stateKey: "reviewsBlock",
      prev: this.data.reviewsBlock,
      loader: () => request("/api/my/product-reviews").then(({ data }) => (data || []).map((item) => ({
        ...item,
        stars: stars(item.rating),
        dateText: String(item.createdAt || "").slice(5, 16).replace("T", " "),
        hidden: item.visibility === "HIDDEN"
      })))
    });
  },
  /** 重新加载：我的评价。 */
  retryReviews() { return this.load(); },
  goDetail(event) {
    const productId = event?.currentTarget?.dataset?.id;
    if (!productId) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(productId)}` });
  }
});
