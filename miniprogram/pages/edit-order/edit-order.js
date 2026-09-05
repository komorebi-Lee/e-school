const { request } = require('../../services/api');

Page({
  data: { orderId: '', orderNo: '', name: '', phone: '', date: '', timeSlot: '', address: '', deliveryTimeSlots: [], deliveryTimeIndex: 0, loading: true, submitting: false },
  onLoad(options) {
    const id = options.id || '';
    this.setData({ orderId: id, minDate: this.today() });
    request(`/api/orders/${encodeURIComponent(id)}`).then(({ data }) => {
      const fulfillment = data.fulfillment || {};
      const slots = this.data.deliveryTimeSlots.length ? this.data.deliveryTimeSlots : ['尽快配送'];
      const timeSlot = fulfillment.timeSlot || slots[0];
      this.setData({
        orderNo: data.orderNo || id,
        name: fulfillment.contactName || '',
        phone: fulfillment.contactPhone || '',
        date: fulfillment.date || this.today(),
        address: fulfillment.address || '',
        deliveryTimeSlots: slots,
        deliveryTimeIndex: Math.max(0, slots.indexOf(timeSlot)),
        loading: false
      });
    }).catch(() => {
      wx.showToast({ title: '订单加载失败', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 500);
    });
    this.loadSlots();
  },
  loadSlots() {
    request('/api/business-config').then(({ data }) => {
      const slots = Array.isArray(data.deliveryTimeSlots) && data.deliveryTimeSlots.length ? data.deliveryTimeSlots : ['尽快配送'];
      const current = this.data.deliveryTimeSlots[this.data.deliveryTimeIndex];
      this.setData({
        deliveryTimeSlots: slots,
        deliveryTimeIndex: Math.max(0, slots.indexOf(current))
      });
    }).catch(() => {});
  },
  today() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  },
  setName(e) { this.setData({ name: e.detail.value }); },
  setPhone(e) { this.setData({ phone: e.detail.value }); },
  setDate(e) { this.setData({ date: e.detail.value }); },
  setTimeSlot(e) { this.setData({ deliveryTimeIndex: Number(e.detail.value) }); },
  setAddress(e) { this.setData({ address: e.detail.value }); },
  save() {
    const { name, phone, date, timeSlot, address } = this.data;
    if (!name || !phone || !date || !address || this.data.submitting) return wx.showToast({ title: '请填写完整配送信息', icon: 'none' });
    if (!/^1\d{10}$/.test(phone)) return wx.showToast({ title: '请输入正确手机号', icon: 'none' });
    this.setData({ submitting: true });
    request(`/api/orders/${encodeURIComponent(this.data.orderId)}`, {
      method: 'PATCH',
      data: { fulfillment: { type: 'DELIVERY', contactName: name, contactPhone: phone, date, timeSlot, address } }
    }).then(() => {
      wx.showToast({ title: '配送已改约' });
      setTimeout(() => wx.navigateBack(), 500);
    }).catch((error) => {
      this.setData({ submitting: false });
      wx.showToast({ title: error.message || '保存失败', icon: 'none' });
    });
  }
});
