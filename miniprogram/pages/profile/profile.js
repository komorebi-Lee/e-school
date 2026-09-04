const { request, userId } = require("../../services/api");
const { loginWeChat } = require("../../lib/cloud-request");

function maskUserId(id) {
  if (!id) return "";
  return id.length > 14 ? `${id.slice(0, 10)}…${id.slice(-4)}` : id;
}

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
    this.setData({ userId: maskUserId(stored), loginState: stored ? "ready" : "guest" });
  },
  loginWithWeChat() {
    if (this.data.loggingIn) return;
    this.setData({ loggingIn: true });
    loginWeChat().then(({ userId: id }) => {
      this.setData({ userId: maskUserId(id), loginState: "ready", loggingIn: false });
      wx.showToast({ title: "登录成功", icon: "success" });
      this.loadMerchantBadge();
    }).catch((error) => {
      this.setData({ loggingIn: false });
      const reason = error.details && error.details.reason ? `（${error.details.reason}）` : '';
      wx.showModal({
        title: "微信登录失败",
        content: (error.message || "请稍后重试") + reason,
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
