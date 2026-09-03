const { request, userId } = require('../../services/api');
const { API_BASE_URL } = require('../../config/api');

Page({
  data: { merchant: null, metrics: null, products: [], orders: [], loading: true },
  onShow() {
    this.load();
  },
  request(path, token, options = {}) {
    return new Promise((resolve, reject) => {
      wx.request({
        url: `${API_BASE_URL}${path}`,
        method: options.method || 'GET',
        data: options.data,
        header: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        success: (response) => response.statusCode >= 200 && response.statusCode < 300 ? resolve(response.data) : reject(new Error(response.data?.error?.message || '请求失败')),
        fail: reject
      });
    });
  },
  load() {
    const tryLogin = (merchantId) => {
      return request('/api/merchant/login', {
        method: 'POST',
        data: { userId: userId(), merchantId }
      }).then(({ data }) => {
        wx.setStorageSync('campusGoMerchantToken', data.token);
        return this.request('/api/merchant/overview', data.token);
      });
    };
    const merchantId = wx.getStorageSync('campusGoMerchantId');
    (merchantId ? tryLogin(merchantId) : request(`/api/merchants?userId=${encodeURIComponent(userId())}`).then(({ data }) => {
      const approved = data.find((item) => item.status === 'APPROVED');
      if (!approved) throw new Error('NOT_APPROVED');
      wx.setStorageSync('campusGoMerchantId', approved.id);
      return tryLogin(approved.id);
    })).then(({ data }) => {
      this.setData({ merchant: data.merchant, metrics: data.metrics, products: data.products, orders: data.orders.slice(0, 5), loading: false });
    }).catch(() => {
      this.setData({ loading: false });
      wx.removeStorageSync('campusGoMerchantId');
      request(`/api/merchants?userId=${encodeURIComponent(userId())}`).then(({ data }) => {
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
  }
});
