const { request } = require('../../services/api');
const loadState = require('../../utils/load-state');

const categoryOptions = [
  { key: '', label: '全部' },
  { key: 'BOOK', label: '二手书' },
  { key: 'DAILY', label: '生活用品' },
  { key: 'ELECTRONICS', label: '数码' },
  { key: 'SPORTS', label: '运动装备' },
  { key: 'OTHER', label: '其他' }
];

function decorateItem(item) {
  return {
    id: item.id,
    title: item.title,
    description: item.description || '',
    categoryText: item.categoryText || '其他',
    conditionText: item.conditionText || '七成新',
    priceText: item.priceText || `¥${Number(item.price || 0).toFixed(2)}`,
    statusText: item.statusText || '在售',
    images: Array.isArray(item.images) ? item.images : [],
    cover: Array.isArray(item.images) && item.images.length ? item.images[0] : '',
    sellerName: item.sellerName || '狮山同学',
    timeText: String(item.createdAt || '').slice(5, 16).replace('T', ' ')
  };
}

Page({
  data: {
    query: '',
    activeCategory: '',
    categoryOptions,
    filtered: [],
    // ★ 三态块（加载中 / 失败 / 无数据）。
    // 改造前失败时 `setData({ items: [], loading: false })` —— 页面会显示
    // 「暂时没有符合条件的闲置」，把「我们没取到」说成了「确实没有」。
    itemsBlock: loadState.initialListBlock()
  },

  onShow() {
    this.loadItems();
  },

  onShareAppMessage() {
    return {
      title: '狮山市集 · 二手好物与校园论坛',
      path: '/pages/market/market'
    };
  },

  /**
   * 加载市集列表。
   *
   * 失败时 `loadBlock` 只写 `error` 文案，**上一次的列表原样保留**。
   *
   * @returns {Promise<void>} 加载（或失败）完成后解析。
   */
  loadItems() {
    return loadState.loadBlock({
      setData: (patch) => this.setData(patch),
      stateKey: 'itemsBlock',
      prev: this.data.itemsBlock,
      loader: () => request('/api/market/items').then(({ data }) => (data || []).map(decorateItem))
    }).then(() => this.applyFilters());
  },

  /** 重新加载：市集列表。 */
  retryItems() {
    return this.loadItems();
  },

  setSearch(event) {
    this.setData({ query: event.detail.value.trim() });
    this.applyFilters();
  },

  setCategory(event) {
    this.setData({ activeCategory: event.currentTarget.dataset.key || '' });
    this.applyFilters();
  },

  applyFilters() {
    const items = this.data.itemsBlock.data || [];
    const { query, activeCategory } = this.data;
    const keyword = String(query || '').toLowerCase();
    const filtered = items.filter((item) => (
      (!activeCategory || item.categoryText === (categoryOptions.find((option) => option.key === activeCategory) || {}).label)
      && `${item.title} ${item.description} ${item.categoryText}`.toLowerCase().includes(keyword)
    ));
    this.setData({ filtered });
  },

  goItem(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/market/item?id=${encodeURIComponent(id)}` });
  },

  goPublish() {
    wx.navigateTo({ url: '/pages/market/publish' });
  },

  goForum() {
    wx.navigateTo({ url: '/pages/forum/forum' });
  }
});
