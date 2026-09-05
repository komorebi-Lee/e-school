const { request, userId } = require('../../services/api');

const typeOptions = [
  { key:'REFUND', label:'申请退款', copy:'未发货、商品异常或双方协商退款', reasons:['商家未按时配送，申请退款','商品与描述不一致，申请退款','临时不需要了，和商家已沟通'] },
  { key:'RETURN', label:'退货', copy:'收到后存在质量问题或误发商品', reasons:['车辆有质量问题，需要退货','收到商品型号不对','包装破损，申请退货'] },
  { key:'REPAIR', label:'维修', copy:'校内使用异常，优先协调售后处理', reasons:['车辆无法正常启动','刹车或续航异常，需要检修','配送后无法正常骑行'] }
];

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
}

Page({
  data: {
    orderId: '', order: null, existing: null, typeOptions, selectedType: typeOptions[0],
    detail: '', submitting: false, loading: true, dueText: ''
  },
  onLoad(options) {
    this.setData({ orderId: options.id || '' });
    this.loadContext();
  },
  loadContext() {
    return Promise.all([
      request('/api/my/orders'),
      request('/api/after-sales')
    ]).then(([orderData, afterSaleData]) => {
      const order = (orderData.data?.ebikeOrders || []).find(item => item.id === this.data.orderId) || null;
      const existing = (afterSaleData.data || []).find(item => item.orderId === this.data.orderId && item.status !== 'CLOSED') || null;
      this.setData({
        order: order ? {
          title: order.items.map(item => `${item.name}${item.quantity > 1 ? ` ×${item.quantity}` : ''}`).join(' + '),
          orderNo: order.orderNo || order.id,
          priceText: order.totalInCents ? `¥${(order.totalInCents / 100).toFixed(2)}` : '',
          merchantName: order.merchantName || '平台自营',
          statusLabel: order.statusLabel || order.status
        } : null,
        existing: existing ? {
          id: existing.id,
          typeLabel: existing.typeLabel || existing.type,
          statusLabel: { SUBMITTED:'已提交', REVIEWING:'处理中', CLOSED:'已关闭' }[existing.status] || existing.status,
          dueText: formatDate(existing.responseDueAt)
        } : null,
        loading: false
      });
    }).catch(() => this.setData({ loading:false }));
  },
  chooseType(e) {
    const selectedType = this.data.typeOptions.find(item => item.key === e.currentTarget.dataset.key) || this.data.typeOptions[0];
    this.setData({ selectedType, detail:'' });
  },
  chooseReason(e) {
    this.setData({ detail: e.currentTarget.dataset.reason });
  },
  setDetail(e) { this.setData({ detail: e.detail.value }); },
  submit() {
    if (this.data.existing) return wx.showToast({ title: '该订单已有处理中的售后', icon:'none' });
    if (!this.data.detail.trim() || this.data.submitting) return wx.showToast({ title: '请描述具体问题', icon: 'none' });
    this.setData({ submitting: true });
    request('/api/after-sales', {
      method: 'POST',
      data: { userId: userId(), orderId: this.data.orderId, type: this.data.selectedType.key, reason: this.data.detail.trim() }
    }).then(({ data }) => wx.showModal({
      title: '已提交',
      content: `预计${formatDate(data.responseDueAt) || '24 小时内'}前响应。`,
      showCancel: false,
      success: () => wx.navigateBack()
    })).catch((error) => {
      this.setData({ submitting:false });
      wx.showToast({ title: error.message || '提交失败', icon:'none' });
    });
  }
});
