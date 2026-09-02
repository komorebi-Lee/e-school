Page({
  data: { scooter: null, name: '', phone: '', date: '', deliveryAddress: '' },
  onLoad(options) { const { getScooter } = require('../../services/store'); this.setData({ scooter: getScooter(options.id) }); },
  setName(e) { this.setData({ name: e.detail.value }); },
  setPhone(e) { this.setData({ phone: e.detail.value }); },
  setDate(e) { this.setData({ date: e.detail.value }); },
  setAddress(e) { this.setData({ deliveryAddress: e.detail.value }); },
  submit() { if (!this.data.name || !this.data.phone || !this.data.date || !this.data.deliveryAddress) { wx.showToast({ title: '请填写完整信息', icon: 'none' }); return; } wx.navigateTo({ url: `/pages/consult/consult?type=电动车&interest=${encodeURIComponent(this.data.scooter.name)}` }); }
});
