const { request, userId } = require("../../services/api");

Page({
  data: { verified: false, customerService: "15527111396", merchantBadge: false, latestApprovedAt: "" },
  onShow() { this.loadMerchantBadge(); },
  loadMerchantBadge() {
    request(`/api/merchants?userId=${encodeURIComponent(userId())}`).then(({ data }) => {
      const approved = data.find((item) => item.status === "APPROVED");
      const approvedAt = approved?.updatedAt || approved?.createdAt || "";
      const badgeSeenAt = wx.getStorageSync("campusGoMerchantBadgeSeenAt") || "";
      this.setData({
        latestApprovedAt: approvedAt,
        merchantBadge: Boolean(approvedAt && approvedAt > badgeSeenAt)
      });
    }).catch(() => this.setData({ merchantBadge: false }));
  },
  verify() { this.setData({ verified: true }); wx.showToast({ title: "演示认证成功" }); },
  goOrders() { wx.switchTab({ url: "/pages/orders/orders" }); },
  goCard() { wx.navigateTo({ url: "/pages/card/card" }); },
  goMerchant() {
    if (this.data.latestApprovedAt) {
      wx.setStorageSync("campusGoMerchantBadgeSeenAt", this.data.latestApprovedAt);
      this.setData({ merchantBadge: false });
    }
    wx.navigateTo({ url: "/pages/merchant/index" });
  },
  goPlate() { wx.navigateTo({ url: "/pages/plate/plate" }); },
  callService() { wx.makePhoneCall({ phoneNumber: this.data.customerService }); },
  copyWechat() { wx.setClipboardData({ data: this.data.customerService }); }
});
