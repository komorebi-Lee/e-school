const { request } = require('../../services/api');

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
    items: [],
    filtered: [],
    loading: true
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

  loadItems() {
    request('/api/market/items').then(({ data }) => {
      this.setData({ items: (data || []).map(decorateItem), loading: false });
      this.applyFilters();
    }).catch(() => {
      this.setData({ items: [], loading: false });
      this.applyFilters();
    });
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
    const { items, query, activeCategory } = this.data;
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
