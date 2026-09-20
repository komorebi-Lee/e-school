const { request, userId } = require('../../services/api');
const { openLink } = require('../../utils/navigation');

const statusActions = [
  { key: 'RESERVED', label: '标记已预留' },
  { key: 'ACTIVE', label: '重新上架' },
  { key: 'SOLD', label: '标记已出' }
];

Page({
  data: {
    id: '',
    item: null,
    isOwner: false,
    statusActions: [],
    loading: true
  },

  onLoad(options) {
    this.setData({ id: options.id || '' });
  },

  onShow() {
    this.loadItem();
  },

  onShareAppMessage() {
    const item = this.data.item;
    if (!item) return { title: '狮山市集 · 闲置好物', path: '/pages/market/market' };
    return {
      title: `${item.title} · ${item.priceText}`,
      path: `/pages/market/item?id=${encodeURIComponent(item.id)}`
    };
  },

  loadItem() {
    request(`/api/market/items/${encodeURIComponent(this.data.id)}`).then(({ data }) => {
      this.setData({
        item: this.decorate(data),
        isOwner: data.isOwner === true,
        statusActions: data.isOwner === true ? statusActions : [],
        loading: false
      });
    }).catch(() => {
      this.setData({ item: null, loading: false });
      wx.showToast({ title: '商品不存在或已下架', icon: 'none' });
    });
  },

  decorate(item) {
    return {
      ...item,
      timeText: String(item.createdAt || '').slice(0, 10),
      images: Array.isArray(item.images) ? item.images : []
    };
  },

  previewImages(event) {
    const urls = event.currentTarget.dataset.urls || this.data.item.images;
    const current = event.currentTarget.dataset.url;
    if (!Array.isArray(urls) || !urls.length) return;
    wx.previewImage({ current: current || urls[0], urls });
  },

  setStatus(event) {
    const status = event.currentTarget.dataset.status;
    if (!status || this.data.submitting) return;
    this.setData({ submitting: true });
    request(`/api/market/items/${encodeURIComponent(this.data.id)}`, {
      method: 'POST',
      data: { status }
    }).then(() => {
      this.setData({ submitting: false });
      wx.showToast({ title: '状态已更新', icon: 'success' });
      this.loadItem();
    }).catch((error) => {
      this.setData({ submitting: false });
      wx.showToast({ title: error.message || '更新失败', icon: 'none' });
    });
  },

  copyContact() {
    const contact = this.data.item?.contact;
    if (!contact) return;
    wx.setClipboardData({ data: contact, success: () => wx.showToast({ title: '联系方式已复制', icon: 'none' }) });
  },

  goMarket() {
    // 正常情况下应返回上一页；仅当没有上一页（直接进入详情）时才兜底跳市集。
    wx.navigateBack({ fail: () => openLink('/pages/market/market') });
  }
});
