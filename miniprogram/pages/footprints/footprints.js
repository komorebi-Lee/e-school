const { request } = require("../../services/api");

Page({
  data: { footprints: [], loading: true },
  onShow() { this.load(); },
  load() {
    request("/api/my/footprints").then(({ data }) => {
      const footprints = (data || []).map((item) => {
        const stock = Number(item.availableStock ?? (item.stock || 0));
        return {
          id: item.id,
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
      this.setData({ footprints, loading: false });
    }).catch(() => this.setData({ loading: false }));
  },
  goDetail(event) {
    const productId = event?.currentTarget?.dataset?.id;
    if (!productId) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(productId)}` });
  }
});
