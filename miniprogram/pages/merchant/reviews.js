const { request: apiRequest } = require('../../services/api');

Page({
  data: { reviews: [], loading: true, replying: '' },
  onShow() { this.load(); },
  request(path, options = {}) {
    const token = wx.getStorageSync('campusGoMerchantToken');
    return apiRequest(path, { ...options, header: { authorization: `Bearer ${token}` } });
  },
  load() {
    this.request('/api/merchant/overview').then(({ data }) => {
      const reviews = (data.reviews || []).map((review) => ({
        ...review,
        dateText: String(review.createdAt || '').slice(5, 16).replace('T', ' '),
        stars: '★★★★★'.slice(0, Math.max(0, Math.min(5, Number(review.rating) || 0))),
        replied: Boolean(review.reply)
      }));
      this.setData({ reviews, loading: false });
    }).catch(() => {
      this.setData({ loading: false });
      wx.showToast({ title: '请重新进入商家工作台', icon: 'none' });
    });
  },
  reply(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || this.data.replying) return;
    wx.showModal({
      title: '回复校园同学',
      editable: true,
      placeholderText: '感谢反馈，请说明处理安排或改进措施',
      success: ({ confirm, content }) => {
        if (!confirm) return;
        const text = (content || '').trim();
        if (!text) return wx.showToast({ title: '请填写回复内容', icon: 'none' });
        this.setData({ replying: id });
        this.request(`/api/merchant/product-reviews/${encodeURIComponent(id)}/reply`, {
          method: 'POST',
          data: { content: text }
        }).then(() => {
          wx.showToast({ title: '回复已发布', icon: 'success' });
          this.load();
        }).catch((error) => wx.showToast({ title: error.message || '回复失败', icon: 'none' })).finally(() => this.setData({ replying: '' }));
      }
    });
  }
});
