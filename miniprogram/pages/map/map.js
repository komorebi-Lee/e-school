const campusMap = require("../../data/campus-map");

function filterZones(category) {
  if (category === "all") return campusZones;
  if (category === "food" || category === "service") {
    return campusZones.filter((zone) => ["southeast", "northeast"].includes(zone.id));
  }
  if (category === "teaching") return campusZones.filter((zone) => zone.id === "center");
  if (category === "sports") return campusZones.filter((zone) => zone.id === "south");
  if (category === "medical") return campusZones.filter((zone) => zone.id === "north");
  return [];
}

Page({
  data: {
    school: "华中农业大学",
    campus: "狮山校区",
    mode: "2d",
    imageMode: "q",
    keyword: "",
    category: "all",
    categories: campusMap.categories,
    visibleSpots: campusMap.spots,
    visibleZones: campusMap.campusZones,
    routeStart: null,
    routeSummary: null,
    activeSpot: null,
    sourceNote: "点位来自华中农业大学校园地图服务系统。Q 版建筑与实拍图可切换，步行距离为路线估算。"
  },
  setMode(event) {
    this.setData({ mode: event.currentTarget.dataset.mode });
  },
  onSearchInput(event) {
    this.applyFilters(event.detail.value, this.data.category);
  },
  setCategory(event) {
    const category = event.currentTarget.dataset.category;
    this.applyFilters(this.data.keyword, category);
  },
  applyFilters(keyword, category) {
    const query = String(keyword || "").trim().toLowerCase().replace(/\s+/g, "");
    const visibleSpots = campusMap
      .searchSpots(query)
      .filter((spot) => category === "all" || spot.category === category);
    this.setData({ keyword, category, visibleSpots });
  },
  selectSpot(event) {
    const activeSpot = campusMap.spots.find((spot) => spot.id === event.currentTarget.dataset.id);
    this.setData({ activeSpot });
  },
  startRoute() {
    const { activeSpot, routeStart } = this.data;
    if (!activeSpot) {
      wx.showToast({ title: "请先选一个点位", icon: "none" });
      return;
    }
    if (!routeStart) {
      this.setData({ routeStart: activeSpot, routeSummary: null });
      wx.showToast({ title: "起点已设置", icon: "success" });
      return;
    }
    if (routeStart.id === activeSpot.id) {
      this.setData({ routeStart: null, routeSummary: null });
      wx.showToast({ title: "已重置路线", icon: "none" });
      return;
    }
    const routeSummary = campusMap.getRouteSummary(routeStart, activeSpot);
    this.setData({ routeSummary });
  },
  clearRoute() {
    this.setData({ routeStart: null, routeSummary: null });
  },
  toggleImageMode() {
    this.setData({ imageMode: this.data.imageMode === "q" ? "real" : "q" });
  },
  closeDetail() {
    this.setData({ activeSpot: null });
  },
  keepDetail() {},
  openOfficialMap() {
    wx.setClipboardData({
      data: campusMap.OFFICIAL_MAP_URL,
      success: () => wx.showToast({ title: "官方地图链接已复制", icon: "success" })
    });
  },
  getLocation() {
    wx.getLocation({
      type: "gcj02",
      success: (result) => {
        wx.showModal({
          title: "当前定位",
          content: `${result.latitude.toFixed(5)}, ${result.longitude.toFixed(5)}`,
          showCancel: false
        });
      },
      fail: () => wx.showToast({ title: "定位不可用，请手动选点位", icon: "none" })
    });
  },
  goToolbox(event) {
    const url = event.currentTarget.dataset.url;
    if (url) wx.navigateTo({ url });
  },
  onShareAppMessage() {
    return {
      title: "华中农业大学新生认路地图 · 农大去哪儿",
      path: "/pages/map/map"
    };
  }
});
