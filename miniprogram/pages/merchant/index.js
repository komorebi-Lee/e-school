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
  FROZEN: '售后冻结',
  SETTLED: '已结算',
  REFUNDED: '已冲销'
};

function decorateSettlement(item) {
  const status = item.settlementStatus || 'PENDING_DELIVERY';
  const availableText = item.availableAt ? String(item.availableAt).slice(5, 10).replace('-', '/') : '';
  const hints = {
    PENDING_DELIVERY: '用户确认交付码后进入账期',
    IN_ACCOUNT_PERIOD: availableText ? `${availableText} 后可结算` : '账期中',
    PENDING_SETTLE: '等待平台打款',
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

Page({
  data: { merchant: null, metrics: null, products: [], orders: [], settlements: [], notifications: [], unreadNotificationCount: 0, loading: true },
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
      this.setData({ merchant: data.merchant, metrics: data.metrics, products: data.products, orders, settlements: (data.settlements || []).slice(0, 5).map(decorateSettlement), loading: false });
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
  }
});
