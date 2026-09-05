const { request: apiRequest, userId } = require('../../services/api');

Page({
  data: { merchant: null, metrics: null, products: [], orders: [], settlements: [], notifications: [], unreadNotificationCount: 0, loading: true },
  onShow() {
    this.load();
  },

  request(path, token, options = {}) {
    return apiRequest(path, { ...options, header: { authorization: `Bearer ${token}` } });
  },
  load() {
    const tryLogin = (merchantId) => {
      return apiRequest('/api/merchant/login', {
        method: 'POST',
        data: { userId: userId(), merchantId }
      }).then(({ data }) => {
        wx.setStorageSync('campusGoMerchantToken', data.token);
        return this.request('/api/merchant/overview', data.token);
      });
    };
    const merchantId = wx.getStorageSync('campusGoMerchantId');
    (merchantId ? tryLogin(merchantId) : apiRequest(`/api/merchants?userId=${encodeURIComponent(userId())}`).then(({ data }) => {
      const approved = data.find((item) => item.status === 'APPROVED');
      if (!approved) throw new Error('NOT_APPROVED');
      wx.setStorageSync('campusGoMerchantId', approved.id);
      return tryLogin(approved.id);
    })).then(({ data }) => {
      this.setData({ merchant: data.merchant, metrics: data.metrics, products: data.products, orders: data.orders.slice(0, 5), settlements: (data.settlements || []).slice(0, 5), loading: false });
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
