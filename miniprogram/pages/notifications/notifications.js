const { request } = require("../../services/api");
const { openLink } = require("../../utils/navigation");
const loadState = require("../../utils/load-state");

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
    unreadCount: 0,
    // ★ 加载失败的可见状态（T49）。非空即表示「当前展示的是失败态」。
    error: "",
    // ★ 是否**成功加载过至少一次**。
    //   为什么不能只看 `unreadCount`：失败时它停在 0，而 0 是个**合法值**（确实都读完了），
    //   于是工具栏会渲染「消息都已读完」—— 一条我们并不知道的事实。
    //   分页改造后这个标志同样必要：它区分「还没加载」与「加载了但是空」。
    loaded: false
  },
  onShow() {
    this.loadNotifications();
  },
  /**
   * 加载通知列表。
   *
   * ★ 失败时**不清空** `notifications` / `filteredNotifications` / `unreadCount`（T49）：
   *   - 改造前失败会 `setData({notifications:[], filteredNotifications:[], unreadCount:0})`，
   *     页面渲染出「消息都已读完」+「这个筛选下暂无消息」两句假陈述，
   *     用户会以为平台真的没给他发过任何消息；
   *   - 保留旧列表还有一层意义：**为将来的分页做好准备** ——
   *     「加载更多」失败时已有项必须原样留着，否则用户往下翻一次就丢掉全部已读内容。
   *
   * 失败只写成可见状态（`error` + 重试），不再只弹一个会消失的 toast。
   */
  async loadNotifications() {
    try {
      const { data } = await request("/api/my/notifications");
      const notifications = (data || []).map(decorateNotification);
      this.setData({
        loading: false,
        error: "",
        loaded: true,
        notifications,
        unreadCount: notifications.filter((item) => item.unread).length
      });
      this.applyFilter();
    } catch (error) {
      this.setData({ loading: false, error: loadState.blockErrorText(error) });
    }
  },
  retryNotifications() { return this.loadNotifications(); },
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
    // 通知链接可能指向 tabBar 页面（如 /pages/orders/orders?focusId=...），
    // navigateTo 必然失败，必须统一走 openLink 由它决定 switchTab 还是 navigateTo。
    openLink(link, { fail: () => wx.showToast({ title: "详情页暂不可用", icon: "none" }) });
  },
  markAllRead() {
    if (!this.data.unreadCount) return;
    request("/api/my/notifications/read", { method: "POST" }).then(() => {
      wx.showToast({ title: "已全部标记", icon: "success" });
      this.loadNotifications();
    }).catch((error) => wx.showToast({ title: error.message || "操作失败", icon: "none" }));
  }
});
