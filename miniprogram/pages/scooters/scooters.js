const { request } = require('../../services/api');
const { getScooters } = require('../../services/store');
Page({
  data: { scooters: [], loading: true },
  onLoad() { this.loadProducts(); },
  loadProducts() {
    request('/api/products?category=E_BIKE_NEW').then(({ data }) => {
      this.setData({ scooters: (data || []).map(item => ({ ...item, price: Math.round(item.priceInCents / 100), subtitle: item.description, range: 45, icon: '车', color: '#eaf0ff' })), loading: false });
    }).catch(() => { this.setData({ scooters: getScooters(), loading: false }); wx.showToast({ title: '云端加载失败，已显示缓存', icon: 'none' }); });
  },
  goDetail(e) { wx.navigateTo({ url: `/pages/detail/detail?id=${e.currentTarget.dataset.id}` }); }
});
