const { request } = require("../../services/api");
const loadState = require("../../utils/load-state");
const { openProductDetail } = require("../../utils/product-route");

Page({
  // ★ 三态块（加载中 / 失败 / 无数据）。
  // 改造前失败时 `setData({ loading: false })` —— 连错误都没有，旧数据静默滞留，
  // 用户看到的是「上一次的足迹」却以为是刚拉到的，既无提示也无重试入口。
  data: {
    footprintsBlock: loadState.initialListBlock(),
    // ★ 清空动作自身的状态，与「加载」严格分开：
    //   - `clearing`：请求在途，按钮置灰，防重复点；
    //   - `clearError`：非空即「上一次清空失败了」。此时页面上那条常驻占位的
    //     「重试」必须**重试清空本身**（见 `retryFootprints`）—— 若它退化成
    //     「重新加载」，用户点多少次都删不掉任何东西，那个按钮就是假的。
    clearing: false,
    clearError: '',
    // ★ 服务端给的**真实总数**（不受「一次只返回 20 条」这个上限影响）
    //   与「是否被截断」。顶部文案靠它决定要不要如实补一句「（最多显示 20 件）」——
    //   我们**不能凭空声称**自己知道用户一共有多少条。
    footprintTotal: 0,
    footprintTruncated: false
  },
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
      loader: () => request("/api/my/footprints").then(({ data, total }) => {
        const list = (data || []).map((item) => {
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
        });
        // ★ 只有服务端**明确**给了 `total`（真实总数）且它大于本页条数时，才声称
        //   「被截断」。服务端没给这个字段时（老版本 / 测试桩）退化为「不声称」——
        //   宁可什么都不说，也不要凭空说一个我们并不知道的事实。
        const totalNumber = Number(total);
        const totalKnown = Number.isFinite(totalNumber);
        this.setData({
          footprintTotal: totalKnown ? totalNumber : list.length,
          footprintTruncated: totalKnown && totalNumber > list.length
        });
        return list;
      })
    });
  },
  /**
   * 「重试」按钮的统一入口。
   *
   * ★ 重试的必须是**上一次真正失败的那个动作**：
   *   - 上一次失败的是「清空」→ 重试清空；
   *   - 否则 → 重新加载列表。
   *
   * 若这里无脑 `return this.load()`，清空失败后用户点「重试」只会重新拉一次
   * 列表（列表本来就在），**永远删不掉** —— 那个重试按钮就是假的。
   *
   * @returns {Promise<unknown>} 对应动作完成（或失败）后解析。
   */
  retryFootprints() {
    if (this.data.clearError) return this.performClearFootprints();
    return this.load();
  },
  /**
   * 清空浏览足迹：**先二次确认**。
   *
   * 清空不可逆，所以必须先弹 `wx.showModal`。★ 用户没确认时**一个请求都不发** ——
   * 「点了取消却也发了请求」是这个交互最容易漏掉的缺陷。
   */
  clearFootprints() {
    if (this.data.clearing) return;
    wx.showModal({
      title: '清空足迹',
      content: '清空后无法恢复，将删除你账号下的全部浏览记录。',
      success: ({ confirm }) => {
        if (!confirm) return;
        this.performClearFootprints();
      }
    });
  },
  /**
   * 真正执行清空：`DELETE /api/my/footprints`。
   *
   * 成功 → 落**正常空态**（不是错误态、不是一直 loading），并把总数如实归零。
   * 失败 → 写进**常驻**的 `clearError` 占位（可见 + 可重试），而不是弹一个
   *        会消失的 toast；同时**不清空列表** —— 我们并不知道服务端到底删没删掉，
   *        这与 `loadState.rejectBlock`「失败不清空数据」是同一条纪律。
   *
   * @returns {Promise<void>} 清空（或失败）完成后解析。
   */
  performClearFootprints() {
    this.setData({ clearing: true, clearError: '' });
    return request("/api/my/footprints", { method: "DELETE" })
      .then(() => {
        this.setData({
          clearing: false,
          clearError: '',
          footprintTotal: 0,
          footprintTruncated: false,
          // ★ 立刻落空态：不能等 `load()` 再拉一次，否则用户会看到一份
          //   已经被删掉的列表继续挂在那里，以为没清掉。
          footprintsBlock: { loading: false, error: '', data: [] }
        });
        wx.showToast({ title: '已清空', icon: 'success' });
      })
      .catch((error) => {
        this.setData({ clearing: false, clearError: loadState.blockErrorText(error) });
      });
  },
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
