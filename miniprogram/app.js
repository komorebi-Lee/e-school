App({
  globalData: {
    brand: "狮山智生活",
    school: "华中农业大学",
    campus: "狮山校区",
    customerService: "15527111396"
  },
  onLaunch() {
    if (!wx.getStorageSync("campusGoOrders")) {
      wx.setStorageSync("campusGoOrders", []);
    }
  }
});
