const { request, userId } = require("../../services/api");
const { loginWeChat } = require("../../lib/cloud-request");
const { loadBusinessConfig } = require("../../services/business");
const { openLink } = require("../../utils/navigation");
const loadState = require("../../utils/load-state");

function maskUserId(id) {
  if (!id) return "";
  return id.length > 14 ? `${id.slice(0, 10)}…${id.slice(-4)}` : id;
}

/**
 * 身份证号格式（18 位、末位可为 X）。
 *
 * 与 `pages/merchant/apply.js` 的 `verifyIdentity` **同一套**校验 —— 两处入口
 * 面向同一个服务端端点，前端判据不一致只会让用户在其中一处被莫名拦下。
 */
const ID_NUMBER_PATTERN = /^\d{17}[\dXx]$/;

/**
 * 把「认证状态块」折算成页面直接可渲染的字段。
 *
 * ## 为什么要有这一层
 *
 * 认证状态**只能来自服务端**（`GET /api/my/identity`）。改造前页面里写的是
 * `this.setData({ verified: true })` —— 点一下按钮，界面就说「已认证」，
 * 而服务端对此一无所知。所以这里刻意不提供任何「本地置为已认证」的入口：
 * `verified` 只是块状态的**投影**，块状态只能由 `loadBlock` 写入。
 *
 * ## 三态文案为什么要区分
 *
 * 角标只认「服务端有没有给出结论」：
 *
 * - 有结论 → 用它（`已认证` / `未认证`）—— 即使这次刷新失败了，上次的结论仍然有效，
 *   把它翻成「未认证」就是在向用户断言一个我们并不知道的事实。
 * - 没有结论 → 读取中说「读取中」，读取失败说「状态未知」。**不得**显示「未认证」。
 *
 * 这与「把失败说成空列表」是同一类错误，只是换了个位置。
 *
 * 纯函数：不访问 `wx` / `this`，可以在 Node 里直接断言。
 *
 * @param {{loading?: boolean, error?: string, data?: object}} [block] 认证状态块。
 * @returns {{verified: boolean, identityBadgeText: string, identity: object|null}}
 *   派生字段：`verified` 供角标样式，`identityBadgeText` 供角标文案，
 *   `identity` 为**脱敏后**的展示对象（未认证或没有结论时为 `null`）。
 */
function identityView(block) {
  const state = block && typeof block === 'object' ? block : {};
  const payload = state.data && typeof state.data === 'object' ? state.data : null;
  const verified = Boolean(payload && payload.verified);
  return {
    verified,
    identityBadgeText: payload
      ? (verified ? '已认证' : '未认证')
      : (state.error ? '状态未知' : '读取中'),
    // ★ 只取脱敏字段。服务端返回的也**只有**脱敏字段 —— 完整姓名与完整身份证号
    // 在 `POST /api/identity/verify` 里就已经被丢弃、从未落库（见 `identityRecords`）。
    // 前端这一层再挡一次，是为了让「页面不可能渲染出完整证件号」成为**结构上**的结论，
    // 而不是「服务端碰巧没返回」的巧合。
    identity: verified ? {
      ownerNameMasked: payload.ownerNameMasked || '',
      idNumberMasked: payload.idNumberMasked || '',
      verifiedAtText: String(payload.verifiedAt || '').slice(0, 10)
    } : null
  };
}

