const { request, userId } = require('../../services/api');
const { getScooter } = require('../../services/store');

Page({
  data: { scooter: null, name: '', phone: '', date: '', deliveryAddress: '', submitting: false },
  onShow() { const profile=wx.getStorageSync('shishanUserProfile')||{}; if(profile.name||profile.phone) this.setData({name:profile.name||'',phone:profile.phone||''}); },
  onLoad(options) {
    const id = options.id || '';
    request(`/api/products/${encodeURIComponent(id)}`).then(({ data }) => {
      this.setData({ scooter: { ...data, price: Math.round(data.priceInCents / 100), subtitle: data.description, color: '#eaf0ff', icon: '车' } });
    }).catch(() => {
      const cached = getScooter(id);
      if (cached) this.setData({ scooter: cached });
      else wx.showToast({ title: '商品加载失败', icon: 'none' });
    });
  },
  setName(e) { this.setData({ name: e.detail.value }); },
  setPhone(e) { this.setData({ phone: e.detail.value }); },
  setDate(e) { this.setData({ date: e.detail.value }); },
  setAddress(e) { this.setData({ deliveryAddress: e.detail.value }); },
  submit() {
    const { name, phone, date, deliveryAddress, scooter } = this.data;
    if (!name || !phone || !date || !deliveryAddress || !scooter || this.data.submitting) return wx.showToast({ title: '请填写完整信息', icon: 'none' });
    if (!/^1\d{10}$/.test(phone)) return wx.showToast({ title: '请输入正确手机号', icon: 'none' });
    wx.setStorageSync('shishanUserProfile',{...wx.getStorageSync('shishanUserProfile')||{},name,phone});
    this.setData({ submitting: true });
    request('/api/orders', { method: 'POST', data: { userId: userId(), items: [{ productId: scooter.id, quantity: 1 }], fulfillment: { type: 'DELIVERY', address: deliveryAddress, date, contactName: name, contactPhone: phone } } })
      .then(({ data }) => {
        wx.showModal({ title:'购车订单已提交', content:'系统已同步生成免费校园牌照辅助，可在订单中心跟进。', confirmText:'查看订单', showCancel:false, success:()=>wx.switchTab({url:'/pages/orders/orders'}) });
      })
      .catch((error) => { this.setData({ submitting: false }); wx.showToast({ title: error.message || '提交失败', icon: 'none' }); });
  }
});
