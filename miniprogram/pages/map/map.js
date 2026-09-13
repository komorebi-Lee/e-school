const { categories, pois } = require("../../data/pois");

// 狮山校区中心（GCJ-02 近似值，用于未授权定位时的地图初始位置）
const CAMPUS_CENTER = { latitude: 30.469, longitude: 114.3546 };

// 界桩：地图可拖动范围限制在学校周边约 5km，超出自动弹回校园中心
const BOUNDS = { minLat: 30.425, maxLat: 30.52, minLng: 114.3, maxLng: 114.412 };

// 小程序 map 组件只认 iconPath 图片：低层级用小贴纸防遮挡，高层级放大 Q 版贴纸
const STICKER_BASE = "/assets/map/sprite-";
const STICKER_EXT = ".webp";
const ZOOM_STICKER_THRESHOLD = 15;
const OFFICIAL_MAP_URL = "http://gis.hzau.edu.cn";

function haversine(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLng = (b.longitude - a.longitude) * rad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function formatDistance(meters) {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters)} m`;
}

function markerSize(zoom) {
  if (zoom < ZOOM_STICKER_THRESHOLD) return { width: 20, height: 20 };
  const size = 34 + Math.min(44, (zoom - ZOOM_STICKER_THRESHOLD) * 11);
  return { width: Math.round(size), height: Math.round(size) };
}

function sizeKey(size) {
  return `${size.width}x${size.height}`;
}

function imageMode(path) {
  return path.endsWith(".webp") ? "aspectFit" : "widthFix";
}

function toMarker(poi, index, zoom) {
  const size = markerSize(zoom);
  return {
    id: index,
    latitude: poi.lat,
    longitude: poi.lng,
    title: poi.name,
    iconPath: `${STICKER_BASE}${poi.id}${STICKER_EXT}`,
    width: size.width,
    height: size.height,
    anchor: { x: 0.5, y: 1 },
    callout: {
      content: poi.name,
      display: "BYCLICK",
      bgColor: "#002FA7",
      color: "#ffffff",
      padding: 8,
      borderRadius: 6,
      fontSize: 12,
      borderWidth: 1,
      borderColor: "#ffffff"
    }
  };
}

// 分类默认 Q 版头图（详情卡顶部）；重点建筑的专属图可按 id 覆盖，如 "401": "/assets/map/b401.jpg"
const CAT_IMAGES = {
  校门: "/assets/map/cat-gate.jpg"
};

Page({
  data: {
    center: CAMPUS_CENTER,
    scale: 16,
    categories,
    activeCategory: "全部",
    keyword: "",
    markers: [],
    selected: null,
    route: null,
    userLocation: null,
    locateFailed: false
  },

  onLoad() {
    this.locate();
    this.refresh();
  },

  onUnload() {
    clearTimeout(this.searchTimer);
  },

  locate() {
    wx.getLocation({
      type: "gcj02",
      success: (result) => {
        this.setData({
          userLocation: { latitude: result.latitude, longitude: result.longitude },
          locateFailed: false
        });
      },
      fail: () => {
        this.setData({ locateFailed: true });
        wx.showToast({ title: "未授权定位，不显示距离", icon: "none" });
      }
    });
  },

  onRetryLocate() {
    wx.authorize({ scope: "scope.userLocation", complete: () => this.locate() });
  },

  refresh() {
    const { activeCategory, keyword, scale } = this.data;
    const list = pois.filter((poi) => {
      if (poi.lat == null || poi.lng == null) return false;
      if (activeCategory !== "全部" && poi.category !== activeCategory) return false;
      if (keyword) {
        const haystack = (poi.name + poi.desc + poi.address + poi.category).toLowerCase();
        if (!haystack.includes(keyword.toLowerCase())) return false;
      }
      return true;
    });
    this.markerSizeKey = sizeKey(markerSize(scale));
    this.setData({ markers: list.map((poi, index) => toMarker(poi, index, scale)) });
  },

  onCategory(event) {
    clearTimeout(this.searchTimer);
    this.setData({
      activeCategory: event.currentTarget.dataset.cat,
      route: null,
      selected: null
    }, () => this.refresh());
  },

  onSearchInput(event) {
    clearTimeout(this.searchTimer);
    this.setData({ keyword: event.detail.value, route: null, selected: null });
    this.searchTimer = setTimeout(() => this.refresh(), 220);
  },

  onMarkerTap(event) {
    const visible = pois.filter((poi) => poi.lat != null && poi.lng != null);
    const poi = visible[event.detail.markerId];
    if (!poi) return;
    let distance = null;
    if (this.data.userLocation) {
      distance = formatDistance(haversine(this.data.userLocation, {
        latitude: poi.lat,
        longitude: poi.lng
      }));
    }
    const image = CAT_IMAGES[poi.id] ||
      CAT_IMAGES[poi.category] ||
      `${STICKER_BASE}${poi.id}${STICKER_EXT}`;
    this.setData({
      route: null,
      selected: {
        ...poi,
        distance,
        image,
        imageMode: imageMode(image)
      }
    });
  },

  onRegionChange(event) {
    if (!event.detail || event.detail.type !== "end") return;
    if (!this.mapCtx) this.mapCtx = wx.createMapContext("campusMap");
    this.mapCtx.getCenterLocation({
      success: (center) => {
        const outside = center.latitude < BOUNDS.minLat ||
          center.latitude > BOUNDS.maxLat ||
          center.longitude < BOUNDS.minLng ||
          center.longitude > BOUNDS.maxLng;
        if (outside) {
          this.setData({ center: CAMPUS_CENTER });
          wx.showToast({ title: "已回到狮山校区范围", icon: "none" });
        }
      },
      complete: () => {
        this.mapCtx.getScale({
          success: (result) => {
            const nextSizeKey = sizeKey(markerSize(result.scale));
            if (nextSizeKey !== this.markerSizeKey) {
              this.setData({ scale: result.scale }, () => this.refresh());
            }
          }
        });
      }
    });
  },

  closePanel() {
    this.setData({ route: null, selected: null });
  },

  noop() {},

  startRoute() {
    const poi = this.data.selected;
    if (!poi) return;
    const origin = this.data.userLocation || CAMPUS_CENTER;
    const walkMeters = Math.max(80, Math.round(haversine(origin, {
      latitude: poi.lat,
      longitude: poi.lng
    }) * 1.25 / 10) * 10);
    const distanceText = walkMeters >= 1000
      ? `${(walkMeters / 1000).toFixed(1)} km`
      : `${walkMeters} m`;
    this.setData({
      route: {
        distanceText,
        durationText: `步行约 ${Math.max(2, Math.ceil(walkMeters / 75))} 分钟`
      }
    });
  },

  toggleImageMode() {
    const selected = this.data.selected;
    if (!selected) return;
    this.setData({
      selected: {
        ...selected,
        imageMode: selected.imageMode === "aspectFit" ? "widthFix" : "aspectFit"
      }
    });
  },

  openOfficialMap() {
    wx.setClipboardData({
      data: OFFICIAL_MAP_URL,
      success: () => wx.showToast({ title: "官网地图链接已复制", icon: "none" })
    });
  },

  goNavigate() {
    const poi = this.data.selected;
    if (!poi) return;
    wx.openLocation({
      latitude: poi.lat,
      longitude: poi.lng,
      name: poi.name,
      address: poi.address || poi.desc || poi.name,
      scale: 18
    });
  }
});
