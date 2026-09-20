const { getScooters } = require("../../services/store");
const { loadBusinessConfig } = require("../../services/business");
const { request } = require("../../services/api");
const { openLink } = require("../../utils/navigation");

function displayPrice(product) {
  return Math.round(Number(product.effectivePriceInCents ?? (product.priceInCents || 0)) / 100);
}

function normalizePhonePlan(item) {
  return {
    name: item.name,
    price: displayPrice(item),
    data: item.description || '校园专属资费',
    badge: item.stock > 0 ? '可办理' : '已售罄'
  };
}

Page({
  data: {
    school: "华中农业大学",
    campus: "狮山校区",
    scooters: [],
    phonePlans: [],
    scootersLoading: true,
    phonePlansLoading: true,
    // 价格一律来自服务端。加载失败时保持 null，绝不展示编造数字（曾硬编码 1899 / 19，
    // 而真实最低价是 2399 / 29，会向用户展示一个并不存在的更低价）。
    scooterFromPrice: null,
    phoneFromPrice: null,
    catalogError: false,
    favorites: [],
    recommendations: [],
    searchKeyword: '',
    config: null,
    responseHours: 24
  },
  onShow() {
    this.setData({ scooters: getScooters().slice(0, 1) });
    this.loadFavorites();
    this.loadRecommendations();
    loadBusinessConfig().then((config) => this.setData({
      config,
      school: config.schoolName,
      campus: config.campusName,
      responseHours: Number(config.leadResponseHours || 24)
    }));
    this.loadCatalog();
  },
  loadCatalog() {
    this.setData({ scootersLoading: true, phonePlansLoading: true, catalogError: false });
    return request('/api/products').then(({ data }) => {
      const scooters = (data || []).filter((item) => item.category === 'E_BIKE_NEW' && item.active !== false).map((item) => ({
        ...item,
        price: displayPrice(item),
        originalPrice: item.promotion?.originalPriceInCents
          ? Math.round(Number(item.promotion.originalPriceInCents) / 100) : 0,
        promoText: item.promotion?.statusText || '',
        subtitle: item.description,
        color: '#eaf0ff',
        icon: '车'
      }));
      const phonePlans = (data || []).filter((item) => item.category === 'PHONE_PLAN' && item.active !== false).map(normalizePhonePlan);
      this.setData({
        scooters: scooters.slice(0, 1),
        phonePlans: phonePlans.slice(0, 3),
        // 接口成功但无数据时同样不编造价格，置 null 交由模板提示「暂无报价」
        scooterFromPrice: scooters.length ? Math.min(...scooters.map(displayPrice)) : null,
        phoneFromPrice: phonePlans.length ? Math.min(...phonePlans.map((item) => item.price)) : null,
        scootersLoading: false,
        phonePlansLoading: false
      });
    }).catch(() => this.setData({
      // 加载失败时不展示任何价格，交由模板给出重试入口
      scooterFromPrice: null,
      phoneFromPrice: null,
      catalogError: true,
      scootersLoading: false,
      phonePlansLoading: false
    }));
  },
  reloadCatalog() { this.loadCatalog(); },
  onShareAppMessage() {
    return {
      title: "狮山智生活 · 买车办卡办上牌，校内一次办好",
      path: "/pages/home/home"
    };
  },
  onShareTimeline() {
    return { title: "狮山智生活 · 买车办卡办上牌，校内一次办好" };
  },
  goCard(e) {
    const planId = e?.currentTarget?.dataset?.id;
    wx.navigateTo({ url: planId ? `/pages/card/card?planId=${encodeURIComponent(planId)}` : "/pages/card/card" });
  },
  setSearchKeyword(event) { this.setData({ searchKeyword: event.detail.value }); },
  goSearch() {
    const keyword = String(this.data.searchKeyword || '').trim();
    wx.navigateTo({ url: `/pages/search/search?query=${encodeURIComponent(keyword)}` });
  },
  goView(event) {
    const view = event?.currentTarget?.dataset?.view;
    if (view === 'plate') return this.goPlate();
  },
  goMap() { openLink("/pages/map/map"); },
  goPlate() { wx.navigateTo({ url: "/pages/plate/plate" }); },
  goMarket() { wx.navigateTo({ url: "/pages/market/market" }); },
  goScooters() { wx.navigateTo({ url: "/pages/scooters/scooters" }); },
  loadFavorites() {
    request('/api/my/favorites').then(({ data }) => {
      const favorites = (data || []).map((item) => {
        const stock = Number(item.availableStock ?? (item.stock || 0));
        return {
          id: item.id,
          name: item.name,
          merchantName: item.merchantName || '平台自营',
          stockText: stock > 0 ? (stock < 5 ? `仅剩 ${stock} 件` : `库存 ${stock}`) : '已售罄',
          price: (Number(item.effectivePriceInCents ?? (item.priceInCents || 0)) / 100).toFixed(2),
          originalPrice: item.promotion?.originalPriceInCents
            ? (Number(item.promotion.originalPriceInCents) / 100).toFixed(2) : '',
          promoText: item.promotion?.statusText || ''
        };
      });
      this.setData({ favorites });
    }).catch(() => this.setData({ favorites: [] }));
  },
  loadRecommendations() {
    request('/api/my/recommendations?limit=4').then(({ data }) => {
      const recommendations = (data || []).map((item) => {
        const stock = Number(item.availableStock ?? (item.stock || 0));
        return {
          id: item.id,
          categoryLabel: item.category === 'PHONE_PLAN' ? '电话卡' : '电动车',
          name: item.name,
          merchantName: item.merchantName || '平台自营',
          stockText: stock > 0 ? (stock < 5 ? `仅剩 ${stock} 件` : `库存 ${stock}`) : '已售罄',
          price: (Number(item.effectivePriceInCents ?? (item.priceInCents || 0)) / 100).toFixed(2),
          originalPrice: item.promotion?.originalPriceInCents
            ? (Number(item.promotion.originalPriceInCents) / 100).toFixed(2) : '',
          promoText: item.promotion?.statusText || ''
        };
      });
      this.setData({ recommendations });
    }).catch(() => this.setData({ recommendations: [] }));
  },
  goFavorites() { wx.navigateTo({ url: "/pages/favorites/favorites" }); },
  goDetail(e) { wx.navigateTo({ url: `/pages/detail/detail?id=${e.currentTarget.dataset.id}` }); }
});
