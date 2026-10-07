const { request } = require('../../services/api');
const loadState = require('../../utils/load-state');
const { isNotFoundError } = require('../../utils/request-error');

Page({
  data: {
    id: '',
    post: null,
    comment: '',
    submitting: false,
    liking: false,
    // 作者自管理（M7-P1-01）：隐藏 / 恢复进行中，用于禁用按钮防重复提交。
    togglingStatus: false,
    loading: true,
    // ★ 失败分流的两个标志（T49）。二者互斥，初值都是「都没失败」。
    postError: '',
    postNotFound: false
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

  /**
   * 加载帖子详情。
   *
   * ★ 失败分流（T49）：
   *   - **404**（`FORUM_POST_NOT_FOUND`）→ `postNotFound = true`，展示常驻的
   *     「帖子不存在或已隐藏」。重试无意义，故不给重试入口。
   *   - **网络失败 / 5xx** → `postError` 非空，展示**可重试**的占位，并且**不清空** `post`。
   *
   * 改造前两种情况都走 `setData({ post: null })` + toast「帖子不存在或已隐藏」：
   * 网络抖动会让**作者本人**以为自己的帖子被删或被隐藏了。
   */
  loadPost() {
    return request(`/api/forum/posts/${encodeURIComponent(this.data.id)}`).then(({ data }) => {
      this.setData({ post: this.decorate(data), loading: false, postError: '', postNotFound: false });
    }).catch((error) => {
      if (isNotFoundError(error)) {
        this.setData({ loading: false, postNotFound: true, postError: '' });
        return;
      }
      this.setData({ loading: false, postError: loadState.blockErrorText(error) });
    });
  },

  retryPost() { return this.loadPost(); },

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

  /**
   * 隐藏 / 恢复自己的帖子（M7-P1-01）。
   *
   * 按钮只在 `post.isOwner` 为真时渲染，但**真正的防线在服务端** ——
   * 状态端点会独立校验作者，非作者拿 403。这里的开关只是界面。
   *
   * @returns {void}
   */
  toggleVisibility() {
    const post = this.data.post;
    if (!post || this.data.togglingStatus) return;
    // 状态词汇与服务端一致：`PUBLISHED`（可见）/ `HIDDEN`（已隐藏）。
    const nextStatus = post.status === 'HIDDEN' ? 'PUBLISHED' : 'HIDDEN';
    this.setData({ togglingStatus: true });
    request(`/api/forum/posts/${encodeURIComponent(this.data.id)}/status`, {
      method: 'POST',
      data: { status: nextStatus }
    }).then(() => {
      this.setData({ togglingStatus: false });
      wx.showToast({ title: nextStatus === 'HIDDEN' ? '帖子已隐藏' : '帖子已恢复', icon: 'success' });
      // 重新拉取而不是本地改 `status`：隐藏后服务端还会更新 `updatedAt` 并写审计，
      // 本地改会让页面与库里的实际状态漂移。
      this.loadPost();
    }).catch((error) => {
      this.setData({ togglingStatus: false });
      wx.showToast({ title: error.message || '操作失败', icon: 'none' });
    });
  },

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
