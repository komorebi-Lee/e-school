const { getScooters } = require("../../services/store");
Page({
  data: { school: "华中农业大学", campus: "狮山校区", scooters: [], phonePlans: [{ name: "校园畅享卡", price: 29, data: "80GB校园流量", badge: "学生专享" }] },
  onShow() { this.setData({ scooters: getScooters().slice(0, 1) }); },
  goCard() { wx.navigateTo({ url: "/pages/card/card" }); },
  goPlate() { wx.navigateTo({ url: "/pages/plate/plate" }); },
  goScooters() { wx.navigateTo({ url: "/pages/scooters/scooters" }); },
  goDetail(e) { wx.navigateTo({ url: `/pages/detail/detail?id=${e.currentTarget.dataset.id}` }); }
});
