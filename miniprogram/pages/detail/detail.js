const { request } = require('../../services/api');
const { getScooter } = require('../../services/store');

function normalizeProduct(product) {
  const description = product.description || '支持校内配送和校园牌照辅助。';
  return {
    ...product,
    price: Math.round((product.priceInCents || 0) / 100),
    subtitle: description,
    badge: product.badge || '校园专享',
    range: product.range || (product.id === 'prod_ebike_rent_001' ? '70 km' : '45 km'),
    speed: product.speed || '25 km/h',
    policy: product.policy || '支持华中农业大学狮山校区校园牌照辅助申请。',
    service: product.service || ['校内配送', '平台购车牌照辅助', '售后专人跟进'],
    color: product.color || '#eaf0ff',
    icon: product.icon || '车',
    merchantName: product.merchantName || '平台自营',
    stockText: product.stock > 0 ? (product.stock < 5 ? `仅剩 ${product.stock} 件` : `库存 ${product.stock}`) : '已售罄'
  };
}

Page({
  data: { scooter: null, loading: true },
  onLoad(options) {
    request(`/api/products/${encodeURIComponent(options.id || '')}`).then(({ data }) => {
      this.setData({ scooter: normalizeProduct(data), loading: false });
    }).catch(() => {
      const cached = getScooter(options.id);
      if (cached) this.setData({ scooter: normalizeProduct(cached), loading: false });
      else { this.setData({ loading: false }); wx.showToast({ title: '商品加载失败', icon: 'none' }); }
    });
  },
  checkout() {
    if (this.data.scooter.stock <= 0) return wx.showToast({ title: '该车型已售罄', icon: 'none' });
    wx.navigateTo({ url: `/pages/checkout/checkout?id=${encodeURIComponent(this.data.scooter.id)}` });
  }
});
