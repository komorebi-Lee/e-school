const { request, userId } = require('../../services/api');

Page({
  data: { promo: null, orderId: '', paymentOrderId: '', paymentStatus: 'UNPAID', submitting: false, paid: false },
  onLoad(options) {
    const promo = this.decode(options.promo);
    this.setData({
      promo: promo || { id: '', pay: 0, receive: 0, badge: '限时权益', phone: wx.getStorageSync('shishanUserProfile')?.phone || '' },
      orderId: options.orderId ? decodeURIComponent(options.orderId) : ''
    });
    if (!promo) this.loadOrder(this.data.orderId);
  },
  loadOrder(orderId) {
    if (!orderId) return wx.navigateBack();
    request('/api/my/orders?userId=' + encodeURIComponent(userId())).then(({ data }) => {
      const record = (data.serviceRecords || []).find((item) => item.type === 'RECHARGE' && item.id === orderId);
      if (!record) return wx.navigateBack();
      const match = record.title.match(/\u5145(\d+)\u9001(\d+)/);
      this.setData({
        promo: {
          id: record.id,
          pay: match ? Number(match[1]) : Number((record.amountInCents || 0) / 100),
          receive: match ? Number(match[2]) : 0,
          badge: record.badge || '限时权益',
          phone: record.phone
        },
        paymentOrderId: record.paymentOrderId || '',
        paid: record.status !== 'PENDING_PAYMENT' && record.status !== 'CANCELLED'
      });
    }).catch(() => wx.navigateBack());
  },
  decode(value) {
    if (!value) return null;
    let decoded = String(value);
    for (let i = 0; i < 3; i += 1) {
      try {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      } catch (error) { break; }
    }
    if (!/^[\[{]/.test(decoded)) return null;
    try { return JSON.parse(decoded); } catch (error) { return null; }
  },
  createOrder() {
    if (this.data.orderId) return this.simulatePay();
    const saved = wx.getStorageSync('shishanUserProfile') || {};
    const { promo } = this.data;
    if (!saved.phone || !/^1\d{10}$/.test(saved.phone)) {
      return wx.showModal({ title: '补充信息', content: '请先填写本人手机号', showCancel: false });
    }
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    request('/api/recharge-orders', {
      method: 'POST',
      data: { phone: saved.phone, paidInCents: promo.pay * 100, receiveInCents: promo.receive * 100 }
    }).then(({ data, paymentOrder }) => {
      this.setData({ orderId: data.id, paymentOrderId: paymentOrder?.id || '', paymentStatus: 'UNPAID', paid: false });
      return this.simulatePay(paymentOrder?.id);
    }).catch((error) => {
      wx.showModal({ title: '提交失败', content: error.message || '请稍后重试', showCancel: false });
    }).finally(() => this.setData({ submitting: false }));
  },
  simulatePay(paymentOrderId) {
    const paymentId = paymentOrderId || this.data.paymentOrderId;
    if (!this.data.orderId) return this.createOrder();
    if (!paymentId) return wx.showToast({ title: '支付单不存在', icon: 'none' });
    this.setData({ submitting: true });
    wx.showLoading({ title: '模拟支付中', mask: true });
    request(`/api/payment-orders/${encodeURIComponent(paymentId)}/confirm`, { method: 'POST' }).then(({ data }) => {
      this.setData({ paid: true, paymentStatus: data.rechargeOrder?.status || 'PENDING_CREDIT' });
      wx.hideLoading();
      wx.showToast({ title: '支付成功', icon: 'success' });
    }).catch((error) => {
      wx.hideLoading();
      wx.showToast({ title: error.message || '支付失败', icon: 'none' });
    }).finally(() => this.setData({ submitting: false }));
  },
  consult() {
        const { promo, orderId } = this.data;
    wx.navigateTo({
      url: `/pages/consult/consult?type=${encodeURIComponent('话费到账确认')}&interest=${encodeURIComponent(`充${promo.pay}送${promo.receive}（${orderId}）`)}`
    });
  }
});
