const { request: apiRequest, userId } = require('../../services/api');

const orderStatusLabels = {
  PENDING_PAYMENT: '待支付',
  PAID: '待发货',
  FULFILLING: '履约中',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
  AFTER_SALE: '售后中'
};

// 分账要经过“交付核验 → 账期 → 可结算”，商家需要看懂钱卡在哪一步。
const settlementStageLabels = {
  PENDING_DELIVERY: '待交付核验',
  IN_ACCOUNT_PERIOD: '账期中',
  PENDING_SETTLE: '可结算',
  PAYOUT_REQUESTED: '提现待审核',
  FROZEN: '售后冻结',
  SETTLED: '已结算',
  REFUNDED: '已冲销'
};

const payoutStatusLabels = {
  PENDING_REVIEW: '待平台审核',
  SETTLED: '已打款',
  REJECTED: '已驳回',
  CANCELLED: '已关闭'
};

function decorateSettlement(item) {
  const status = item.settlementStatus || 'PENDING_DELIVERY';
  const availableText = item.availableAt ? String(item.availableAt).slice(5, 10).replace('-', '/') : '';
  const hints = {
    PENDING_DELIVERY: '用户确认交付码后进入账期',
    IN_ACCOUNT_PERIOD: availableText ? `${availableText} 后可结算` : '账期中',
    PENDING_SETTLE: '等待平台打款',
    PAYOUT_REQUESTED: '提现申请已提交，等待平台审核',
    FROZEN: item.frozenReason || '售后处理中，暂停打款',
    SETTLED: item.settlementReference ? `凭证 ${item.settlementReference}` : '已完成打款',
    REFUNDED: '订单退款，分账已冲销'
  };
  return {
    ...item,
    stageLabel: settlementStageLabels[status] || status,
    stageHint: hints[status] || '',
    stageTone: status === 'PENDING_SETTLE' ? 'done' : status === 'FROZEN' || status === 'REFUNDED' ? 'warn' : status === 'SETTLED' ? 'blue' : 'todo'
  };
}

function decoratePayoutRequest(item) {
  const status = item.status || 'PENDING_REVIEW';
  return {
    ...item,
    amountText: ((item.amountInCents || 0) / 100).toFixed(2),
    statusLabel: payoutStatusLabels[status] || status,
    statusTone: status === 'SETTLED' ? 'blue' : status === 'REJECTED' || status === 'CANCELLED' ? 'warn' : 'todo',
    createdText: String(item.createdAt || '').slice(5, 16).replace('T', ' '),
    noteText: item.reviewNote || (status === 'PENDING_REVIEW' ? '平台核对收款账户后打款' : ''),
    accountText: `${item.accountBank || ''} ${item.accountMasked || ''}`.trim()
  };
}

