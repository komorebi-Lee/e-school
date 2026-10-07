const { request, userId } = require('../../services/api');
const { openLink } = require('../../utils/navigation');
const loadState = require('../../utils/load-state');
const { isNotFoundError } = require('../../utils/request-error');

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
    loading: true,
    // ★ 失败分流的两个标志（T49）。二者互斥，初值都是「都没失败」。
    itemError: '',
    itemNotFound: false
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

  /**
   * 加载闲置详情。
   *
   * ★ 失败分流（T49）：
   *   - **404**（`MARKET_ITEM_NOT_FOUND`）→ `itemNotFound = true`，展示常驻的
   *     「商品不存在或已下架」。重试无意义，故不给重试入口。
   *   - **网络失败 / 5xx** → `itemError` 非空，展示**可重试**的占位，并且**不清空** `item`。
   *
   * 改造前两种情况都走 `setData({ item: null })` + toast「商品不存在或已下架」：
   * 网络抖动会让用户以为东西被别人买走了（同时把**旧数据清掉**，本来还能看）。
   */
  loadItem() {
    return request(`/api/market/items/${encodeURIComponent(this.data.id)}`).then(({ data }) => {
      this.setData({
        item: this.decorate(data),
        isOwner: data.isOwner === true,
        statusActions: data.isOwner === true ? statusActions : [],
        loading: false,
        itemError: '',
        itemNotFound: false
      });
    }).catch((error) => {
      if (isNotFoundError(error)) {
        this.setData({ loading: false, itemNotFound: true, itemError: '' });
        return;
      }
      this.setData({ loading: false, itemError: loadState.blockErrorText(error) });
    });
  },

  retryItem() { return this.loadItem(); },

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
