const { request } = require('../../services/api');

const HISTORY_KEY = 'campusGoSearchHistory';

function loadHistory() {
  try {
    const stored = wx.getStorageSync(HISTORY_KEY);
    return Array.isArray(stored)
      ? stored.filter((item) => typeof item === 'string' && item.trim()).slice(0, 10)
      : [];
  } catch (error) {
    return [];
  }
}

function saveHistory(keywords) {
  try { wx.setStorageSync(HISTORY_KEY, keywords.slice(0, 10)); } catch (error) {}
}

const typeLabels = {
  E_BIKE_NEW: '电瓶车',
  PHONE_PLAN: '电话卡',
  SERVICE: '服务'
};

function decorateProduct(item) {
  const stock = Number(item.availableStock ?? (item.stock || 0));
  return {
    id: item.id,
    name: item.name,
    description: item.description || '',
    imageUrl: item.imageUrl || '',
    icon: item.icon || '',
    color: item.color || '#eaf0ff',
    price: ((Number(item.effectivePriceInCents ?? (item.priceInCents || 0))) / 100).toFixed(2),
    originalPrice: item.promotion?.originalPriceInCents
      ? (Number(item.promotion.originalPriceInCents) / 100).toFixed(2) : '',
    promoText: item.promotion?.statusText || '',
    stockText: stock > 0 ? (stock < 5 ? `仅剩 ${stock} 件` : `库存 ${stock}`) : '已售罄',
    category: item.category || '',
    typeText: typeLabels[item.category] || '校园服务',
    merchantScore: item.merchantScore || null,
    serviceScoreText: item.merchantScore ? `服务分 ${item.merchantScore.score}` : ''
  };
}

function decoratePromo(item) {
  const benefit = Number(item.receive || 0) - Number(item.pay || 0);
  return {
    id: item.id,
    badge: item.badge || '限时权益',
    pay: item.pay,
    receive: item.receive,
    title: `充${item.pay}送${benefit}`,
    description: `到账 ¥${item.receive}`
  };
}

Page({
  data: {
    query: '',
    searchHistory: [],
    hotKeywords: [],
    products: [],
    filteredProducts: [],
    promos: [],
    filteredPromos: [],
    activeTab: 'ALL',
    loading: true
  },

  onLoad(options = {}) {
    const query = decodeURIComponent(options.query || '').trim();
    this.setData({ query, searchHistory: loadHistory() });
    this.loadResults();
  },

  onShareAppMessage() {
    const query = encodeURIComponent(this.data.query || '');
    return {
      title: this.data.query ? `${this.data.query} · 狮山智生活` : '狮山智生活',
      path: `/pages/search/search?query=${query}`
    };
  },

  loadResults() {
    Promise.all([
      request('/api/products').then(({ data }) => (data || []).map(decorateProduct)),
      request('/api/recharge-promos').then(({ data }) => (data || []).map(decoratePromo))
    ]).then(([products, promos]) => {
      const hotKeywords = Array.from(new Set([
        ...products.slice(0, 4).map((item) => item.name).filter(Boolean),
        ...promos.slice(0, 2).map((item) => item.title).filter(Boolean)
      ])).slice(0, 6);
      this.setData({ products, promos, hotKeywords, loading: false });
      this.applyFilters();
    }).catch(() => {
      this.setData({ products: [], promos: [], loading: false });
      this.applyFilters();
    });
  },

  setKeyword(event) {
    this.setData({ query: event.detail.value.trim() });
    this.applyFilters();
  },

  confirmSearch(event) {
    const query = String(event.detail.value || '').trim();
    this.setData({ query });
    this.recordHistory(query);
    this.applyFilters();
  },

  recordHistory(query) {
    if (!query) return;
    const next = [query, ...this.data.searchHistory.filter((item) => item !== query)].slice(0, 10);
    saveHistory(next);
    this.setData({ searchHistory: next });
  },

  tapKeyword(event) {
    const keyword = event.currentTarget.dataset.keyword || '';
    if (!keyword) return;
    this.setData({ query: keyword });
    this.recordHistory(keyword);
    this.applyFilters();
  },

  clearHistory() {
    saveHistory([]);
    this.setData({ searchHistory: [] });
  },

  setTab(event) {
    this.setData({ activeTab: event.currentTarget.dataset.tab || 'ALL' });
    this.applyFilters();
  },

  resetFilters() {
    this.setData({ query: '', activeTab: 'ALL' });
    this.applyFilters();
  },

  goHome() {
    wx.switchTab({ url: '/pages/home/home' });
  },

  applyFilters() {
    const { products, promos, query, activeTab } = this.data;
    const keyword = String(query || '').toLowerCase();
    const filteredProducts = products.filter((item) => (
      (activeTab === 'ALL' || activeTab === item.category)
      && `${item.name} ${item.description} ${item.typeText}`.toLowerCase().includes(keyword)
    ));
    const filteredPromos = activeTab === 'ALL' || activeTab === 'PROMO'
      ? promos.filter((item) => `${item.title} ${item.description}`.toLowerCase().includes(keyword))
      : [];
    this.setData({ filteredProducts, filteredPromos });
  },

  goItem(event) {
    const { kind, id, category } = event.currentTarget.dataset;
    if (!id) return;
    if (kind === 'product') {
      if (category === 'E_BIKE_NEW') {
        return wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(id)}` });
      }
      if (category === 'PHONE_PLAN') {
        return wx.navigateTo({ url: `/pages/card/card?planId=${encodeURIComponent(id)}` });
      }
      return wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(id)}` });
    }
    if (kind === 'promo') {
      return wx.navigateTo({ url: `/pages/card/card?promoId=${encodeURIComponent(id)}` });
    }
  }
});