Page({
  data: {
    merchant: null, metrics: null, products: [], orders: [], settlements: [], payoutRequests: [],
    notifications: [], unreadNotificationCount: 0, loading: true,
    payoutMinimumText: '100.00', payableText: '0.00', canRequestPayout: false, payoutHint: '', payoutSubmitting: false
  },
  onShow() {
    this.load();
  },

  // 商家态接口统一带上登录后的商家 token，避免调用方漏传导致 401。
  request(path, options = {}) {
    const token = this.merchantToken || wx.getStorageSync('campusGoMerchantToken');
    return apiRequest(path, { ...options, header: { authorization: `Bearer ${token}` } });
  },
  load() {
    const tryLogin = (merchantId) => {
      return apiRequest('/api/merchant/login', {
        method: 'POST',
        data: { userId: userId(), merchantId }
      }).then(({ data }) => {
        this.merchantToken = data.token;
        wx.setStorageSync('campusGoMerchantToken', data.token);
        return this.request('/api/merchant/overview');
      });
    };
    const merchantId = wx.getStorageSync('campusGoMerchantId');
    (merchantId ? tryLogin(merchantId) : apiRequest(`/api/merchants?userId=${encodeURIComponent(userId())}`).then(({ data }) => {
      const approved = data.find((item) => item.status === 'APPROVED');
      if (!approved) throw new Error('NOT_APPROVED');
      wx.setStorageSync('campusGoMerchantId', approved.id);
      return tryLogin(approved.id);
    })).then(({ data }) => {
      const orders = (data.orders || []).slice(0, 5).map((order) => ({
        ...order,
        statusLabel: orderStatusLabels[order.status] || order.status
      }));
      const settlementMetrics = data.metrics?.settlementMetrics || {};
      const payableInCents = Number(settlementMetrics.payableInCents || 0);
      const minimumInCents = Number(settlementMetrics.payoutMinimumInCents || 0);
      const pendingRequest = settlementMetrics.pendingPayoutRequest;
      this.setData({
        merchant: data.merchant,
        metrics: data.metrics,
        products: data.products,
        orders,
        settlements: (data.settlements || []).slice(0, 5).map(decorateSettlement),
        payoutRequests: (data.payoutRequests || []).slice(0, 3).map(decoratePayoutRequest),
        payableText: (payableInCents / 100).toFixed(2),
        payoutMinimumText: (minimumInCents / 100).toFixed(2),
        canRequestPayout: Boolean(data.merchant?.settlementAccountReady) && !pendingRequest && payableInCents >= minimumInCents && payableInCents > 0,
        payoutHint: this.buildPayoutHint(data.merchant, settlementMetrics, payableInCents, minimumInCents),
        loading: false
      });
      return this.request('/api/merchant/notifications').then(({ data: items }) => {
        const notifications = (items || []).slice(0, 5).map((item) => ({
          ...item,
          timeText: String(item.createdAt || '').slice(5, 16).replace('T', ' ')
        }));
        const unreadNotificationCount = (items || []).filter((item) => !item.read).length;
        this.setData({ notifications, unreadNotificationCount });
        if (unreadNotificationCount) return this.request('/api/merchant/notifications/read', { method: 'POST' });
      }).catch(() => {});
    }).catch(() => {
      this.setData({ loading: false });
      wx.removeStorageSync('campusGoMerchantId');
      apiRequest(`/api/merchants?userId=${encodeURIComponent(userId())}`).then(({ data }) => {
        const pending = data.find((item) => item.status === 'REVIEWING');
        if (pending) wx.redirectTo({ url: `/pages/merchant/apply` });
        else this.goApply();
      }).catch(() => this.goApply());
    });
  },
  goApply() {
    wx.redirectTo({ url: '/pages/merchant/apply' });
  },
  goOrders() {
    wx.navigateTo({ url: '/pages/merchant/orders' });
  },
  goProducts() {
    wx.navigateTo({ url: '/pages/merchant/products' });
  },
  goReviews() {
    wx.navigateTo({ url: '/pages/merchant/reviews' });
  },

  // 商家只能发起申请，实际打款由平台在管理端审核，前端提前把不满足的原因说清楚。
  buildPayoutHint(merchant, metrics, payableInCents, minimumInCents) {
    if (!merchant?.settlementAccountReady) return '请先补全收款账户资料才能申请提现';
    if (metrics.pendingPayoutRequest) return `提现单 ${metrics.pendingPayoutRequest.requestNo} 正在审核中`;
    if (!payableInCents) {
      if (metrics.frozenInCents) return '有分账处于售后冻结，售后关闭后可申请';
      if (metrics.inAccountPeriodInCents) return '账期到期后可申请提现';
      if (metrics.pendingDeliveryInCents) return '完成交付核验后进入账期';
      return '暂无可提现金额';
    }
    if (payableInCents < minimumInCents) return `还差 ¥${((minimumInCents - payableInCents) / 100).toFixed(2)} 达到起提金额`;
    return `可提现 ¥${(payableInCents / 100).toFixed(2)}，提交后由平台审核打款`;
  },

  requestPayout() {
    if (this.data.payoutSubmitting || !this.data.canRequestPayout) return;
    const account = `${this.data.merchant?.settlementBank || ''} ${this.data.merchant?.settlementAccountMasked || ''}`.trim();
    wx.showModal({
      title: '申请提现',
      content: `提现金额 ¥${this.data.payableText}\n收款账户 ${account || '请核对'}\n平台审核通过后打款`,
      confirmText: '提交申请',
      success: (result) => {
        if (!result.confirm) return;
        this.setData({ payoutSubmitting: true });
        this.request('/api/merchant/payout-requests', { method: 'POST', data: { remark: '商家工作台申请' } })
          .then(({ data }) => {
            wx.showToast({ title: `已提交 ${data.requestNo}`, icon: 'success' });
            this.setData({ payoutSubmitting: false });
            this.load();
          })
          .catch((error) => {
            this.setData({ payoutSubmitting: false });
            wx.showModal({ title: '暂不能提现', content: error.message || '请稍后重试', showCancel: false });
          });
      }
    });
  }
});
