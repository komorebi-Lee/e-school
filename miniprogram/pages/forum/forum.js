const { request } = require('../../services/api');
const { openLink } = require('../../utils/navigation');
const loadState = require('../../utils/load-state');

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
    filtered: [],
    // ★ 三态块（加载中 / 失败 / 无数据）。
    // 改造前失败时 `setData({ posts: [], loading: false })` —— 页面会显示
    // 「这个板块还没有帖子」。**那是在向用户断言一个假事实**：事实是「我们没取到」，
    // 不是「确实没有」。误导比沉默更糟，所以失败必须自己成为一种可见状态。
    postsBlock: loadState.initialListBlock()
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

  /**
   * 加载帖子列表。
   *
   * 失败时 `loadBlock` 只写 `error` 文案，**上一次的列表原样保留**，
   * 用户既看得到旧内容，也看得到「加载失败 + 重试」。
   *
   * @returns {Promise<void>} 加载（或失败）完成后解析。
   */
  loadPosts() {
    return loadState.loadBlock({
      setData: (patch) => this.setData(patch),
      stateKey: 'postsBlock',
      prev: this.data.postsBlock,
      loader: () => request('/api/forum/posts').then(({ data }) => (data || []).map(decoratePost))
    }).then(() => this.applyFilters());
  },

  /** 重新加载：帖子列表。 */
  retryPosts() {
    return this.loadPosts();
  },

  setBoard(event) {
    this.setData({ activeBoard: event.currentTarget.dataset.key || '' });
    this.applyFilters();
  },

  applyFilters() {
    const posts = this.data.postsBlock.data || [];
    const { activeBoard } = this.data;
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
    // 市集当前不是 tabBar 页，openLink 会走 navigateTo；
    // 待市集提为 tabBar 页后 openLink 自动改走 switchTab，避免此处静默失效。
    openLink('/pages/market/market');
  }
});