Page({
  data: {
    // 认证状态块（`load-state` 三态：加载中 / 失败 / 已取到）。
    identityBlock: loadState.initialBlock(),
    // 认证表单：**只在未认证时**渲染。提交成功后立刻清空（见 `verify`）。
    identityForm: { ownerName: '', idNumber: '' },
    verifying: false,
    // 以下三个是 `identityBlock` 的派生字段，由 `applyIdentityBlock` 与块一起写入；
    // 初值必须与 `identityView(initialBlock())` 一致。
    verified: false,
    identityBadgeText: '读取中',
    identity: null,
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
  onShow() { this.refreshLoginState(); this.loadIdentity(); this.loadMerchantBadge(); this.loadNotifications(); this.loadOrderMessageState(); },
  onLoad() {
    // 配置加载：`loadBusinessConfig` 内部已用缓存/默认值兜底、永不 reject，
    // 失败也不影响可见内容（客服电话回落到默认值），故显式忽略。
    loadBusinessConfig().then((config) => this.setData({
      customerService: config.servicePhone || config.serviceWechat || '15527111396'
    })).catch(loadState.ignoreSilently);
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
        unread: !item.read,
        link: item.link || ""
      }));
      this.setData({ notifications: items, unreadNotificationCount: (data || []).filter((item) => !item.read).length });
    }).catch(() => this.setData({ notifications: [], unreadNotificationCount: 0 }));
  },
  markNotificationsRead() {
    if (!this.data.unreadNotificationCount) return;
    // 「上报已读」是动作、不是加载：失败不影响用户看到的通知列表，故显式忽略。
    request("/api/my/notifications/read", { method: "POST" }).then(() => this.loadNotifications()).catch(loadState.ignoreSilently);
  },
  openNotification(event) {
    const link = event.currentTarget.dataset.link;
    if (!link) return;
    // 通知链接可能指向 tabBar 页面，统一交给 openLink 判定，失败不再静默
    openLink(link);
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
        success: (result) => {
          const acceptedTemplates = templateIds.filter((templateId) => result[templateId] === "accept");
          if (!acceptedTemplates.length) {
            wx.showToast({ title: "没有获得微信提醒授权", icon: "none" });
            return;
          }
          finish();
        },
        fail: (error) => wx.showToast({ title: error.errMsg || "微信提醒授权失败", icon: "none" })
      });
    }).catch((error) => wx.showToast({ title: error.message || "开启失败", icon: "none" }));
  },
  /**
   * 读取「学生认证」状态（M8-P1-01）。
   *
   * 走 `load-state` 的三态：失败时**保留**上一次的结果，并渲染常驻的错误占位 +
   * 重试按钮，而不是把「读不到」渲染成「未认证」。
   *
   * `loadBlock` **不 rethrow**，所以这里不需要（也不允许）再包一层 `.catch` ——
   * 那正是本次改造要消灭的写法：`.catch(() => this.setData({ verified: false }))`
   * 会把一次网络故障变成一个关于用户身份的结论。
   *
   * @returns {Promise<object|undefined>} 成功时解析为服务端返回的状态对象。
   */
  loadIdentity() {
    return loadState.loadBlock({
      // ★ 唯一的写出口：块状态与派生字段**一次**写完。
      setData: (patch) => this.applyIdentityBlock(patch),
      stateKey: 'identityBlock',
      prev: this.data.identityBlock,
      loader: () => request('/api/my/identity').then(({ data }) => data || { verified: false })
    });
  },

  /**
   * `loadBlock` 的 setData 出口。
   *
   * 为什么需要它：页面要渲染的字段（角标文案、脱敏结果）是从**块状态**算出来的。
   * 若让它们各自 `setData`，就可能出现「角标说已认证、卡片却在显示认证表单」
   * 这种自相矛盾的中间态。这里保证「块变了 → 派生字段跟着变」，两者永远同源。
   *
   * @param {object} patch `loadBlock` 写出的补丁。
   * @returns {void}
   */
  applyIdentityBlock(patch) {
    this.setData(patch);
    this.setData(identityView(this.data.identityBlock));
  },

  /** 重新读取认证状态（错误占位上的「重试」）。 */
  retryIdentity() {
    return this.loadIdentity();
  },

  /**
   * 认证表单的输入绑定（`data-field` 指定字段名）。
   *
   * @param {object} event 输入事件。
   * @returns {void}
   */
  setIdentityField(event) {
    const field = event.currentTarget.dataset.field;
    if (!field) return;
    this.setData({ [`identityForm.${field}`]: event.detail.value });
  },

  /**
   * 提交学生认证（真实调用 `POST /api/identity/verify`）。
   *
   * ## 与改造前的区别
   *
   * 改造前这里只有一行：`this.setData({ verified: true })` —— 界面上的「已认证」
   * 与任何后端状态都没有关系，按钮上还写着「模拟认证」。现在认证是真的：
   * 提交成功后**必须**重新拉一次 `GET /api/my/identity`，`verified` 只认服务端的回答。
   * 本地乐观置 `true` 会让页面显示一个库里并不存在的状态 —— 刷新一下就穿帮。
   *
   * ## 为什么提交成功后清空输入
   *
   * 身份证号已经完成使命，继续留在页面数据里没有任何用途，只是让敏感信息多活一会儿。
   * 服务端那边同样只留脱敏值（见 `identityRecords`）。
   *
   * ## 失败路径
   *
   * 这是**动作类**请求（不是加载块），失败用 toast 提示并保留用户已填内容 ——
   * 与「动作类失败不得产生错误占位」的既有约定一致；`catch` 里是真实的错误处理，
   * 不是空 catch。
   *
   * @returns {Promise<void>} 提交（含成功后的状态刷新）结束后解析。
   */
  verify() {
    if (this.data.verifying) return Promise.resolve();
    const ownerName = String(this.data.identityForm.ownerName || '').trim();
    const idNumber = String(this.data.identityForm.idNumber || '').trim();
    if (ownerName.length < 2 || !ID_NUMBER_PATTERN.test(idNumber)) {
      wx.showToast({ title: '请输入真实姓名和 18 位身份证号', icon: 'none' });
      return Promise.resolve();
    }
    this.setData({ verifying: true });
    let accepted = false;
    return request('/api/identity/verify', {
      method: 'POST',
      // 不传 `userId`：服务端读的是**会话**（`requireUser(request)` 解析 Bearer 令牌），
      // body 里的 `userId` 会被忽略。`merchant/apply.js` 传了它，但那是历史写法 ——
      // 传一个不参与鉴权的字段，会让人误以为它是身份的依据。
      data: { ownerName, idNumber }
    }).then(() => {
      accepted = true;
      this.setData({ verifying: false, identityForm: { ownerName: '', idNumber: '' } });
      wx.showToast({ title: '认证成功', icon: 'success' });
    }).catch((error) => {
      this.setData({ verifying: false });
      wx.showToast({ title: (error && error.message) || '认证失败，请稍后重试', icon: 'none' });
      // 只有真的认证成功才去刷新状态：失败时重拉一遍没有意义，还会把
      // 「提交失败」的现场冲掉。`loadBlock` 不 rethrow，所以这一步不会误触发上面的 catch。
    }).then(() => (accepted ? this.loadIdentity() : undefined));
  },
  goOrders() { wx.switchTab({ url: "/pages/orders/orders" }); },
  goNotifications() { wx.navigateTo({ url: "/pages/notifications/notifications" }); },
  goFavorites() { wx.navigateTo({ url: "/pages/favorites/favorites" }); },
  goAddresses() { wx.navigateTo({ url: "/pages/addresses/addresses" }); },
  goMyReviews() { wx.navigateTo({ url: "/pages/reviews/reviews" }); },
  goFootprints() { wx.navigateTo({ url: "/pages/footprints/footprints" }); },
  /**
   * 「我的帖子」（M7-P1-01）。
   *
   * 走 `openLink` 而不是裸 `wx.navigateTo`：站内跳转统一由它分发（tabBar 页要
   * `switchTab`、失败要提示而不是静默）。`forum/mine` 目前不是 tabBar 页，
   * `openLink` 会走 `navigateTo`；将来若它变成 tabBar 页，这里不用改。
   */
  goMyForumPosts() { openLink("/pages/forum/mine"); },
  /**
   * 「我发布的闲置」（M6-P1-01）。与上面的「我的帖子」**同级**。
   *
   * 同样走 `openLink`：站内跳转统一由它分发（tabBar 页要 `switchTab`、
   * 失败要提示而不是静默）。`market/mine` 目前不是 tabBar 页，
   * `openLink` 会走 `navigateTo`；将来若它变成 tabBar 页，这里不用改。
   */
  goMyMarketItems() { openLink("/pages/market/mine"); },
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
