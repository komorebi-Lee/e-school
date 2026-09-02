const { request, userId } = require('../../services/api');
const { getScooter } = require('../../services/store');

Page({
  data: { scooter: null, name: '', phone: '', date: '', deliveryAddress: '', submitting: false },
  onLoad(options) { this.setData({ scooter: getScooter(options.id) }); },
  setName(e) { this.setData({ name: e.detail.value }); },
  setPhone(e) { this.setData({ phone: e.detail.value }); },
  setDate(e) { this.setData({ date: e.detail.value }); },
  setAddress(e) { this.setData({ deliveryAddress: e.detail.value }); },
  submit() {
    const { name, phone, date, deliveryAddress, scooter } = this.data;
    if (!name || !phone || !date || !deliveryAddress || !scooter || this.data.submitting) return wx.showToast({ title: '请填写完整信息', icon: 'none' });
    if (!/^1\d{10}$/.test(phone)) return wx.showToast({ title: '请输入正确手机号', icon: 'none' });
    this.setData({ submitting: true });
    request('/api/orders', { method: 'POST', data: { userId: userId(), items: [{ productId: scooter.id, quantity: 1 }], fulfillment: { type: 'DELIVERY', address: deliveryAddress, date, contactName: name, contactPhone: phone } } })
      .then(({ data }) => { wx.showToast({ title: '订单已提交' }); setTimeout(() => wx.navigateTo({ url: `/pages/consult/consult?type=${encodeURIComponent('电动车')}&interest=${encodeURIComponent(`${scooter.name}（订单 ${data.orderNo || data.id}）`)}` }), 500); })
      .catch((error) => { this.setData({ submitting: false }); wx.showToast({ title: error.message || '提交失败', icon: 'none' }); });
  }
});
