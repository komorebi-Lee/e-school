const { request, userId } = require('../../services/api');
const { getOrders, updateOrder } = require('../../services/store');
Page({
  data: { orderId: '', name: '', phone: '', time: '', note: '', submitting: false },
  onLoad(o) { const id = o.id || ''; const order = getOrders().find(item => item.id === id) || {}; const f = order.fulfillment || {}; this.setData({ orderId: id, name: f.contactName || order.name || '', phone: f.contactPhone || order.phone || '', time: f.date || order.expectedTime || '', note: f.address || order.note || '' }); },
  setName(e) { this.setData({ name: e.detail.value }); }, setPhone(e) { this.setData({ phone: e.detail.value }); }, setTime(e) { this.setData({ time: e.detail.value }); }, setNote(e) { this.setData({ note: e.detail.value }); },
  save() { if (!this.data.name || !this.data.phone || this.data.submitting) return wx.showToast({ title: '请填写姓名和电话', icon: 'none' }); this.setData({ submitting: true }); request(`/api/orders/${encodeURIComponent(this.data.orderId)}`, { method: 'PATCH', data: { userId: userId(), fulfillment: { contactName: this.data.name, contactPhone: this.data.phone, date: this.data.time, address: this.data.note } } }).then(() => { updateOrder(this.data.orderId, { name: this.data.name, phone: this.data.phone, expectedTime: this.data.time, note: this.data.note }); wx.showToast({ title: '已保存' }); setTimeout(() => wx.navigateBack(), 500); }).catch((error) => { this.setData({ submitting: false }); wx.showToast({ title: error.message || '保存失败', icon: 'none' }); }); }
});
