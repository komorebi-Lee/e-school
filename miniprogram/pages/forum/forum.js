const { request } = require('../../services/api');

const boardOptions = [
  { key: '', label: '全部' },
  { key: 'CAMPUS', label: '校园生活' },
  { key: 'SECONDHAND', label: '二手交流' },
  { key: 'LOST_FOUND', label: '失物招领' },
  { key: 'STUDY', label: '学习互助' },
  { key: 'RIDES', label: '拼车顺风' }
];

function decoratePost(post) {
  return {
    id: post.id,
    title: post.title,
    content: post.content || '',
    boardText: post.boardText || '校园生活',
    authorName: post.authorName || '狮山同学',
    likes: Number(post.likes || 0),
    commentCount: Number(post.commentCount || 0),
    timeText: String(post.createdAt || '').slice(5, 16).replace('T', ' ')
  };
}

Page({
  data: {
    boardOptions,
    activeBoard: '',
    posts: [],
    filtered: [],
    loading: true
  },

  onShow() {
    this.loadPosts();
  },

  onShareAppMessage() {
    return {
      title: '狮山论坛 · 校园生活与互助',
      path: '/pages/forum/forum'
    };
  },

  loadPosts() {
    request('/api/forum/posts').then(({ data }) => {
      this.setData({ posts: (data || []).map(decoratePost), loading: false });
      this.applyFilters();
    }).catch(() => {
      this.setData({ posts: [], loading: false });
      this.applyFilters();
    });
  },

  setBoard(event) {
    this.setData({ activeBoard: event.currentTarget.dataset.key || '' });
    this.applyFilters();
  },

  applyFilters() {
    const { posts, activeBoard } = this.data;
    const filtered = activeBoard
      ? posts.filter((post) => post.boardText === (boardOptions.find((option) => option.key === activeBoard) || {}).label)
      : posts;
    this.setData({ filtered });
  },

  goPost(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/forum/post?id=${encodeURIComponent(id)}` });
  },

  goPublish() {
    wx.navigateTo({ url: '/pages/forum/publish' });
  },

  goMarket() {
    wx.navigateTo({ url: '/pages/market/market' });
  }
});
