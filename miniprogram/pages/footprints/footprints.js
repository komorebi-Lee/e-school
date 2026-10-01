const { request } = require("../../services/api");
const loadState = require("../../utils/load-state");
const { openProductDetail } = require("../../utils/product-route");

Page({
  // ★ 三态块（加载中 / 失败 / 无数据）。
  // 改造前失败时 `setData({ loading: false })` —— 连错误都没有，旧数据静默滞留，
  // 用户看到的是「上一次的足迹」却以为是刚拉到的，既无提示也无重试入口。
  data: { footprintsBlock: loadState.initialListBlock() },
  onShow() { this.load(); },
  /**
   * 加载浏览足迹。
   *
   * 失败时 `loadBlock` 只写 `error` 文案，**上一次的列表原样保留**。
   *
   * @returns {Promise<void>} 加载（或失败）完成后解析。
   */
  load() {
    return loadState.loadBlock({
      setData: (patch) => this.setData(patch),
      stateKey: "footprintsBlock",
      prev: this.data.footprintsBlock,
      loader: () => request("/api/my/footprints").then(({ data }) => (data || []).map((item) => {
        const stock = Number(item.availableStock ?? (item.stock || 0));
        return {
          id: item.id,
          // ★ 带上 category 供点击分流。`categoryLabel` 只够渲染一行文字，
          // 判断「该进套餐页还是商品详情页」必须用原始 category。
          category: item.category || "",
          categoryLabel: item.category === "PHONE_PLAN" ? "电话卡" : "电动车",
          name: item.name,
          merchantName: item.merchantName || "平台自营",
          stockText: stock > 0 ? (stock < 5 ? `仅剩 ${stock} 件` : `库存 ${stock}`) : "已售罄",
          price: (Number(item.effectivePriceInCents ?? (item.priceInCents || 0)) / 100).toFixed(2),
          originalPrice: item.promotion?.originalPriceInCents
            ? (Number(item.promotion.originalPriceInCents) / 100).toFixed(2) : "",
          promoText: item.promotion?.statusText || ""
        };
      }))
    });
  },
  /** 重新加载：浏览足迹。 */
  retryFootprints() { return this.load(); },
  /**
   * 打开商品详情：按 `category` 分流（电话卡 → 套餐页，其余 → 商品详情页）。
   *
   * 与收藏页同一套做法：按 id 回查本页已加载的区块数据，用**渲染那一行所用的
   * 那份数据**决定去向，避免 wxml 与装饰层两份 category 各自漂移。
   * 回查不到时只传 `{ id }` → 回落 `detail` 页（与改造前一致，不会变成死路）。
   */
  goDetail(event) {
    const productId = event?.currentTarget?.dataset?.id;
    if (!productId) return;
    const items = this.data.footprintsBlock.data || [];
    openProductDetail(items.find((item) => item.id === productId) || { id: productId });
  }
});
