const { getScooters } = require("../../services/store");
const { loadBusinessConfig } = require("../../services/business");

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
    config: null,
    responseHours: 24
  },
  onShow() {
    this.setData({ scooters: getScooters().slice(0, 1) });
    const { request } = require("../../services/api");
    loadBusinessConfig().then((config) => this.setData({
      config,
      school: config.schoolName,
      campus: config.campusName,
      responseHours: Number(config.leadResponseHours || 24)
    }));
    request('/api/products').then(({ data }) => {
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
        scooterFromPrice: scooters.length ? Math.min(...scooters.map(displayPrice)) : 1899,
        phoneFromPrice: phonePlans.length ? Math.min(...phonePlans.map((item) => item.price)) : 19,
        scootersLoading: false,
        phonePlansLoading: false
      });
    }).catch(() => this.setData({ scooterFromPrice: 1899, phoneFromPrice: 19, scootersLoading: false, phonePlansLoading: false }));
  },
  goCard() { wx.navigateTo({ url: "/pages/card/card" }); },
  goMap() { wx.navigateTo({ url: "/pages/map/map" }); },
  goPlate() { wx.navigateTo({ url: "/pages/plate/plate" }); },
  goScooters() { wx.navigateTo({ url: "/pages/scooters/scooters" }); },
  goDetail(e) { wx.navigateTo({ url: `/pages/detail/detail?id=${e.currentTarget.dataset.id}` }); }
});
