const { request } = require('../../services/api');

Page({
  data: {
    id: '',
    post: null,
    comment: '',
    submitting: false,
    liking: false,
    loading: true
  },

  onLoad(options) {
    this.setData({ id: options.id || '' });
  },

  onShow() {
    this.loadPost();
  },

  onShareAppMessage() {
    const post = this.data.post;
    if (!post) return { title: '狮山论坛', path: '/pages/forum/forum' };
    return {
      title: `${post.title} · 狮山论坛`,
      path: `/pages/forum/post?id=${encodeURIComponent(post.id)}`
    };
  },

  loadPost() {
    request(`/api/forum/posts/${encodeURIComponent(this.data.id)}`).then(({ data }) => {
      this.setData({ post: this.decorate(data), loading: false });
    }).catch(() => {
      this.setData({ post: null, loading: false });
      wx.showToast({ title: '帖子不存在或已隐藏', icon: 'none' });
    });
  },

  decorate(post) {
    return {
      ...post,
      images: Array.isArray(post.images) ? post.images : [],
      comments: Array.isArray(post.comments) ? post.comments : []
    };
  },

  toggleLike() {
    if (this.data.liking) return;
    this.setData({ liking: true });
    request(`/api/forum/posts/${encodeURIComponent(this.data.id)}/like`, { method: 'POST' }).then(({ data }) => {
      this.setData({ liking: false });
      const post = this.data.post;
      if (post) this.setData({ post: { ...post, likes: data.likes, liked: data.liked } });
    }).catch((error) => {
      this.setData({ liking: false });
      wx.showToast({ title: error.message || '操作失败', icon: 'none' });
    });
  },

  setComment(event) { this.setData({ comment: event.detail.value }); },

  submitComment() {
    const { comment, submitting } = this.data;
    if (submitting) return;
    if (!comment.trim()) return wx.showToast({ title: '请填写评论内容', icon: 'none' });
    this.setData({ submitting: true });
    request(`/api/forum/posts/${encodeURIComponent(this.data.id)}/comments`, {
      method: 'POST',
      data: { content: comment.trim() }
    }).then(() => {
      this.setData({ submitting: false, comment: '' });
      wx.showToast({ title: '评论已发布', icon: 'success' });
      this.loadPost();
    }).catch((error) => {
      this.setData({ submitting: false });
      wx.showToast({ title: error.message || '评论发布失败', icon: 'none' });
    });
  },

  previewImages(event) {
    const urls = event.currentTarget.dataset.urls || this.data.post.images;
    const current = event.currentTarget.dataset.url;
    if (!Array.isArray(urls) || !urls.length) return;
    wx.previewImage({ current: current || urls[0], urls });
  },

  goForum() {
    wx.navigateBack({ fail: () => wx.navigateTo({ url: '/pages/forum/forum' }) });
  }
});
