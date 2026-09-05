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

function uploadAfterSaleImage(file) {
  const extension = file.tempFilePath.split('.').pop().toLowerCase();
  const mimeType = extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : 'image/jpeg';
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath: file.tempFilePath,
      encoding: 'base64',
      success: ({ data }) => resolve(data),
      fail: () => reject(new Error('图片读取失败'))
    });
  }).then((dataBase64) => request('/api/uploads', {
    method: 'POST',
    data: { dataBase64, mimeType }
  }).then(({ data }) => data.url));
}

Page({
  data: {
    orderId: '', order: null, existing: null, typeOptions, selectedType: typeOptions[0], images: [],
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
          dueText: formatDate(existing.responseDueAt),
          images: existing.images || [],
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
  chooseImage() {
    const limit = this.data.existing ? Math.max(0, 9 - this.data.existing.images.length) : 3;
    if (!limit) return wx.showToast({ title: '图片数量已达上限', icon: 'none' });
    wx.chooseMedia({
      count: limit,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: ({ tempFiles }) => {
        if (!tempFiles?.length) return;
        wx.showLoading({ title: '上传中', mask: true });
        Promise.all(tempFiles.map(file => uploadAfterSaleImage(file))).then((urls) => {
          wx.hideLoading();
          if (this.data.existing) {
            return request(`/api/after-sales/${encodeURIComponent(this.data.existing.id)}/materials`, {
              method: 'POST',
              data: { images: urls }
            }).then(() => {
              wx.showToast({ title: '图片已补充', icon: 'success' });
              return this.loadContext();
            });
          }
          this.setData({ images: [...this.data.images, ...urls].slice(0, 3) });
        }).catch((error) => {
          wx.hideLoading();
          wx.showToast({ title: error.message || '图片上传失败', icon: 'none' });
        });
      }
    });
  },
  removeImage(e) {
    const index = Number(e.currentTarget.dataset.index);
    const images = [...this.data.images];
    images.splice(index, 1);
    this.setData({ images });
  },
  submit() {
    if (this.data.existing) return wx.showToast({ title: '该订单已有处理中的售后', icon:'none' });
    if (!this.data.detail.trim() || this.data.submitting) return wx.showToast({ title: '请描述具体问题', icon: 'none' });
    this.setData({ submitting: true });
    request('/api/after-sales', {
      method: 'POST',
      data: { userId: userId(), orderId: this.data.orderId, type: this.data.selectedType.key, reason: this.data.detail.trim(), images: this.data.images }
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
