const { request } = require("../../services/api");

function stars(rating) {
  return "★★★★★".slice(0, Math.max(0, Math.min(5, Number(rating) || 0)));
}

Page({
  data: { reviews: [], loading: true },
  onShow() { this.load(); },
  load() {
    request("/api/my/product-reviews").then(({ data }) => {
      const reviews = (data || []).map((item) => ({
        ...item,
        stars: stars(item.rating),
        dateText: String(item.createdAt || "").slice(5, 16).replace("T", " "),
        hidden: item.visibility === "HIDDEN"
      }));
      this.setData({ reviews, loading: false });
    }).catch(() => this.setData({ loading: false }));
  },
  goDetail(event) {
    const productId = event?.currentTarget?.dataset?.id;
    if (!productId) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(productId)}` });
  }
});
