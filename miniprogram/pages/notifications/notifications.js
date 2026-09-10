const { request } = require("../../services/api");

function decorateNotification(item) {
  const type = item.type || "ORDER";
  return {
    ...item,
    type,
    timeText: String(item.createdAt || "").slice(5, 16).replace("T", " "),
    unread: !item.read,
    link: item.link || "",
    typeText: {
      ORDER: "订单", AFTER_SALE: "售后", SCORE: "服务分", SLA: "服务提醒", STOCK: "库存",
      PROMOTION: "优惠活动", PHONE_PLAN: "电话卡", RECHARGE: "话费权益", PLATE: "校园牌照", BROADBAND: "宽带资格"
    }[type] || "业务提醒",
    toneClass: {
      ORDER: "blue", AFTER_SALE: "orange", SCORE: "green", SLA: "orange", STOCK: "blue",
      PROMOTION: "orange", PHONE_PLAN: "blue", RECHARGE: "green", PLATE: "orange", BROADBAND: "blue"
    }[type] || "blue"
  };
}

Page({
  data: {
    loading: true,
    activeFilter: "ALL",
    filters: [
      { key: "ALL", text: "全部" },
      { key: "UNREAD", text: "未读" },
      { key: "ORDER", text: "订单" },
      { key: "AFTER_SALE", text: "售后" },
      { key: "SERVICE", text: "服务提醒" }
    ],
    notifications: [],
    filteredNotifications: [],
    unreadCount: 0
  },
  onShow() {
    this.loadNotifications();
  },
  async loadNotifications() {
    try {
      const { data } = await request("/api/my/notifications");
      const notifications = (data || []).map(decorateNotification);
      this.setData({
        loading: false,
        notifications,
        unreadCount: notifications.filter((item) => item.unread).length
      });
      this.applyFilter();
    } catch (error) {
      this.setData({ loading: false, notifications: [], filteredNotifications: [], unreadCount: 0 });
      wx.showToast({ title: error.message || "消息加载失败", icon: "none" });
    }
  },
  setFilter(event) {
    this.setData({ activeFilter: event.currentTarget.dataset.key || "ALL" });
    this.applyFilter();
  },
  applyFilter() {
    const { activeFilter, notifications } = this.data;
    let filtered = notifications;
    if (activeFilter === "UNREAD") filtered = notifications.filter((item) => item.unread);
    else if (activeFilter === "ORDER") filtered = notifications.filter((item) => item.type === "ORDER");
    else if (activeFilter === "AFTER_SALE") filtered = notifications.filter((item) => item.type === "AFTER_SALE");
    else if (activeFilter === "SERVICE") filtered = notifications.filter((item) => ["SCORE", "SLA", "STOCK", "PROMOTION", "PHONE_PLAN", "RECHARGE", "PLATE", "BROADBAND"].includes(item.type));
    this.setData({ filteredNotifications: filtered });
  },
  async openNotification(event) {
    const id = event.currentTarget.dataset.id;
    const link = event.currentTarget.dataset.link;
    if (!id) return;
    if (event.currentTarget.dataset.unread) {
      try {
        await request(`/api/my/notifications/${encodeURIComponent(id)}/read`, { method: "POST" });
      } catch (_) {
        // 单条已读失败不阻断跳转；页面返回后会重新同步状态。
      }
    }
    if (!link) {
      wx.showToast({ title: "该消息暂无详情页", icon: "none" });
      return;
    }
    wx.navigateTo({ url: link, fail: () => wx.showToast({ title: "详情页暂不可用", icon: "none" }) });
  },
  markAllRead() {
    if (!this.data.unreadCount) return;
    request("/api/my/notifications/read", { method: "POST" }).then(() => {
      wx.showToast({ title: "已全部标记", icon: "success" });
      this.loadNotifications();
    }).catch((error) => wx.showToast({ title: error.message || "操作失败", icon: "none" }));
  }
});
