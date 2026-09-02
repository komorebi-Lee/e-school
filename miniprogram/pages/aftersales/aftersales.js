const { request, userId } = require('../../services/api');
Page({
  data: { orderId: '', typeIndex: 0, types: ['申请退款', '退货', '维修'], apiTypes: ['REFUND', 'RETURN', 'REPAIR'], detail: '', submitting: false },
  onLoad(o) { this.setData({ orderId: o.id || '' }); },
  chooseType(e) { this.setData({ typeIndex: Number(e.detail.value) }); },
  setDetail(e) { this.setData({ detail: e.detail.value }); },
  submit() {
    if (!this.data.detail.trim() || this.data.submitting) return wx.showToast({ title: '请描述具体问题', icon: 'none' });
    this.setData({ submitting: true });
    request('/api/after-sales', { method: 'POST', data: { userId: userId(), orderId: this.data.orderId, type: this.data.apiTypes[this.data.typeIndex], reason: this.data.detail.trim() } }).then(() => wx.showModal({ title: '已提交', content: '客服会在 24 小时内联系你。', showCancel: false, success: () => wx.navigateBack() })).catch((error) => { this.setData({ submitting: false }); wx.showToast({ title: error.message || '提交失败', icon: 'none' }); });
  }
});
