const { request, userId } = require("../../services/api");
const { loginWeChat } = require("../../lib/cloud-request");

Page({
  data: {
    verified: false,
    customerService: "15527111396",
    merchantBadge: false,
    latestApprovedAt: "",
    userId: "",
    loginState: "loading",
    loggingIn: false
  },
  onShow() { this.refreshLoginState(); this.loadMerchantBadge(); },
  refreshLoginState() {
    const stored = wx.getStorageSync("campusGoUserId") || "";
    this.setData({ userId: stored, loginState: stored ? "ready" : "guest" });
  },
  loginWithWeChat() {
    if (this.data.loggingIn) return;
    this.setData({ loggingIn: true });
    loginWeChat().then(({ userId: id }) => {
      this.setData({ userId: id, loginState: "ready", loggingIn: false });
      wx.showToast({ title: "登录成功", icon: "success" });
      this.loadMerchantBadge();
    }).catch((error) => {
      this.setData({ loggingIn: false });
      wx.showModal({
        title: "微信登录失败",
        content: error.message || "请稍后重试；如果提示未配置，请联系平台管理员完成云托管环境变量配置。",
        showCancel: false
      });
    });
  },
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
