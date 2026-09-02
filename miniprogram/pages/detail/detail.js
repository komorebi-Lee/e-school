const { request } = require('../../services/api');
const { getScooter } = require('../../services/store');
Page({
  data: { scooter: null, loading: true },
  onLoad(options) {
    request(`/api/products/${encodeURIComponent(options.id || '')}`).then(({ data }) => {
      this.setData({ scooter: { ...data, price: Math.round(data.priceInCents / 100), subtitle: data.description, range: 45, icon: '车', color: '#eaf0ff' }, loading: false });
    }).catch(() => { this.setData({ scooter: getScooter(options.id), loading: false }); wx.showToast({ title: '云端加载失败，已显示缓存', icon: 'none' }); });
  },
  checkout() { wx.navigateTo({ url: `/pages/consult/consult?type=${encodeURIComponent('电动车')}&interest=${encodeURIComponent(this.data.scooter.name)}` }); }
});
