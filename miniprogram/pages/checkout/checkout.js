const { request, userId } = require('../../services/api');
const { getScooter } = require('../../services/store');
const { loadBusinessConfig } = require('../../services/business');

Page({
  data: { scooter: null, config: null, deliveryTimeSlots: [], deliveryTimeIndex: 0, name: '', phone: '', date: '', minDate: '', deliveryAddress: '', submitting: false, payToken: '', itemsFee: 0, deliveryFee: 0, totalFee: 0 },
  onShow() {
    const now = new Date();
    const minDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const profile=wx.getStorageSync('shishanUserProfile')||{};
    this.setData({ minDate, name:profile.name||'', phone:profile.phone||'', date: this.data.date || minDate });
  },
  onLoad(options) {
    const id = options.id || '';
    this.setData({ payToken: `ebike-${id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
    request(`/api/products/${encodeURIComponent(id)}`).then(({ data }) => {
      this.setData({ scooter: { ...data, price: Math.round(data.priceInCents / 100), subtitle: data.description, color: '#eaf0ff', icon: '车' } });
      this.updateTotals();
    }).catch(() => {
      const cached = getScooter(id);
      if (cached) this.setData({ scooter: cached });
      else wx.showToast({ title: '商品加载失败', icon: 'none' });
    });
    loadBusinessConfig().then((config) => {
      this.setData({ config, deliveryTimeSlots: config.deliveryTimeSlots });
      this.updateTotals();
    });
  },
  updateTotals() {
    const scooter = this.data.scooter;
    if (!scooter) return;
    const deliveryFee = this.data.config ? this.data.config.deliveryFee : 0;
    const itemsFee = scooter.price || 0;
    this.setData({ itemsFee, deliveryFee, totalFee: itemsFee + deliveryFee });
  },
  setName(e) { this.setData({ name: e.detail.value }); },
  setPhone(e) { this.setData({ phone: e.detail.value }); },
  setDate(e) { this.setData({ date: e.detail.value }); },
  setDeliveryTime(e) { this.setData({ deliveryTimeIndex: Number(e.detail.value) }); },
  setAddress(e) { this.setData({ deliveryAddress: e.detail.value }); },
  submit() {
    const { name, phone, date, deliveryAddress, scooter } = this.data;
    if (!name || !phone || !date || !deliveryAddress || !scooter || this.data.submitting) return wx.showToast({ title: '请填写完整信息', icon: 'none' });
    if (!/^1\d{10}$/.test(phone)) return wx.showToast({ title: '请输入正确手机号', icon: 'none' });
    wx.setStorageSync('shishanUserProfile',{...wx.getStorageSync('shishanUserProfile')||{},name,phone});
    this.setData({ submitting: true });
    request('/api/orders', { method: 'POST', header: { 'Idempotency-Key': this.data.payToken }, data: { userId: userId(), items: [{ productId: scooter.id, quantity: 1 }], fulfillment: { type: 'DELIVERY', address: deliveryAddress, date, timeSlot: this.data.deliveryTimeSlots[this.data.deliveryTimeIndex] || '', contactName: name, contactPhone: phone } } })
      .then(({ data, paymentOrder }) => {
        if (!paymentOrder || !paymentOrder.id) throw new Error('支付单创建失败');
        return request(`/api/payment-orders/${encodeURIComponent(paymentOrder.id)}/confirm`, { method: 'POST' }).then(({ data: result }) => {
          wx.showModal({
            title: '模拟支付成功',
            content: `订单 ${result.order.orderNo} 已支付。平台购车订单会同步生成免费校园牌照辅助。`,
            confirmText: '查看订单',
            showCancel: false,
            success: () => wx.switchTab({ url: '/pages/orders/orders' })
          });
        });
      })
      .catch((error) => { this.setData({ submitting: false }); wx.showToast({ title: error.message || '提交失败', icon: 'none' }); });
  }
});
