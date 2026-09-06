const { request, userId } = require("../../services/api");
const { loginWeChat } = require("../../lib/cloud-request");
const { loadBusinessConfig } = require("../../services/business");

function maskUserId(id) {
  if (!id) return "";
  return id.length > 14 ? `${id.slice(0, 10)}…${id.slice(-4)}` : id;
}

Page({
  data: {
    verified: false,
    customerService: "15527111396",
    merchantBadge: false,
    notifications: [],
    unreadNotificationCount: 0,
    latestApprovedAt: "",
    userId: "",
    loginState: "loading",
    loggingIn: false,
    orderMessageSubscribed: false
  },
  onShow() { this.refreshLoginState(); this.loadMerchantBadge(); this.loadNotifications(); this.loadOrderMessageState(); },
  onLoad() {
    loadBusinessConfig().then((config) => this.setData({
      customerService: config.servicePhone || config.serviceWechat || '15527111396'
    })).catch(() => {});
  },
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
  loadNotifications() {
    request("/api/my/notifications").then(({ data }) => {
      const items = (data || []).slice(0, 3).map((item) => ({
        ...item,
        timeText: String(item.createdAt || "").slice(5, 16).replace("T", " "),
        unread: !item.read
      }));
      this.setData({ notifications: items, unreadNotificationCount: (data || []).filter((item) => !item.read).length });
    }).catch(() => this.setData({ notifications: [], unreadNotificationCount: 0 }));
  },
  markNotificationsRead() {
    if (!this.data.unreadNotificationCount) return;
    request("/api/my/notifications/read", { method: "POST" }).then(() => this.loadNotifications()).catch(() => {});
  },
  loadOrderMessageState() {
    request("/api/order-message-subscriptions").then(({ data }) => {
      this.setData({ orderMessageSubscribed: data.subscribed === true });
    }).catch(() => this.setData({ orderMessageSubscribed: false }));
  },
  toggleOrderMessages() {
    if (this.data.orderMessageSubscribed) {
      request("/api/order-message-subscriptions", { method: "POST", data: { accepted: false } }).then(() => {
        this.setData({ orderMessageSubscribed: false });
        wx.showToast({ title: "已关闭提醒", icon: "success" });
      }).catch((error) => wx.showToast({ title: error.message || "设置失败", icon: "none" }));
      return;
    }
    request("/api/subscribe-templates").then(({ data }) => {
      const templateIds = data.filter((item) => item.audience === "USER").map((item) => item.configuredId).filter(Boolean).slice(0, 3);
      const finish = () => request("/api/order-message-subscriptions", { method: "POST", data: { accepted: true } }).then(() => {
        this.setData({ orderMessageSubscribed: true });
        wx.showToast({ title: "已开启提醒", icon: "success" });
      });
      if (!templateIds.length) {
        return finish();
      }
      wx.requestSubscribeMessage({
        tmplIds: templateIds,
        complete: finish
      });
    }).catch((error) => wx.showToast({ title: error.message || "开启失败", icon: "none" }));
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
  goAgreement() { wx.navigateTo({ url: "/pages/agreement/agreement?type=privacy" }); },
  callService() { wx.makePhoneCall({ phoneNumber: this.data.customerService }); },
  copyWechat() { wx.setClipboardData({ data: this.data.customerService }); }
});
