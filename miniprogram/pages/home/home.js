const { getScooters } = require("../../services/store");
const { loadBusinessConfig } = require("../../services/business");

function normalizePhonePlan(item) {
  return {
    name: item.name,
    price: Math.round((item.priceInCents || 0) / 100),
    data: item.description || '校园专属资费',
    badge: item.stock > 0 ? '可办理' : '已售罄'
  };
}

Page({
  data: { school: "华中农业大学", campus: "狮山校区", scooters: [], phonePlans: [], config: null },
  onShow() {
    this.setData({ scooters: getScooters().slice(0, 1) });
    const { request } = require("../../services/api");
    loadBusinessConfig().then((config) => this.setData({ config, school: config.schoolName, campus: config.campusName }));
    request('/api/products').then(({ data }) => {
      const scooters = (data || []).filter((item) => item.category === 'E_BIKE_NEW' && item.active !== false).map((item) => ({
        ...item,
        price: Math.round((item.priceInCents || 0) / 100),
        subtitle: item.description,
        color: '#eaf0ff',
        icon: '车'
      }));
      const phonePlans = (data || []).filter((item) => item.category === 'PHONE_PLAN' && item.active !== false).map(normalizePhonePlan);
      this.setData({
        scooters: scooters.slice(0, 1),
        phonePlans: phonePlans.slice(0, 3)
      });
    }).catch(() => {});
  },
  goCard() { wx.navigateTo({ url: "/pages/card/card" }); },
  goPlate() { wx.navigateTo({ url: "/pages/plate/plate" }); },
  goScooters() { wx.navigateTo({ url: "/pages/scooters/scooters" }); },
  goDetail(e) { wx.navigateTo({ url: `/pages/detail/detail?id=${e.currentTarget.dataset.id}` }); }
});
