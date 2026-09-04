const { request, userId } = require('../../services/api');

Page({
  data: { promo: null, orderId: '', paymentStatus: 'UNPAID', submitting: false, paid: false },
  onLoad(options) {
    const promo = this.decode(options.promo);
    this.setData({
      promo: promo || { id: '', pay: 0, receive: 0, badge: '限时权益', phone: wx.getStorageSync('shishanUserProfile')?.phone || '' },
      orderId: this.decode(options.orderId)
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
        paid: record.status !== 'UNPAID'
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
    try { return JSON.parse(decoded); } catch (error) { return null; }
  },
  createOrder() {
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
    }).then(({ data }) => {
      this.setData({ orderId: data.id, paymentStatus: 'UNPAID' });
      this.simulatePay();
    }).catch((error) => {
      wx.showModal({ title: '提交失败', content: error.message || '请稍后重试', showCancel: false });
    }).finally(() => this.setData({ submitting: false }));
  },
  simulatePay() {
    if (!this.data.orderId) return this.createOrder();
    this.setData({ submitting: true });
    wx.showLoading({ title: '模拟支付中', mask: true });
    setTimeout(() => {
      wx.hideLoading();
      this.setData({ paid: true, paymentStatus: 'PENDING_CREDIT', submitting: false });
      wx.showToast({ title: '支付成功', icon: 'success' });
    }, 900);
  },
  consult() {
    const { promo, orderId } = this.data;
    wx.navigateTo({
      url: `/pages/consult/consult?type=${encodeURIComponent('话费到账确认')}&interest=${encodeURIComponent(`充${promo.pay}送${promo.receive}（${orderId}）`)}`
    });
  }
});
