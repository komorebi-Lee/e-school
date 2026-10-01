const { request } = require('../../services/api');
const { openLink } = require('../../utils/navigation');
const loadState = require('../../utils/load-state');

/**
 * 把服务端返回的帖子映射成列表要用的形状。
 *
 * `hidden` 与 `statusText` 是本页特有的：`?mine=1` 会**连隐藏的帖子一起返回**
 * （这是「恢复」唯一的入口），所以列表必须能看出哪一条当前是隐藏的。
 *
 * @param {object} post 服务端返回的帖子。
 * @returns {object} 列表项。
 */
function decoratePost(post) {
  const hidden = post.status === 'HIDDEN';
  return {
    id: post.id,
    title: post.title,
    content: post.content || '',
    boardText: post.boardText || '校园生活',
    likes: Number(post.likes || 0),
    commentCount: Number(post.commentCount || 0),
    timeText: String(post.createdAt || '').slice(5, 16).replace('T', ' '),
    hidden,
    statusText: hidden ? '已隐藏' : '已发布'
  };
}

Page({
  // ★ 三态块（加载中 / 失败 / 无数据）。
  // 「我发的帖子」最怕的是**失败被说成空**：接口挂掉时如果显示「你还没有发过帖子」，
  // 那是在向用户断言一个假事实 —— 他会以为自己发的帖子被删了。
  // 所以失败必须自己成为一种可见状态（常驻占位 + 重试入口），而不是一闪而过的 toast。
  data: { postsBlock: loadState.initialListBlock() },

  onShow() {
    this.loadMine();
  },

  /**
   * 加载「我发的帖子」（含隐藏的）。
   *
   * 失败时 `loadBlock` 只写 `error` 文案，**上一次的列表原样保留**。
   *
   * @returns {Promise<void>} 加载（或失败）完成后解析。
   */
  loadMine() {
    return loadState.loadBlock({
      setData: (patch) => this.setData(patch),
      stateKey: 'postsBlock',
      prev: this.data.postsBlock,
      loader: () => request('/api/forum/posts?mine=1').then(({ data }) => (data || []).map(decoratePost))
    });
  },

  /** 重新加载：我发的帖子。 */
  retryPosts() {
    return this.loadMine();
  },

  /** 打开帖子详情：隐藏的帖子作者自己也能打开，进去就有「恢复」按钮。 */
  goPost(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    openLink(`/pages/forum/post?id=${encodeURIComponent(id)}`);
  },

  /** 去发新帖。 */
  goPublish() {
    openLink('/pages/forum/publish');
  }
});
