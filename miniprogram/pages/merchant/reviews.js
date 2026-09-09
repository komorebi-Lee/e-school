const { request: apiRequest } = require('../../services/api');

function decorateReview(review) {
  const dueAt = review.replyDueAt ? new Date(review.replyDueAt) : null;
  const overdue = !review.reply && dueAt && Number.isFinite(dueAt.getTime()) && dueAt.getTime() < Date.now();
  return {
    ...review,
    dueText: dueAt && Number.isFinite(dueAt.getTime())
      ? `回复截止 ${dueAt.getMonth() + 1}/${dueAt.getDate()} ${String(dueAt.getHours()).padStart(2, '0')}:${String(dueAt.getMinutes()).padStart(2, '0')}`
      : '',
    overdue
  };
}

Page({
  data: { reviews: [], loading: true, replying: '', focusId: '' },
  onLoad(options = {}) {
    if (options.focusId) this.focusId = options.focusId;
  },
  onShow() { this.load(); },
  request(path, options = {}) {
    const token = wx.getStorageSync('campusGoMerchantToken');
    return apiRequest(path, { ...options, header: { authorization: `Bearer ${token}` } });
  },
  load() {
    this.request('/api/merchant/overview').then(({ data }) => {
      const reviews = (data.reviews || []).map((review) => ({
        ...review,
        ...decorateReview(review),
        dateText: String(review.createdAt || '').slice(5, 16).replace('T', ' '),
        stars: '★★★★★'.slice(0, Math.max(0, Math.min(5, Number(review.rating) || 0))),
        replied: Boolean(review.reply)
      }));
      this.setData({ reviews, pendingReviewCount: reviews.filter((review) => !review.replied).length, loading: false });
      this.focusLoadedItem('merchant-review', reviews);
    }).catch(() => {
      this.setData({ pendingReviewCount: 0, loading: false });
      wx.showToast({ title: '请重新进入商家工作台', icon: 'none' });
    });
  },
  focusLoadedItem(prefix, items) {
    const focusId = this.focusId;
    if (!focusId || !(items || []).some((item) => item.id === focusId)) return;
    this.setData({ focusId });
    wx.nextTick(() => {
      wx.pageScrollTo({ selector: `#${prefix}-${focusId}`, offsetTop: 80, duration: 300 });
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
